-- Live 'public' schema of the production project (pg_dump --schema-only).
-- Captured 2026-09-27T00:34:44Z from commit 267775fe371cfd5fe198929c1de1335b764609f2 (run 36282916171).
-- Purpose: PHASED_ROADMAP.md Phase 0 - the before picture later migrations diff against.
-- No rows and no owners; privileges are kept (they are part of the authority surface).

--
-- PostgreSQL database dump
--

\restrict 1SIuhaaATl6YVG0VyhFUFRj3H0GxoZnfKSyxmK6eQpefCbeqJsedsyWRd6tFNl5

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    sku text,
    barcode text,
    category text,
    brand text,
    frame_type text,
    frame_color text,
    cost_price numeric(10,2) DEFAULT 0,
    sale_price numeric(10,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL,
    stock_qty integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.inventory FORCE ROW LEVEL SECURITY;


--
-- Name: add_inventory_item(jsonb, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_inventory_item(p_product jsonb, p_initial_stock integer DEFAULT 0) RETURNS public.inventory
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  v_inv public.inventory;
begin
  insert into public.inventory
    (name, sku, barcode, category, brand, frame_type, frame_color, cost_price, sale_price)
  select r.name, r.sku, r.barcode, r.category, r.brand, r.frame_type, r.frame_color,
         r.cost_price, r.sale_price
    from jsonb_populate_record(null::public.inventory, p_product) r
  returning * into v_inv;

  if coalesce(p_initial_stock, 0) > 0 then
    insert into public.stock_movements (product_id, store_id, qty, type, note)
    values (v_inv.id, v_inv.store_id, p_initial_stock, 'initial', 'Initial stock');
  end if;

  return v_inv;
end $$;


--
-- Name: auth_store_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_store_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select u.store_id
  from public.users u
  where u.id = auth.uid()
     or u.username = split_part(coalesce((select email from auth.users where id = auth.uid()), ''), '@', 1)
  limit 1
$$;


--
-- Name: available_stock(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.available_stock(p_product uuid) RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select coalesce((select i.stock_qty from public.inventory i where i.id = p_product), 0);
$$;


--
-- Name: sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    invoice_no text NOT NULL,
    customer_id uuid,
    user_id uuid,
    total_amount numeric(10,2) DEFAULT 0,
    discount numeric(10,2) DEFAULT 0,
    net_amount numeric(10,2) DEFAULT 0,
    amount_paid numeric(10,2) DEFAULT 0,
    payment_method text DEFAULT 'Cash'::text,
    doctor_name text,
    lab_status text DEFAULT 'Not Started'::text,
    order_date timestamp with time zone DEFAULT now(),
    delivery_date timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    rx_image_path text,
    frame_image_path text,
    store_id uuid NOT NULL,
    idempotency_key uuid,
    CONSTRAINT sales_amount_paid_nonneg CHECK ((amount_paid >= (0)::numeric)),
    CONSTRAINT sales_discount_le_total CHECK ((discount <= total_amount)),
    CONSTRAINT sales_discount_nonneg CHECK ((discount >= (0)::numeric)),
    CONSTRAINT sales_net_matches CHECK ((net_amount = (total_amount - discount)))
);

ALTER TABLE ONLY public.sales FORCE ROW LEVEL SECURITY;


--
-- Name: create_sale_order(jsonb, jsonb, jsonb, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_sale_order(p_sale jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_exams jsonb DEFAULT '[]'::jsonb, p_payments jsonb DEFAULT '[]'::jsonb, p_idempotency_key uuid DEFAULT NULL::uuid) RETURNS public.sales
    LANGUAGE plpgsql
    AS $$
declare
  v_in        public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale      public.sales;
  v_store     uuid;
  v_inv       text;
  v_allow     boolean;
  v_net       numeric;
  v_total     numeric;
  v_discount  numeric;
  v_items     numeric := 0;
  v_paid_hdr  numeric;
  v_paid_led  numeric;
  v_prices    jsonb := '{}'::jsonb;
  v_line      record;
  v_cat       numeric;
  v_cat_name  text;
  v_stock     integer;
begin
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  -- 0) Idempotency: a replayed checkout returns the sale it already created
  --    (double-tap, retry after a lost response, offline replay in Phase 6).
  if p_idempotency_key is not null then
    select * into v_sale
      from public.sales
     where store_id = v_store
       and idempotency_key = p_idempotency_key;
    if found then
      return v_sale;
    end if;
  end if;

  select s.allow_negative_stock into v_allow
    from public.stores s
   where s.id = v_store;
  if v_allow is null then
    v_allow := true;
  end if;

  -- 1) Lock every product in the cart (sorted, so two registers never
  --    deadlock) and collect the catalog prices the DB will actually charge.
  for v_line in
    select r.product_id, sum(r.qty)::integer as qty
      from jsonb_populate_recordset(null::public.sale_items, p_items) r
     group by r.product_id
     order by r.product_id
  loop
    select i.name, i.sale_price, i.stock_qty
      into v_cat_name, v_cat, v_stock
      from public.inventory i
     where i.id = v_line.product_id
       for update of i;
    if not found then
      raise exception 'unknown product in cart';
    end if;

    if not v_allow and coalesce(v_stock, 0) < v_line.qty then
      raise exception 'insufficient stock: %', coalesce(v_cat_name, 'unknown product');
    end if;

    v_prices := v_prices || jsonb_build_object(v_line.product_id::text, coalesce(v_cat, 0));
  end loop;

  -- 2) Validate every line against the catalog (T1): a stale cart is refused
  --    instead of re-priced, and quantities must be positive.
  for v_line in
    select r.product_id, r.qty, r.unit_price
      from jsonb_populate_recordset(null::public.sale_items, p_items) r
  loop
    if coalesce(v_line.qty, 0) <= 0 then
      raise exception 'invalid line quantity';
    end if;
    v_cat := (v_prices ->> v_line.product_id::text)::numeric;
    if abs(coalesce(v_line.unit_price, 0) - v_cat) > 0.01 then
      select i.name into v_cat_name from public.inventory i where i.id = v_line.product_id;
      raise exception 'price changed: %', coalesce(v_cat_name, 'unknown product');
    end if;
    v_items := v_items + v_line.qty * v_cat;
  end loop;

  -- 3) Recompute the header from the ONE money input that survives: the
  --    client's net. Below the catalog sum the gap becomes an explicit
  --    discount; above it (round-up) the declared total stands.
  v_net := coalesce(v_in.net_amount,
                    coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0));
  if v_net < -0.01 then
    raise exception 'negative net amount';
  end if;
  v_net := round(v_net, 2);

  if v_net <= v_items + 0.01 then
    v_total    := v_items;
    v_discount := round(greatest(0, v_items - v_net), 2);
    v_net      := v_total - v_discount;
  else
    v_total    := v_net;
    v_discount := 0;
  end if;

  -- 4) Money in can never exceed money out (header AND ledger).
  v_paid_hdr := coalesce(v_in.amount_paid, 0);
  if v_paid_hdr < -0.01 then
    raise exception 'negative payment amount';
  end if;
  select coalesce(sum(r.amount), 0) into v_paid_led
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount > 0;
  if v_paid_hdr > v_net + 0.01 or v_paid_led > v_net + 0.01 then
    raise exception 'payment exceeds net amount';
  end if;

  -- 5) Invoice number: the wizard's reservation when it is still free,
  --    otherwise the next number from the atomic counter.
  v_inv := nullif(trim(v_in.invoice_no), '');
  if v_inv is not null and exists (select 1 from public.sales where invoice_no = v_inv) then
    v_inv := null;
  end if;
  if v_inv is null then
    v_inv := public.next_invoice_no();
  end if;

  -- 6) Header first: this also CLAIMS the idempotency key. A concurrent
  --    replay blocks on the unique index, then finds the winner's row here;
  --    an invoice_no collision re-raises for the client's retry loop.
  begin
    insert into public.sales
      (invoice_no, store_id, idempotency_key, customer_id, user_id,
       total_amount, discount, net_amount, amount_paid, payment_method,
       order_date, delivery_date, doctor_name, lab_status,
       rx_image_path, frame_image_path)
    values
      (v_inv, v_store, p_idempotency_key, v_in.customer_id, v_in.user_id,
       v_total, v_discount, v_net, v_paid_hdr, coalesce(v_in.payment_method, 'Cash'),
       coalesce(v_in.order_date, now()), v_in.delivery_date, v_in.doctor_name,
       v_in.lab_status, v_in.rx_image_path, v_in.frame_image_path)
    returning * into v_sale;
  exception when unique_violation then
    if p_idempotency_key is not null then
      select * into v_sale
        from public.sales
       where store_id = v_store
         and idempotency_key = p_idempotency_key;
      if found then
        return v_sale;
      end if;
    end if;
    raise;
  end;

  -- 7) Line items, written at CATALOG prices (client totals are ignored).
  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name)
  select v_sale.id, v_store, r.product_id, r.qty,
         (v_prices ->> r.product_id::text)::numeric,
         r.qty * (v_prices ->> r.product_id::text)::numeric,
         r.name
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- one negative stock movement per line (the sync trigger above updates the
  -- stock_qty read model in the same transaction)
  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_store, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- examinations
  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select v_sale.id, v_store, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_in.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  -- payment lines; the sale_payments_sync trigger (011) recomputes
  -- sales.amount_paid from these rows, so header and ledger cannot disagree.
  insert into public.sale_payments
    (sale_id, amount, method, note, paid_at, store_id, recorded_by)
  select v_sale.id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         r.note,
         coalesce(r.paid_at, current_date),
         v_store,
         coalesce(r.recorded_by, auth.uid())
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount > 0;

  return v_sale;
end $$;


--
-- Name: is_platform_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(select 1 from public.platform_admins where auth_uid = auth.uid())
$$;


--
-- Name: license_read_ok(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.license_read_ok(p_store uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((
    select (is_revoked = false)
       and (expires_at is null or expires_at > now() - interval '30 days')
    from public.store_licenses
    where store_id = p_store
    order by created_at desc
    limit 1
  ), false)
$$;


--
-- Name: license_write_ok(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.license_write_ok(p_store uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((
    select (is_revoked = false)
       and (expires_at is null or expires_at > now())
    from public.store_licenses
    where store_id = p_store
    order by created_at desc
    limit 1
  ), false)
$$;


--
-- Name: my_license_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_license_state() RETURNS TABLE(state text, plan text, expires_at timestamp with time zone, store_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select
    case
      when s.id is null then 'none'
      when l.id is null then 'none'
      when l.is_revoked then 'expired'
      when l.expires_at is null or l.expires_at > now() then 'active'
      when l.expires_at > now() - interval '30 days' then 'grace'
      else 'expired'
    end,
    l.plan,
    l.expires_at,
    s.name
  from public.stores s
  left join public.store_licenses l on l.store_id = s.id
  where s.id = public.auth_store_id()
$$;


--
-- Name: next_invoice_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_invoice_no() RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare
  v_store uuid;
  v_next  bigint;
begin
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  insert into public.invoice_counter (store_id, prefix, next_val)
  select v_store, '',
         coalesce(max(case when invoice_no ~ '^[0-9]+$' then invoice_no::bigint end), 0) + 1
    from public.sales
   where store_id = v_store
  on conflict (store_id, prefix) do nothing;

  update public.invoice_counter
     set next_val = next_val + 1
   where store_id = v_store and prefix = ''
  returning next_val - 1 into v_next;

  -- 6 digits zero-padded, exactly like the old format; never TRUNCATE above
  -- 999999 (lpad() would silently fold 1000000 back to 000000).
  return case when v_next < 1000000 then lpad(v_next::text, 6, '0') else v_next::text end;
end $_$;


--
-- Name: sync_sale_amount_paid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_sale_amount_paid() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    v_sale uuid;
begin
    v_sale := coalesce(new.sale_id, old.sale_id);
    update public.sales s
       set amount_paid = (
             select coalesce(sum(sp.amount), 0)
             from public.sale_payments sp
             where sp.sale_id = v_sale
           )
     where s.id = v_sale;
    return null;
end $$;


--
-- Name: sync_stock_qty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_stock_qty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' and new.product_id is distinct from old.product_id then
    update public.inventory set stock_qty = stock_qty - old.qty where id = old.product_id;
    update public.inventory set stock_qty = stock_qty + new.qty where id = new.product_id;
    return new;
  end if;

  if tg_op = 'INSERT' then
    update public.inventory set stock_qty = stock_qty + new.qty where id = new.product_id;
  elsif tg_op = 'UPDATE' then
    update public.inventory set stock_qty = stock_qty + (new.qty - old.qty) where id = new.product_id;
  else
    update public.inventory set stock_qty = stock_qty - old.qty where id = old.product_id;
  end if;
  return coalesce(new, old);
end $$;


--
-- Name: tenant_fill_store_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tenant_fill_store_id() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.store_id is null then
    new.store_id := public.auth_store_id();
  end if;
  return new;
end $$;


--
-- Name: app_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_updates (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    app_name text NOT NULL,
    version text NOT NULL,
    download_url text,
    release_notes text,
    is_mandatory boolean DEFAULT false,
    min_version text,
    platform text DEFAULT 'all'::text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.app_updates FORCE ROW LEVEL SECURITY;


--
-- Name: contact_lens_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_lens_types (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    phone text,
    phone2 text,
    email text,
    city text,
    address text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.customers FORCE ROW LEVEL SECURITY;


--
-- Name: frame_colors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frame_colors (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL,
    sort_order integer
);

ALTER TABLE ONLY public.frame_colors FORCE ROW LEVEL SECURITY;


--
-- Name: frame_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frame_types (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.frame_types FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_counter (
    store_id uuid NOT NULL,
    prefix text DEFAULT ''::text NOT NULL,
    next_val bigint NOT NULL
);

ALTER TABLE ONLY public.invoice_counter FORCE ROW LEVEL SECURITY;


--
-- Name: lens_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lens_types (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL,
    sort_order integer
);

ALTER TABLE ONLY public.lens_types FORCE ROW LEVEL SECURITY;


--
-- Name: license_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.license_logs (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    license_key text NOT NULL,
    event_type text NOT NULL,
    machine_id text,
    ip_address text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.license_logs FORCE ROW LEVEL SECURITY;


--
-- Name: licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.licenses (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    license_key text NOT NULL,
    licensee_name text,
    licensee_email text,
    license_type text DEFAULT 'standard'::text,
    machine_id text,
    is_active boolean DEFAULT false,
    is_revoked boolean DEFAULT false,
    allow_transfer boolean DEFAULT false,
    max_activations integer DEFAULT 1,
    current_activations integer DEFAULT 0,
    features jsonb DEFAULT '{}'::jsonb,
    expires_at timestamp with time zone,
    activated_at timestamp with time zone,
    deactivated_at timestamp with time zone,
    last_check timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid
);

ALTER TABLE ONLY public.licenses FORCE ROW LEVEL SECURITY;


--
-- Name: note_seen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_seen (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    note_id uuid NOT NULL,
    user_id uuid NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.note_seen FORCE ROW LEVEL SECURITY;


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid,
    created_by uuid,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.notes FORCE ROW LEVEL SECURITY;


--
-- Name: order_examinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_examinations (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    sale_id uuid,
    exam_type text,
    sphere_od text,
    cylinder_od text,
    axis_od text,
    sphere_os text,
    cylinder_os text,
    axis_os text,
    ipd text,
    lens_info text,
    frame_info text,
    frame_color text,
    frame_status text,
    doctor_name text,
    image_path text,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.order_examinations FORCE ROW LEVEL SECURITY;


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    code text NOT NULL,
    name text,
    description text
);

ALTER TABLE ONLY public.permissions FORCE ROW LEVEL SECURITY;


--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_admins (
    auth_uid uuid NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.platform_admins FORCE ROW LEVEL SECURITY;


--
-- Name: prescriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prescriptions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    customer_id uuid,
    type text,
    doctor_name text,
    sphere_od text,
    cylinder_od text,
    axis_od text,
    ipd_od text,
    sphere_os text,
    cylinder_os text,
    axis_os text,
    ipd_os text,
    notes text,
    image_path text,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.prescriptions FORCE ROW LEVEL SECURITY;


--
-- Name: purchase_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_items (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    purchase_id uuid,
    product_id uuid,
    qty integer DEFAULT 1,
    unit_cost numeric(10,2) DEFAULT 0,
    total_cost numeric(10,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.purchase_items FORCE ROW LEVEL SECURITY;


--
-- Name: purchase_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_payments (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    purchase_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    paid_at date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.purchase_payments FORCE ROW LEVEL SECURITY;


--
-- Name: purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchases (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    supplier_id uuid,
    total_amount numeric(10,2) DEFAULT 0,
    amount_paid numeric(10,2) DEFAULT 0,
    purchase_date timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.purchases FORCE ROW LEVEL SECURITY;


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    role_id uuid,
    permission_id uuid,
    value text
);

ALTER TABLE ONLY public.role_permissions FORCE ROW LEVEL SECURITY;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


--
-- Name: sale_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_items (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    sale_id uuid,
    product_id uuid,
    name text,
    qty integer DEFAULT 1,
    unit_price numeric(10,2) DEFAULT 0,
    total_price numeric(10,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL,
    CONSTRAINT sale_items_qty_positive CHECK ((qty > 0)),
    CONSTRAINT sale_items_total_matches CHECK ((total_price = ((qty)::numeric * unit_price))),
    CONSTRAINT sale_items_unit_price_nonneg CHECK ((unit_price >= (0)::numeric))
);

ALTER TABLE ONLY public.sale_items FORCE ROW LEVEL SECURITY;


--
-- Name: sale_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_payments (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    sale_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    method text DEFAULT 'cash'::text NOT NULL,
    note text,
    paid_at date DEFAULT CURRENT_DATE NOT NULL,
    recorded_by uuid DEFAULT auth.uid(),
    store_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sale_payments_amount_check CHECK ((amount > (0)::numeric))
);

ALTER TABLE ONLY public.sale_payments FORCE ROW LEVEL SECURITY;


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    key text NOT NULL,
    value text,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.settings FORCE ROW LEVEL SECURITY;


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    product_id uuid,
    qty integer NOT NULL,
    type text NOT NULL,
    ref_no text,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.stock_movements FORCE ROW LEVEL SECURITY;


--
-- Name: store_licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_licenses (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    store_id uuid NOT NULL,
    license_key text NOT NULL,
    plan text DEFAULT 'standard'::text NOT NULL,
    max_staff integer,
    is_revoked boolean DEFAULT false NOT NULL,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.store_licenses FORCE ROW LEVEL SECURITY;


--
-- Name: stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stores (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    owner_name text,
    owner_phone text,
    owner_email text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    allow_negative_stock boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.stores FORCE ROW LEVEL SECURITY;


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    phone text,
    email text,
    address text,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.suppliers FORCE ROW LEVEL SECURITY;


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid,
    permission_id uuid,
    allow boolean DEFAULT true,
    value text
);

ALTER TABLE ONLY public.user_permissions FORCE ROW LEVEL SECURITY;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    full_name text,
    role_id uuid,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


--
-- Name: warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouses (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    store_id uuid NOT NULL
);

ALTER TABLE ONLY public.warehouses FORCE ROW LEVEL SECURITY;


--
-- Name: app_updates app_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_updates
    ADD CONSTRAINT app_updates_pkey PRIMARY KEY (id);


--
-- Name: contact_lens_types contact_lens_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_lens_types
    ADD CONSTRAINT contact_lens_types_name_key UNIQUE (name);


--
-- Name: contact_lens_types contact_lens_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_lens_types
    ADD CONSTRAINT contact_lens_types_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: frame_colors frame_colors_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frame_colors
    ADD CONSTRAINT frame_colors_name_key UNIQUE (name);


--
-- Name: frame_colors frame_colors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frame_colors
    ADD CONSTRAINT frame_colors_pkey PRIMARY KEY (id);


--
-- Name: frame_types frame_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frame_types
    ADD CONSTRAINT frame_types_name_key UNIQUE (name);


--
-- Name: frame_types frame_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frame_types
    ADD CONSTRAINT frame_types_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_sku_key UNIQUE (sku);


--
-- Name: invoice_counter invoice_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_counter
    ADD CONSTRAINT invoice_counter_pkey PRIMARY KEY (store_id, prefix);


--
-- Name: lens_types lens_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lens_types
    ADD CONSTRAINT lens_types_name_key UNIQUE (name);


--
-- Name: lens_types lens_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lens_types
    ADD CONSTRAINT lens_types_pkey PRIMARY KEY (id);


--
-- Name: license_logs license_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.license_logs
    ADD CONSTRAINT license_logs_pkey PRIMARY KEY (id);


--
-- Name: licenses licenses_license_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_license_key_key UNIQUE (license_key);


--
-- Name: licenses licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_pkey PRIMARY KEY (id);


--
-- Name: note_seen note_seen_note_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_seen
    ADD CONSTRAINT note_seen_note_id_user_id_key UNIQUE (note_id, user_id);


--
-- Name: note_seen note_seen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_seen
    ADD CONSTRAINT note_seen_pkey PRIMARY KEY (id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: order_examinations order_examinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_examinations
    ADD CONSTRAINT order_examinations_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_code_key UNIQUE (code);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (auth_uid);


--
-- Name: prescriptions prescriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescriptions
    ADD CONSTRAINT prescriptions_pkey PRIMARY KEY (id);


--
-- Name: purchase_items purchase_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_items
    ADD CONSTRAINT purchase_items_pkey PRIMARY KEY (id);


--
-- Name: purchase_payments purchase_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_payments
    ADD CONSTRAINT purchase_payments_pkey PRIMARY KEY (id);


--
-- Name: purchases purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_role_id_permission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_permission_id_key UNIQUE (role_id, permission_id);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sale_items sale_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_pkey PRIMARY KEY (id);


--
-- Name: sale_payments sale_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_pkey PRIMARY KEY (id);


--
-- Name: sales sales_invoice_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_invoice_no_key UNIQUE (invoice_no);


--
-- Name: sales sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);


--
-- Name: settings settings_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_key_key UNIQUE (key);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: store_licenses store_licenses_license_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_licenses
    ADD CONSTRAINT store_licenses_license_key_key UNIQUE (license_key);


--
-- Name: store_licenses store_licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_licenses
    ADD CONSTRAINT store_licenses_pkey PRIMARY KEY (id);


--
-- Name: store_licenses store_licenses_store_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_licenses
    ADD CONSTRAINT store_licenses_store_id_key UNIQUE (store_id);


--
-- Name: stores stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_user_id_permission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_permission_id_key UNIQUE (user_id, permission_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: warehouses warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);


--
-- Name: idx_app_updates_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_updates_name ON public.app_updates USING btree (app_name, version);


--
-- Name: idx_customers_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_store ON public.customers USING btree (store_id);


--
-- Name: idx_exams_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exams_store ON public.order_examinations USING btree (store_id);


--
-- Name: idx_inventory_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_store ON public.inventory USING btree (store_id);


--
-- Name: idx_license_logs_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_license_logs_key ON public.license_logs USING btree (license_key);


--
-- Name: idx_licenses_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_active ON public.licenses USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_licenses_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_key ON public.licenses USING btree (license_key);


--
-- Name: idx_licenses_machine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_licenses_machine ON public.licenses USING btree (machine_id);


--
-- Name: idx_notes_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_store ON public.notes USING btree (store_id);


--
-- Name: idx_presc_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_presc_store ON public.prescriptions USING btree (store_id);


--
-- Name: idx_purchase_it_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_it_store ON public.purchase_items USING btree (store_id);


--
-- Name: idx_purchase_pay_st; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_pay_st ON public.purchase_payments USING btree (store_id);


--
-- Name: idx_purchases_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchases_store ON public.purchases USING btree (store_id);


--
-- Name: idx_roles_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_store ON public.roles USING btree (store_id);


--
-- Name: idx_sale_items_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_items_store ON public.sale_items USING btree (store_id);


--
-- Name: idx_sales_store_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_store_date ON public.sales USING btree (store_id, order_date DESC);


--
-- Name: idx_stock_mv_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_mv_product ON public.stock_movements USING btree (product_id);


--
-- Name: idx_stock_mv_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_mv_store ON public.stock_movements USING btree (store_id);


--
-- Name: idx_suppliers_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_store ON public.suppliers USING btree (store_id);


--
-- Name: idx_users_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_store ON public.users USING btree (store_id);


--
-- Name: note_seen_note_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX note_seen_note_idx ON public.note_seen USING btree (note_id);


--
-- Name: notes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notes_user_idx ON public.notes USING btree (user_id, created_at DESC);


--
-- Name: purchase_payments_purchase_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX purchase_payments_purchase_idx ON public.purchase_payments USING btree (purchase_id, paid_at);


--
-- Name: sale_payments_sale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_payments_sale_idx ON public.sale_payments USING btree (sale_id, paid_at);


--
-- Name: sale_payments_store_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sale_payments_store_idx ON public.sale_payments USING btree (store_id);


--
-- Name: sales_store_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sales_store_idempotency_key ON public.sales USING btree (store_id, idempotency_key);


--
-- Name: sale_payments sale_payments_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sale_payments_sync AFTER INSERT OR DELETE OR UPDATE ON public.sale_payments FOR EACH ROW EXECUTE FUNCTION public.sync_sale_amount_paid();


--
-- Name: stock_movements stock_qty_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stock_qty_sync AFTER INSERT OR DELETE OR UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.sync_stock_qty();


--
-- Name: customers tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: frame_colors tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.frame_colors FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: frame_types tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.frame_types FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: inventory tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: lens_types tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.lens_types FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: note_seen tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.note_seen FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: notes tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.notes FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: order_examinations tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.order_examinations FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: prescriptions tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.prescriptions FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: purchase_items tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.purchase_items FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: purchase_payments tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.purchase_payments FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: purchases tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.purchases FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: roles tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.roles FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: sale_items tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.sale_items FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: sale_payments tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.sale_payments FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: sales tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: settings tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.settings FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: stock_movements tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: suppliers tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: users tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: warehouses tenant_fill_store_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tenant_fill_store_id BEFORE INSERT ON public.warehouses FOR EACH ROW EXECUTE FUNCTION public.tenant_fill_store_id();


--
-- Name: invoice_counter invoice_counter_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_counter
    ADD CONSTRAINT invoice_counter_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: licenses licenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: note_seen note_seen_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_seen
    ADD CONSTRAINT note_seen_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.notes(id) ON DELETE CASCADE;


--
-- Name: note_seen note_seen_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_seen
    ADD CONSTRAINT note_seen_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: notes notes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: notes notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: order_examinations order_examinations_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_examinations
    ADD CONSTRAINT order_examinations_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: platform_admins platform_admins_auth_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_auth_uid_fkey FOREIGN KEY (auth_uid) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: prescriptions prescriptions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescriptions
    ADD CONSTRAINT prescriptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: purchase_items purchase_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_items
    ADD CONSTRAINT purchase_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.inventory(id);


--
-- Name: purchase_items purchase_items_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_items
    ADD CONSTRAINT purchase_items_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id) ON DELETE CASCADE;


--
-- Name: purchase_payments purchase_payments_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_payments
    ADD CONSTRAINT purchase_payments_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id) ON DELETE CASCADE;


--
-- Name: purchases purchases_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: sale_items sale_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.inventory(id);


--
-- Name: sale_items sale_items_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sale_payments sale_payments_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: sale_payments sale_payments_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sales sales_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: sales sales_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: stock_movements stock_movements_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.inventory(id) ON DELETE CASCADE;


--
-- Name: store_licenses store_licenses_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_licenses
    ADD CONSTRAINT store_licenses_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: app_updates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_updates ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: frame_colors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.frame_colors ENABLE ROW LEVEL SECURITY;

--
-- Name: frame_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.frame_types ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_counter; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_counter ENABLE ROW LEVEL SECURITY;

--
-- Name: lens_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lens_types ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions lensy_authenticated_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_authenticated_all ON public.permissions TO authenticated USING (true) WITH CHECK (true);


--
-- Name: role_permissions lensy_authenticated_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_authenticated_all ON public.role_permissions TO authenticated USING (true) WITH CHECK (true);


--
-- Name: user_permissions lensy_authenticated_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_authenticated_all ON public.user_permissions TO authenticated USING (true) WITH CHECK (true);


--
-- Name: license_logs lensy_platform_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_platform_all ON public.license_logs TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());


--
-- Name: platform_admins lensy_platform_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_platform_all ON public.platform_admins TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());


--
-- Name: store_licenses lensy_platform_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_platform_all ON public.store_licenses TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());


--
-- Name: app_updates lensy_platform_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_platform_read ON public.app_updates FOR SELECT TO authenticated USING (public.is_platform_admin());


--
-- Name: licenses lensy_platform_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_platform_read ON public.licenses FOR SELECT TO authenticated USING (public.is_platform_admin());


--
-- Name: stores lensy_stores_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_stores_read ON public.stores FOR SELECT TO authenticated USING ((public.is_platform_admin() OR (id = public.auth_store_id())));


--
-- Name: stores lensy_stores_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_stores_write ON public.stores TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());


--
-- Name: customers lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.customers FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(customers.store_id) AS license_write_ok))));


--
-- Name: frame_colors lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.frame_colors FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(frame_colors.store_id) AS license_write_ok))));


--
-- Name: frame_types lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.frame_types FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(frame_types.store_id) AS license_write_ok))));


--
-- Name: inventory lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.inventory FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(inventory.store_id) AS license_write_ok))));


--
-- Name: invoice_counter lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.invoice_counter FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(invoice_counter.store_id) AS license_write_ok))));


--
-- Name: lens_types lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.lens_types FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(lens_types.store_id) AS license_write_ok))));


--
-- Name: note_seen lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.note_seen FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(note_seen.store_id) AS license_write_ok))));


--
-- Name: notes lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.notes FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(notes.store_id) AS license_write_ok))));


--
-- Name: order_examinations lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.order_examinations FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(order_examinations.store_id) AS license_write_ok))));


--
-- Name: prescriptions lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.prescriptions FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(prescriptions.store_id) AS license_write_ok))));


--
-- Name: purchase_items lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.purchase_items FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchase_items.store_id) AS license_write_ok))));


--
-- Name: purchase_payments lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.purchase_payments FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchase_payments.store_id) AS license_write_ok))));


--
-- Name: purchases lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.purchases FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchases.store_id) AS license_write_ok))));


--
-- Name: roles lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.roles FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(roles.store_id) AS license_write_ok))));


--
-- Name: sale_items lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.sale_items FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sale_items.store_id) AS license_write_ok))));


--
-- Name: sale_payments lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.sale_payments FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sale_payments.store_id) AS license_write_ok))));


--
-- Name: sales lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.sales FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sales.store_id) AS license_write_ok))));


--
-- Name: settings lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.settings FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(settings.store_id) AS license_write_ok))));


--
-- Name: stock_movements lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.stock_movements FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(stock_movements.store_id) AS license_write_ok))));


--
-- Name: suppliers lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.suppliers FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(suppliers.store_id) AS license_write_ok))));


--
-- Name: users lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.users FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(users.store_id) AS license_write_ok))));


--
-- Name: warehouses lensy_tenant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_delete ON public.warehouses FOR DELETE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(warehouses.store_id) AS license_write_ok))));


--
-- Name: customers lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.customers FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(customers.store_id) AS license_write_ok))));


--
-- Name: frame_colors lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.frame_colors FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(frame_colors.store_id) AS license_write_ok))));


--
-- Name: frame_types lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.frame_types FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(frame_types.store_id) AS license_write_ok))));


--
-- Name: inventory lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.inventory FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(inventory.store_id) AS license_write_ok))));


--
-- Name: invoice_counter lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.invoice_counter FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(invoice_counter.store_id) AS license_write_ok))));


--
-- Name: lens_types lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.lens_types FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(lens_types.store_id) AS license_write_ok))));


--
-- Name: note_seen lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.note_seen FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(note_seen.store_id) AS license_write_ok))));


--
-- Name: notes lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.notes FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(notes.store_id) AS license_write_ok))));


--
-- Name: order_examinations lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.order_examinations FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(order_examinations.store_id) AS license_write_ok))));


--
-- Name: prescriptions lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.prescriptions FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(prescriptions.store_id) AS license_write_ok))));


--
-- Name: purchase_items lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.purchase_items FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchase_items.store_id) AS license_write_ok))));


--
-- Name: purchase_payments lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.purchase_payments FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchase_payments.store_id) AS license_write_ok))));


--
-- Name: purchases lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.purchases FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchases.store_id) AS license_write_ok))));


--
-- Name: roles lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.roles FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(roles.store_id) AS license_write_ok))));


--
-- Name: sale_items lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.sale_items FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sale_items.store_id) AS license_write_ok))));


--
-- Name: sale_payments lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.sale_payments FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sale_payments.store_id) AS license_write_ok))));


--
-- Name: sales lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.sales FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sales.store_id) AS license_write_ok))));


--
-- Name: settings lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.settings FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(settings.store_id) AS license_write_ok))));


--
-- Name: stock_movements lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.stock_movements FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(stock_movements.store_id) AS license_write_ok))));


--
-- Name: suppliers lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.suppliers FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(suppliers.store_id) AS license_write_ok))));


--
-- Name: users lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.users FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(users.store_id) AS license_write_ok))));


--
-- Name: warehouses lensy_tenant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_insert ON public.warehouses FOR INSERT TO authenticated WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(warehouses.store_id) AS license_write_ok))));


--
-- Name: customers lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.customers FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(customers.store_id) AS license_read_ok))));


--
-- Name: frame_colors lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.frame_colors FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(frame_colors.store_id) AS license_read_ok))));


--
-- Name: frame_types lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.frame_types FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(frame_types.store_id) AS license_read_ok))));


--
-- Name: inventory lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.inventory FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(inventory.store_id) AS license_read_ok))));


--
-- Name: invoice_counter lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.invoice_counter FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(invoice_counter.store_id) AS license_read_ok))));


--
-- Name: lens_types lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.lens_types FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(lens_types.store_id) AS license_read_ok))));


--
-- Name: note_seen lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.note_seen FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(note_seen.store_id) AS license_read_ok))));


--
-- Name: notes lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.notes FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(notes.store_id) AS license_read_ok))));


--
-- Name: order_examinations lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.order_examinations FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(order_examinations.store_id) AS license_read_ok))));


--
-- Name: prescriptions lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.prescriptions FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(prescriptions.store_id) AS license_read_ok))));


--
-- Name: purchase_items lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.purchase_items FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(purchase_items.store_id) AS license_read_ok))));


--
-- Name: purchase_payments lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.purchase_payments FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(purchase_payments.store_id) AS license_read_ok))));


--
-- Name: purchases lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.purchases FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(purchases.store_id) AS license_read_ok))));


--
-- Name: roles lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.roles FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(roles.store_id) AS license_read_ok))));


--
-- Name: sale_items lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.sale_items FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(sale_items.store_id) AS license_read_ok))));


--
-- Name: sale_payments lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.sale_payments FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(sale_payments.store_id) AS license_read_ok))));


--
-- Name: sales lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.sales FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(sales.store_id) AS license_read_ok))));


--
-- Name: settings lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.settings FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(settings.store_id) AS license_read_ok))));


--
-- Name: stock_movements lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.stock_movements FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(stock_movements.store_id) AS license_read_ok))));


--
-- Name: suppliers lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.suppliers FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(suppliers.store_id) AS license_read_ok))));


--
-- Name: users lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.users FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(users.store_id) AS license_read_ok))));


--
-- Name: warehouses lensy_tenant_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_read ON public.warehouses FOR SELECT TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(warehouses.store_id) AS license_read_ok))));


--
-- Name: customers lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.customers FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(customers.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(customers.store_id) AS license_write_ok))));


--
-- Name: frame_colors lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.frame_colors FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(frame_colors.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(frame_colors.store_id) AS license_write_ok))));


--
-- Name: frame_types lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.frame_types FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(frame_types.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(frame_types.store_id) AS license_write_ok))));


--
-- Name: inventory lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.inventory FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(inventory.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(inventory.store_id) AS license_write_ok))));


--
-- Name: invoice_counter lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.invoice_counter FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(invoice_counter.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(invoice_counter.store_id) AS license_write_ok))));


--
-- Name: lens_types lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.lens_types FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(lens_types.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(lens_types.store_id) AS license_write_ok))));


--
-- Name: note_seen lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.note_seen FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(note_seen.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(note_seen.store_id) AS license_write_ok))));


--
-- Name: notes lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.notes FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(notes.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(notes.store_id) AS license_write_ok))));


--
-- Name: order_examinations lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.order_examinations FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(order_examinations.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(order_examinations.store_id) AS license_write_ok))));


--
-- Name: prescriptions lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.prescriptions FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(prescriptions.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(prescriptions.store_id) AS license_write_ok))));


--
-- Name: purchase_items lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.purchase_items FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(purchase_items.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchase_items.store_id) AS license_write_ok))));


--
-- Name: purchase_payments lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.purchase_payments FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(purchase_payments.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchase_payments.store_id) AS license_write_ok))));


--
-- Name: purchases lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.purchases FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(purchases.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(purchases.store_id) AS license_write_ok))));


--
-- Name: roles lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.roles FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(roles.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(roles.store_id) AS license_write_ok))));


--
-- Name: sale_items lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.sale_items FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(sale_items.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sale_items.store_id) AS license_write_ok))));


--
-- Name: sale_payments lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.sale_payments FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(sale_payments.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sale_payments.store_id) AS license_write_ok))));


--
-- Name: sales lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.sales FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(sales.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(sales.store_id) AS license_write_ok))));


--
-- Name: settings lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.settings FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(settings.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(settings.store_id) AS license_write_ok))));


--
-- Name: stock_movements lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.stock_movements FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(stock_movements.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(stock_movements.store_id) AS license_write_ok))));


--
-- Name: suppliers lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.suppliers FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(suppliers.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(suppliers.store_id) AS license_write_ok))));


--
-- Name: users lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.users FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(users.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(users.store_id) AS license_write_ok))));


--
-- Name: warehouses lensy_tenant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lensy_tenant_update ON public.warehouses FOR UPDATE TO authenticated USING ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_read_ok(warehouses.store_id) AS license_read_ok)))) WITH CHECK ((public.is_platform_admin() OR ((store_id = public.auth_store_id()) AND ( SELECT public.license_write_ok(warehouses.store_id) AS license_write_ok))));


--
-- Name: license_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.license_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: licenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

--
-- Name: note_seen; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.note_seen ENABLE ROW LEVEL SECURITY;

--
-- Name: notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

--
-- Name: order_examinations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_examinations ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: prescriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prescriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: sale_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;

--
-- Name: sale_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: sales; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

--
-- Name: settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: store_licenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_licenses ENABLE ROW LEVEL SECURITY;

--
-- Name: stores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

--
-- Name: suppliers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

--
-- Name: user_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: TABLE inventory; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.inventory TO anon;
GRANT ALL ON TABLE public.inventory TO authenticated;
GRANT ALL ON TABLE public.inventory TO service_role;


--
-- Name: FUNCTION add_inventory_item(p_product jsonb, p_initial_stock integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_inventory_item(p_product jsonb, p_initial_stock integer) TO anon;
GRANT ALL ON FUNCTION public.add_inventory_item(p_product jsonb, p_initial_stock integer) TO authenticated;
GRANT ALL ON FUNCTION public.add_inventory_item(p_product jsonb, p_initial_stock integer) TO service_role;


--
-- Name: FUNCTION auth_store_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auth_store_id() TO anon;
GRANT ALL ON FUNCTION public.auth_store_id() TO authenticated;
GRANT ALL ON FUNCTION public.auth_store_id() TO service_role;


--
-- Name: FUNCTION available_stock(p_product uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.available_stock(p_product uuid) TO anon;
GRANT ALL ON FUNCTION public.available_stock(p_product uuid) TO authenticated;
GRANT ALL ON FUNCTION public.available_stock(p_product uuid) TO service_role;


--
-- Name: TABLE sales; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sales TO anon;
GRANT ALL ON TABLE public.sales TO authenticated;
GRANT ALL ON TABLE public.sales TO service_role;


--
-- Name: FUNCTION create_sale_order(p_sale jsonb, p_items jsonb, p_exams jsonb, p_payments jsonb, p_idempotency_key uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_sale_order(p_sale jsonb, p_items jsonb, p_exams jsonb, p_payments jsonb, p_idempotency_key uuid) TO anon;
GRANT ALL ON FUNCTION public.create_sale_order(p_sale jsonb, p_items jsonb, p_exams jsonb, p_payments jsonb, p_idempotency_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_sale_order(p_sale jsonb, p_items jsonb, p_exams jsonb, p_payments jsonb, p_idempotency_key uuid) TO service_role;


--
-- Name: FUNCTION is_platform_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_platform_admin() TO anon;
GRANT ALL ON FUNCTION public.is_platform_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_platform_admin() TO service_role;


--
-- Name: FUNCTION license_read_ok(p_store uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.license_read_ok(p_store uuid) TO anon;
GRANT ALL ON FUNCTION public.license_read_ok(p_store uuid) TO authenticated;
GRANT ALL ON FUNCTION public.license_read_ok(p_store uuid) TO service_role;


--
-- Name: FUNCTION license_write_ok(p_store uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.license_write_ok(p_store uuid) TO anon;
GRANT ALL ON FUNCTION public.license_write_ok(p_store uuid) TO authenticated;
GRANT ALL ON FUNCTION public.license_write_ok(p_store uuid) TO service_role;


--
-- Name: FUNCTION my_license_state(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.my_license_state() TO anon;
GRANT ALL ON FUNCTION public.my_license_state() TO authenticated;
GRANT ALL ON FUNCTION public.my_license_state() TO service_role;


--
-- Name: FUNCTION next_invoice_no(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.next_invoice_no() TO anon;
GRANT ALL ON FUNCTION public.next_invoice_no() TO authenticated;
GRANT ALL ON FUNCTION public.next_invoice_no() TO service_role;


--
-- Name: FUNCTION sync_sale_amount_paid(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_sale_amount_paid() TO anon;
GRANT ALL ON FUNCTION public.sync_sale_amount_paid() TO authenticated;
GRANT ALL ON FUNCTION public.sync_sale_amount_paid() TO service_role;


--
-- Name: FUNCTION sync_stock_qty(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_stock_qty() TO anon;
GRANT ALL ON FUNCTION public.sync_stock_qty() TO authenticated;
GRANT ALL ON FUNCTION public.sync_stock_qty() TO service_role;


--
-- Name: FUNCTION tenant_fill_store_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tenant_fill_store_id() TO anon;
GRANT ALL ON FUNCTION public.tenant_fill_store_id() TO authenticated;
GRANT ALL ON FUNCTION public.tenant_fill_store_id() TO service_role;


--
-- Name: TABLE app_updates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_updates TO anon;
GRANT ALL ON TABLE public.app_updates TO authenticated;
GRANT ALL ON TABLE public.app_updates TO service_role;


--
-- Name: TABLE contact_lens_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contact_lens_types TO anon;
GRANT ALL ON TABLE public.contact_lens_types TO authenticated;
GRANT ALL ON TABLE public.contact_lens_types TO service_role;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customers TO anon;
GRANT ALL ON TABLE public.customers TO authenticated;
GRANT ALL ON TABLE public.customers TO service_role;


--
-- Name: TABLE frame_colors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.frame_colors TO anon;
GRANT ALL ON TABLE public.frame_colors TO authenticated;
GRANT ALL ON TABLE public.frame_colors TO service_role;


--
-- Name: TABLE frame_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.frame_types TO anon;
GRANT ALL ON TABLE public.frame_types TO authenticated;
GRANT ALL ON TABLE public.frame_types TO service_role;


--
-- Name: TABLE invoice_counter; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invoice_counter TO anon;
GRANT ALL ON TABLE public.invoice_counter TO authenticated;
GRANT ALL ON TABLE public.invoice_counter TO service_role;


--
-- Name: TABLE lens_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.lens_types TO anon;
GRANT ALL ON TABLE public.lens_types TO authenticated;
GRANT ALL ON TABLE public.lens_types TO service_role;


--
-- Name: TABLE license_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.license_logs TO anon;
GRANT ALL ON TABLE public.license_logs TO authenticated;
GRANT ALL ON TABLE public.license_logs TO service_role;


--
-- Name: TABLE licenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.licenses TO anon;
GRANT ALL ON TABLE public.licenses TO authenticated;
GRANT ALL ON TABLE public.licenses TO service_role;


--
-- Name: TABLE note_seen; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.note_seen TO anon;
GRANT ALL ON TABLE public.note_seen TO authenticated;
GRANT ALL ON TABLE public.note_seen TO service_role;


--
-- Name: TABLE notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notes TO anon;
GRANT ALL ON TABLE public.notes TO authenticated;
GRANT ALL ON TABLE public.notes TO service_role;


--
-- Name: TABLE order_examinations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.order_examinations TO anon;
GRANT ALL ON TABLE public.order_examinations TO authenticated;
GRANT ALL ON TABLE public.order_examinations TO service_role;


--
-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.permissions TO anon;
GRANT ALL ON TABLE public.permissions TO authenticated;
GRANT ALL ON TABLE public.permissions TO service_role;


--
-- Name: TABLE platform_admins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_admins TO anon;
GRANT ALL ON TABLE public.platform_admins TO authenticated;
GRANT ALL ON TABLE public.platform_admins TO service_role;


--
-- Name: TABLE prescriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.prescriptions TO anon;
GRANT ALL ON TABLE public.prescriptions TO authenticated;
GRANT ALL ON TABLE public.prescriptions TO service_role;


--
-- Name: TABLE purchase_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.purchase_items TO anon;
GRANT ALL ON TABLE public.purchase_items TO authenticated;
GRANT ALL ON TABLE public.purchase_items TO service_role;


--
-- Name: TABLE purchase_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.purchase_payments TO anon;
GRANT ALL ON TABLE public.purchase_payments TO authenticated;
GRANT ALL ON TABLE public.purchase_payments TO service_role;


--
-- Name: TABLE purchases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.purchases TO anon;
GRANT ALL ON TABLE public.purchases TO authenticated;
GRANT ALL ON TABLE public.purchases TO service_role;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.role_permissions TO anon;
GRANT ALL ON TABLE public.role_permissions TO authenticated;
GRANT ALL ON TABLE public.role_permissions TO service_role;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.roles TO anon;
GRANT ALL ON TABLE public.roles TO authenticated;
GRANT ALL ON TABLE public.roles TO service_role;


--
-- Name: TABLE sale_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sale_items TO anon;
GRANT ALL ON TABLE public.sale_items TO authenticated;
GRANT ALL ON TABLE public.sale_items TO service_role;


--
-- Name: TABLE sale_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sale_payments TO anon;
GRANT ALL ON TABLE public.sale_payments TO authenticated;
GRANT ALL ON TABLE public.sale_payments TO service_role;


--
-- Name: TABLE settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.settings TO anon;
GRANT ALL ON TABLE public.settings TO authenticated;
GRANT ALL ON TABLE public.settings TO service_role;


--
-- Name: TABLE stock_movements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stock_movements TO anon;
GRANT ALL ON TABLE public.stock_movements TO authenticated;
GRANT ALL ON TABLE public.stock_movements TO service_role;


--
-- Name: TABLE store_licenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.store_licenses TO anon;
GRANT ALL ON TABLE public.store_licenses TO authenticated;
GRANT ALL ON TABLE public.store_licenses TO service_role;


--
-- Name: TABLE stores; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stores TO anon;
GRANT ALL ON TABLE public.stores TO authenticated;
GRANT ALL ON TABLE public.stores TO service_role;


--
-- Name: TABLE suppliers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.suppliers TO anon;
GRANT ALL ON TABLE public.suppliers TO authenticated;
GRANT ALL ON TABLE public.suppliers TO service_role;


--
-- Name: TABLE user_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_permissions TO anon;
GRANT ALL ON TABLE public.user_permissions TO authenticated;
GRANT ALL ON TABLE public.user_permissions TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.users TO anon;
GRANT ALL ON TABLE public.users TO authenticated;
GRANT ALL ON TABLE public.users TO service_role;


--
-- Name: TABLE warehouses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.warehouses TO anon;
GRANT ALL ON TABLE public.warehouses TO authenticated;
GRANT ALL ON TABLE public.warehouses TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict 1SIuhaaATl6YVG0VyhFUFRj3H0GxoZnfKSyxmK6eQpefCbeqJsedsyWRd6tFNl5

