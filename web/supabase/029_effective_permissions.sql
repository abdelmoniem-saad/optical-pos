-- Effective access, atomic permission edits and action enforcement.
-- Apply after 028; safe to re-run. The UI uses my_permissions() as authority.
begin;

-- The platform creates Admin/Seller in each shop, so names are tenant-local.
alter table public.roles drop constraint if exists roles_name_key;
create unique index if not exists roles_store_name_unique on public.roles(store_id,name);

create or replace function public.supported_permissions() returns text[]
language sql immutable set search_path = public as $$
  select array[
    'pos.view','pos.create','pos.edit',
    'customers.view','customers.create','customers.edit','customers.delete',
    'inventory.view','inventory.create','inventory.edit',
    'lab.view','lab.edit','history.view','history.edit','history.void','history.refund',
    'reports.view','closing.view','closing.edit',
    'suppliers.view','suppliers.create','suppliers.edit','suppliers.delete',
    'notes.view','notes.create','notes.edit','notes.delete',
    'staff.view','staff.create','staff.edit','staff.delete','settings.view','settings.edit'
  ]::text[]
$$;
insert into public.permissions(code)
select unnest(public.supported_permissions()) on conflict(code) do nothing;

-- Old purchase-only grants become visible in the existing Suppliers matrix.
insert into public.role_permissions(role_id, permission_id)
select rp.role_id, np.id from public.role_permissions rp
join public.permissions op on op.id = rp.permission_id
join public.permissions np on np.code = replace(op.code, 'purchases.', 'suppliers.')
where op.code like 'purchases.%' on conflict do nothing;

insert into public.user_permissions(user_id, permission_id, allow)
select up.user_id, np.id, up.allow from public.user_permissions up
join public.permissions op on op.id = up.permission_id
join public.permissions np on np.code = replace(op.code, 'purchases.', 'suppliers.')
where op.code like 'purchases.%' on conflict do nothing;

-- Remove migrated aliases so a rerun cannot resurrect a later revocation.
delete from public.role_permissions rp using public.permissions p
where rp.permission_id=p.id and p.code like 'purchases.%';
delete from public.user_permissions up using public.permissions p
where up.permission_id=p.id and p.code like 'purchases.%';

create or replace function public.is_store_admin(p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select (p_user = auth.uid() and public.is_platform_admin()) or exists(
    select 1 from public.users u join public.roles r on r.id = u.role_id and r.store_id = u.store_id
    where u.id = p_user and u.is_active is true and lower(trim(r.name)) in ('admin','owner')
  )
$$;

create or replace function public.resolve_can(p_code text, p_user uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_code text := replace(p_code, 'purchases.', 'suppliers.'); v_role uuid; v_view text; v_allowed boolean;
begin
  if not (v_code = any(public.supported_permissions())) then return false; end if;
  if p_user = auth.uid() and public.is_platform_admin() then return true; end if;
  select u.role_id into v_role from public.users u
    join public.roles r on r.id = u.role_id and r.store_id = u.store_id
    where u.id = p_user and u.is_active is true;
  if v_role is null then return false; end if;
  if public.is_store_admin(p_user) then return true; end if;
  select coalesce(
    (select up.allow from public.user_permissions up join public.permissions p on p.id=up.permission_id where up.user_id=p_user and p.code=v_code),
    exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id where rp.role_id=v_role and p.code=v_code)
  ) into v_allowed;
  if not v_allowed then return false; end if;
  v_view := split_part(v_code,'.',1) || '.view';
  if v_code = v_view then return true; end if;
  return public.resolve_can(v_view, p_user);
end $$;

-- Inactive/unassigned identities cannot keep using tenant policies with an old JWT.
create or replace function public.auth_store_id() returns uuid
language sql stable security definer set search_path = public as $$
  select u.store_id from public.users u
  join public.roles r on r.id = u.role_id and r.store_id = u.store_id
  where u.id = auth.uid() and u.is_active is true
$$;

create or replace function public.my_permissions() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_admin', coalesce(public.is_store_admin(),false),
    'active', public.is_platform_admin() or exists(select 1 from public.users where id=auth.uid() and is_active is true),
    'assigned', public.is_platform_admin() or public.auth_store_id() is not null,
    'codes', coalesce((select jsonb_agg(c) from unnest(public.supported_permissions()) c where public.resolve_can(c)), '[]'::jsonb)
  )
$$;

-- Assignment validation is also called by create-user AS THE CALLER before it
-- uses its service-role client. A staff editor cannot mint an owner or vendor.
create or replace function public.can_assign_role(p_role uuid, p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.is_platform_admin() or
    (public.resolve_can('staff.edit') and p_store=public.auth_store_id() and public.license_write_ok(p_store)))
    and exists(select 1 from public.roles r where r.id=p_role and r.store_id=p_store
      and (lower(trim(r.name)) not in ('admin','owner') or public.is_store_admin())), false)
$$;

create or replace function public.require_staff_editor(p_store uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_perm('staff.edit');
  if p_store is null or (not public.is_platform_admin() and
    (p_store is distinct from public.auth_store_id() or not public.license_write_ok(p_store))) then
    raise exception 'Cannot change access in this store' using errcode='42501';
  end if;
end $$;

create or replace function public.create_staff_role(p_name text) returns public.roles
language plpgsql security definer set search_path = public as $$
declare v public.roles; v_store uuid := public.auth_store_id();
begin
  perform public.require_staff_editor(v_store);
  if nullif(trim(p_name),'') is null then raise exception 'Name is required'; end if;
  if lower(trim(p_name)) in ('admin','owner','superadmin') then raise exception 'This position name is reserved'; end if;
  if exists(select 1 from public.roles where store_id=v_store and lower(trim(name))=lower(trim(p_name))) then
    raise exception 'This position already exists';
  end if;
  insert into public.roles(name,store_id) values(trim(p_name),v_store) returning * into v;
  return v;
end $$;

create or replace function public.set_role_permission(p_role uuid, p_code text, p_granted boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v public.roles; pid uuid;
begin
  select * into v from public.roles where id=p_role for update;
  if not found then raise exception 'Position not found'; end if;
  perform public.require_staff_editor(v.store_id);
  if lower(trim(v.name)) in ('admin','owner') then raise exception 'Owner/admin positions always have full access.'; end if;
  if not(p_code=any(public.supported_permissions())) or p_granted is null then raise exception 'Unsupported permission'; end if;
  -- Changing your own role must not remove access to its editor.
  if not p_granted and p_code in ('staff.view','staff.edit') and exists(
    select 1 from public.users where id=auth.uid() and role_id=p_role) then
    raise exception 'Ask another administrator to change your own access';
  end if;
  select id into pid from public.permissions where code=p_code;
  if p_granted then
    insert into public.role_permissions(role_id,permission_id) values(p_role,pid) on conflict do nothing;
  else
    delete from public.role_permissions where role_id=p_role and permission_id=pid;
  end if;
end $$;

create or replace function public.set_user_permission(p_user uuid, p_code text, p_allow boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v public.users; pid uuid;
begin
  select * into v from public.users where id=p_user for update;
  if not found then raise exception 'Employee not found'; end if;
  perform public.require_staff_editor(v.store_id);
  if p_user=auth.uid() then raise exception 'Ask another administrator to change your own access'; end if;
  if public.is_store_admin(p_user) or exists(select 1 from public.platform_admins where auth_uid=p_user) then
    raise exception 'Change this person to a regular position before setting exceptions';
  end if;
  if not(p_code=any(public.supported_permissions())) then raise exception 'Unsupported permission'; end if;
  select id into pid from public.permissions where code=p_code;
  if p_allow is null then delete from public.user_permissions where user_id=p_user and permission_id=pid;
  else insert into public.user_permissions(user_id,permission_id,allow) values(p_user,pid,p_allow)
    on conflict(user_id,permission_id) do update set allow=excluded.allow;
  end if;
end $$;

create or replace function public.set_staff_access(p_user uuid, p_role uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v public.users;
begin
  -- Serialise management changes in a store, including demotions.
  perform 1 from public.stores where id=public.auth_store_id() for update;
  select * into v from public.users where id=p_user for update;
  if not found then raise exception 'Employee not found'; end if;
  perform public.require_staff_editor(v.store_id);
  if p_user=auth.uid() then raise exception 'Ask another administrator to change your own access'; end if;
  if exists(select 1 from public.platform_admins where auth_uid=p_user) then raise exception 'Platform accounts are managed separately'; end if;
  if public.is_store_admin(p_user) and not public.is_store_admin() then raise exception 'Only an administrator can change administrator access'; end if;
  if p_role is not null and not public.can_assign_role(p_role,v.store_id) then raise exception 'Cannot assign this position'; end if;
  if p_active is null then raise exception 'Active state is required'; end if;
  if p_active is distinct from v.is_active then perform public.require_perm('staff.delete'); end if;
  update public.users set role_id=p_role,is_active=p_active where id=p_user;
end $$;

-- Management writes go through the checked RPCs: zero-row RLS updates must
-- never be reported as successful permission changes.
revoke insert,update,delete on public.roles,public.users,public.role_permissions,public.user_permissions from authenticated,anon;
-- Keep the existing platform onboarding path. Ordinary staff still use RPCs.
grant insert on public.roles,public.role_permissions to authenticated;
drop policy if exists lensy_platform_role_insert on public.roles;
create policy lensy_platform_role_insert on public.roles as restrictive for insert to authenticated
  with check(public.is_platform_admin());
drop policy if exists lensy_platform_grant_insert on public.role_permissions;
create policy lensy_platform_grant_insert on public.role_permissions as restrictive for insert to authenticated
  with check(public.is_platform_admin());
revoke execute on function public.seed_refund_permission() from public,anon,authenticated;
revoke execute on function public.seed_closing_permissions() from public,anon,authenticated;
revoke execute on function public.require_staff_editor(uuid) from public,anon,authenticated;
revoke execute on function public.my_permissions(),public.create_staff_role(text),
  public.set_role_permission(uuid,text,boolean),public.set_user_permission(uuid,text,boolean),
  public.set_staff_access(uuid,uuid,boolean),public.can_assign_role(uuid,uuid),public.is_store_admin(uuid)
  from public,anon;
grant execute on function public.my_permissions(),public.create_staff_role(text),
  public.set_role_permission(uuid,text,boolean),public.set_user_permission(uuid,text,boolean),
  public.set_staff_access(uuid,uuid,boolean),public.can_assign_role(uuid,uuid),public.is_store_admin(uuid)
  to authenticated;

-- Additional action policies are RESTRICTIVE, so the existing tenant/license
-- policies remain mandatory. Reads can be shared by related workflows; View
-- governs entering the page and is a prerequisite for each of its actions.
do $$
declare x record; op text; rule text;
begin
  for x in select * from (values
    ('customers','customers.create','customers.edit','customers.delete'),
    ('inventory','inventory.create','inventory.edit',null),
    ('suppliers','suppliers.create','suppliers.edit','suppliers.delete'),
    ('purchases','suppliers.create','suppliers.edit',null),
    ('purchase_items','suppliers.create','suppliers.edit',null),
    ('purchase_payments','suppliers.edit','suppliers.edit',null),
    ('notes','notes.create','notes.edit','notes.delete'),
    ('settings','settings.edit','settings.edit','settings.edit'),
    ('lens_types','inventory.edit','inventory.edit','inventory.edit'),
    ('frame_colors','inventory.edit','inventory.edit','inventory.edit'),
    ('frame_types','inventory.edit','inventory.edit','inventory.edit'),
    ('stock_movements','inventory.edit',null,null)
  ) as m(tbl,ins,upd,del) loop
    foreach op in array array['insert','update','delete'] loop
      rule := case op when 'insert' then x.ins when 'update' then x.upd else x.del end;
      execute format('drop policy if exists lensy_action_%s on public.%I',op,x.tbl);
      if rule is null then rule := 'false'; else rule := format('public.resolve_can(%L)',rule); end if;
      if op='insert' then
        execute format('create policy lensy_action_insert on public.%I as restrictive for insert to authenticated with check (%s)',x.tbl,rule);
      elsif op='update' then
        execute format('create policy lensy_action_update on public.%I as restrictive for update to authenticated using (%s) with check (%s)',x.tbl,rule,rule);
      else
        execute format('create policy lensy_action_delete on public.%I as restrictive for delete to authenticated using (%s)',x.tbl,rule);
      end if;
    end loop;
  end loop;
end $$;

-- More checked workflow functions and the migration stamp follow below.

-- Checked entry points. Client writes cannot bypass these functions.

create or replace function public.create_sale_order(
  p_sale            jsonb,
  p_items           jsonb default '[]'::jsonb,
  p_exams           jsonb default '[]'::jsonb,
  p_payments        jsonb default '[]'::jsonb,
  p_idempotency_key uuid  default null
) returns public.sales
language plpgsql
security definer
set search_path = public as $$
declare
  v_in       public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale     public.sales;
  v_store    uuid;
  v_inv      text;
  v_allow    boolean;
  v_paid_hdr numeric;
  v_paid_led numeric;
  v_kind     text := 'sale';
  t          record;
begin
  if (p_sale->>'customer_id') is not null and not exists(select 1 from public.customers where id=(p_sale->>'customer_id')::uuid and store_id=public.auth_store_id()) then raise exception 'Customer not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as i(product_id uuid) where i.product_id is not null and not exists(select 1 from public.inventory where id=i.product_id and store_id=public.auth_store_id())) then raise exception 'Product not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(amount numeric) where p.amount < 0) then raise exception 'Use the refund action to return money'; end if;
  perform public.require_perm('pos.create');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  -- Idempotency: a replayed checkout returns the sale it already created.
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

  select * into t
    from public.price_cart(p_items, coalesce(v_in.net_amount,
                                             coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0)),
                           v_allow);

  -- money in can never exceed money out
  v_paid_hdr := coalesce(v_in.amount_paid, 0);
  if v_paid_hdr < -0.01 then
    raise exception 'negative payment amount';
  end if;
  select coalesce(sum(r.amount), 0) into v_paid_led
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount > 0;
  if v_paid_hdr > t.net_amount + 0.01 or v_paid_led > t.net_amount + 0.01 then
    raise exception 'payment exceeds net amount';
  end if;

  -- NEW IN 022. The kind, decided here rather than believed.
  --
  -- create_sale_order exists because it does not trust the browser, and
  -- jsonb_populate_record would happily copy a client-sent `kind` of anything at
  -- all - including a value the check constraint does not even accept. So it is
  -- whitelisted here, and a prescription is defined by the CART rather than by
  -- the claim: nothing worth charging, and no money in. That second condition is
  -- what closes the tamper that matters. A whitelist alone would let a client
  -- claim `prescription` on a real order and drop it out of order_count, hiding a
  -- sale. t.total_amount is the gross the catalog says the cart is worth, so a
  -- real order - even one discounted 100% to zero net - is still gross > 0 and
  -- stays a sale.
  if v_in.kind = 'prescription'
     and t.total_amount = 0
     and not exists (
       select 1 from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
        where r.amount is not null and r.amount <> 0)
  then
    v_kind := 'prescription';
  end if;

  -- invoice number: the wizard's reservation when still free, else the counter
  v_inv := nullif(trim(v_in.invoice_no), '');
  if v_inv is not null and exists (select 1 from public.sales where invoice_no = v_inv) then
    v_inv := null;
  end if;
  if v_inv is null then
    v_inv := public.next_invoice_no();
  end if;

  begin
    insert into public.sales
      (invoice_no, store_id, idempotency_key, customer_id, user_id,
       total_amount, discount, net_amount, amount_paid, payment_method,
       order_date, delivery_date, doctor_name, lab_status,
       rx_image_path, frame_image_path, kind)
    values
      (v_inv, v_store, p_idempotency_key, v_in.customer_id, auth.uid(),
       t.total_amount, t.discount, t.net_amount, v_paid_hdr,
       coalesce(v_in.payment_method, 'Cash'),
       coalesce(v_in.order_date, now()), v_in.delivery_date, v_in.doctor_name,
       v_in.lab_status, v_in.rx_image_path, v_in.frame_image_path, v_kind)
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

  -- lines at CATALOG prices, with the line discount kept alongside
  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name,
     discount, discount_reason)
  select v_sale.id, v_store, r.product_id, r.qty,
         (t.prices ->> r.product_id::text)::numeric,
         r.qty * (t.prices ->> r.product_id::text)::numeric,
         r.name, coalesce(r.discount, 0), r.discount_reason
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_store, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select v_sale.id, v_store, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_in.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select v_sale.id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         coalesce(nullif(lower(trim(r.kind)), ''), 'payment'),
         r.note,
         coalesce(r.paid_at, now()),
         v_store,
         auth.uid()
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount <> 0;

  return v_sale;
end $$;

create or replace function public.update_sale_order(
  p_sale_id  uuid,
  p_sale     jsonb,
  p_items    jsonb default '[]'::jsonb,
  p_exams    jsonb default '[]'::jsonb,
  p_payments jsonb default '[]'::jsonb
) returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_in       public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale     public.sales;
  v_store    uuid;
  v_allow    boolean;
  v_paid     numeric;
  t          record;
begin
  if (p_sale->>'customer_id') is not null and not exists(select 1 from public.customers where id=(p_sale->>'customer_id')::uuid and store_id=public.auth_store_id()) then raise exception 'Customer not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as i(product_id uuid) where i.product_id is not null and not exists(select 1 from public.inventory where id=i.product_id and store_id=public.auth_store_id())) then raise exception 'Product not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(amount numeric) where p.amount < 0) then raise exception 'Use the refund action to return money'; end if;
  if not (public.resolve_can('pos.edit') or public.resolve_can('history.edit')) then raise exception 'insufficient permission: history.edit or pos.edit' using errcode='42501'; end if;
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;
  if not (select public.license_write_ok(v_store)) and not public.is_platform_admin() then
    raise exception 'store licence does not allow writes';
  end if;

  select * into v_sale
    from public.sales
   where id = p_sale_id
     for update;
  if not found then
    raise exception 'sale not found';
  end if;
  if v_sale.store_id is distinct from v_store and not public.is_platform_admin() then
    raise exception 'sale belongs to another store';
  end if;
  if v_sale.voided_at is not null then
    raise exception 'sale is voided and can no longer be edited';
  end if;
  if (case when jsonb_array_length(p_exams)>0 then coalesce(v_in.lab_status,'Not Started') else null end)
    is distinct from v_sale.lab_status then perform public.require_perm('lab.edit'); end if;
  if not public.is_store_admin() and
    ((v_sale.rx_image_path is not null and v_in.rx_image_path is distinct from v_sale.rx_image_path) or
     (v_sale.frame_image_path is not null and v_in.frame_image_path is distinct from v_sale.frame_image_path)) then
    raise exception 'Replace requires admin' using errcode='42501';
  end if;

  select s.allow_negative_stock into v_allow
    from public.stores s
   where s.id = v_store;
  if v_allow is null then
    v_allow := true;
  end if;

  select * into t
    from public.price_cart(p_items, coalesce(v_in.net_amount,
                                             coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0)),
                           v_allow);

  v_paid := coalesce((
    select sum(r.amount)
      from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
     where r.amount is not null and r.amount <> 0
  ), 0);
  if v_paid < -0.01 then
    raise exception 'negative payment amount';
  end if;
  if v_paid > t.net_amount + 0.01 then
    raise exception 'payment exceeds net amount';
  end if;
  if v_paid < coalesce(v_sale.amount_paid,0) then perform public.require_perm('history.refund'); end if;

  -- Replace, in one transaction. The stock movements are matched on the
  -- sale's own movements (type 'sale' + ref_no), so a re-checkout nets out
  -- exactly the previous lines.
  delete from public.sale_items         where sale_id = p_sale_id;
  delete from public.order_examinations where sale_id = p_sale_id;
  delete from public.sale_payments      where sale_id = p_sale_id;
  delete from public.stock_movements
   where type = 'sale' and ref_no = v_sale.invoice_no and store_id = v_sale.store_id;

  perform set_config('lensy.money_write', '1', true);
  update public.sales
     set total_amount = t.total_amount,
         discount     = t.discount,
         net_amount   = t.net_amount,
         payment_method = coalesce(v_in.payment_method, v_sale.payment_method),
         customer_id  = coalesce(v_in.customer_id, v_sale.customer_id),
         doctor_name  = coalesce(v_in.doctor_name, v_sale.doctor_name),
         delivery_date = v_in.delivery_date,
         lab_status   = case
                          when jsonb_array_length(p_exams) > 0 then coalesce(v_in.lab_status, 'Not Started')
                          else null
                        end,
         rx_image_path  = v_in.rx_image_path,
         frame_image_path = v_in.frame_image_path
   where id = p_sale_id
  returning * into v_sale;

  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name,
     discount, discount_reason)
  select p_sale_id, v_sale.store_id, r.product_id, r.qty,
         (t.prices ->> r.product_id::text)::numeric,
         r.qty * (t.prices ->> r.product_id::text)::numeric,
         r.name, coalesce(r.discount, 0), r.discount_reason
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_sale.store_id, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select p_sale_id, v_sale.store_id, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_sale.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select p_sale_id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         coalesce(nullif(lower(trim(r.kind)), ''), 'payment'),
         r.note,
         coalesce(r.paid_at, now()),
         v_sale.store_id,
         auth.uid()
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount <> 0;

  perform set_config('lensy.money_write', '', true);

  -- the ledger's own sync trigger has already recomputed amount_paid; re-read
  -- so the caller gets the authoritative header back.
  select * into v_sale from public.sales where id = p_sale_id;
  return v_sale;
end $$;

create or replace function public.add_inventory_item(
  p_product       jsonb,
  p_initial_stock integer default 0
) returns public.inventory
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.inventory;
begin
  perform public.require_perm('inventory.create');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
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

create or replace function public.receive_purchase(p_purchase uuid)
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_store  uuid;
  v_count  integer := 0;
  v_row    record;
begin
  perform public.require_perm('suppliers.edit');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  -- Tenancy: the purchase must belong to the caller's store. A platform admin
  -- may receive for any store, which is the only cross-tenant path.
  select p.store_id into v_store
    from public.purchases p
   where p.id = p_purchase;

  if v_store is null then
    raise exception 'purchase not found: %', p_purchase using errcode = 'P0002';
  end if;

  if not public.is_platform_admin() and v_store <> public.auth_store_id() then
    raise exception 'purchase belongs to another store'
      using errcode = '42501';
  end if;
  if not public.license_write_ok(v_store) then
    raise exception 'store licence does not allow writes' using errcode = '42501';
  end if;

  -- Receive every outstanding line. The row lock serialises two cashiers
  -- receiving the same shipment at once: the second one waits, then re-reads
  -- received_at and finds the lines already stamped, so the stock is counted
  -- once. Without it this is a lost-update race, not a theoretical one.
  for v_row in
    select pi.id, pi.product_id, pi.qty, pi.unit_cost, pi.total_cost
      from public.purchase_items pi
     where pi.purchase_id = p_purchase
       and pi.received_at is null
       and pi.product_id is not null
     for update
  loop
    if coalesce(v_row.qty, 0) <= 0 then
      raise exception 'cannot receive a non-positive quantity (item %)', v_row.id
        using errcode = '22023';
    end if;

    insert into public.stock_movements
      (product_id, qty, type, kind, ref_no, note, created_at, store_id)
    values (
      v_row.product_id,
      v_row.qty,                                  -- positive: goods arrive
      'purchase',
      'purchase',                                 -- vocabulary from 013
      p_purchase::text,
      format('Received from purchase %s', p_purchase),
      now(),
      v_store
    );

    -- The cost is what makes margin real. The item's cost_price becomes a
    -- WEIGHTED AVERAGE across what was already held, so a re-order at a new
    -- price does not retroactively change the margin of stock bought earlier.
    -- Only when the shelf is empty does it simply take the new cost.
    update public.inventory
       set cost_price = case
             when coalesce(stock_qty, 0) > 0
               then round(
                      ( coalesce(stock_qty, 0) * coalesce(cost_price, 0)
                        + coalesce(v_row.qty, 0) * coalesce(v_row.unit_cost, 0)
                      ) / ( coalesce(stock_qty, 0) + coalesce(v_row.qty, 0) )::numeric
                    , 2)
             else coalesce(v_row.unit_cost, cost_price)
           end
     where id = v_row.product_id
       and store_id = v_store;

    update public.purchase_items
       set received_at = now()
     where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.delete_purchase(p_purchase uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_count integer;
begin
  perform public.require_perm('suppliers.delete');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  perform public.require_perm('purchases.delete');
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  v_store := public.auth_store_id();
  if not (select public.license_write_ok(v_store)) and not public.is_platform_admin() then
    raise exception 'store licence does not allow writes';
  end if;
  if not exists (
    select 1 from public.purchases
     where id = p_purchase
       and (store_id = v_store or public.is_platform_admin())
  ) then
    raise exception 'purchase not found in this store';
  end if;

  delete from public.purchase_items     where purchase_id = p_purchase;
  delete from public.purchase_payments where purchase_id = p_purchase;
  delete from public.purchases          where id = p_purchase;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.delete_purchase_payment(p_payment uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_count integer;
begin
  perform public.require_perm('suppliers.edit');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  perform public.require_perm('purchases.edit');
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  v_store := public.auth_store_id();
  if not (select public.license_write_ok(v_store)) and not public.is_platform_admin() then
    raise exception 'store licence does not allow writes';
  end if;
  if not exists (
    select 1
      from public.purchase_payments pp
      join public.purchases p on p.id = pp.purchase_id
     where pp.id = p_payment
       and (p.store_id = v_store or public.is_platform_admin())
  ) then
    raise exception 'payment not found in this store';
  end if;

  delete from public.purchase_payments where id = p_payment;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke insert,update,delete on public.sale_items,public.order_examinations from authenticated,anon;
revoke insert,delete on public.sales from authenticated,anon;
revoke execute on function public.create_sale_order(jsonb,jsonb,jsonb,jsonb,uuid),
 public.update_sale_order(uuid,jsonb,jsonb,jsonb,jsonb),public.add_inventory_item(jsonb,integer),
 public.receive_purchase(uuid),public.delete_purchase(uuid),public.delete_purchase_payment(uuid) from public,anon;
grant execute on function public.create_sale_order(jsonb,jsonb,jsonb,jsonb,uuid),
 public.update_sale_order(uuid,jsonb,jsonb,jsonb,jsonb),public.add_inventory_item(jsonb,integer),
 public.receive_purchase(uuid),public.delete_purchase(uuid),public.delete_purchase_payment(uuid) to authenticated;

create or replace function public.set_lab_status(p_sale uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_perm('lab.edit');
  if not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  if p_status not in ('Not Started','In Lab','Ready','Received') or p_status is null then raise exception 'Invalid lab status'; end if;
  update public.sales set lab_status=p_status where id=p_sale and store_id=public.auth_store_id() and voided_at is null and lab_status is not null;
  if not found then raise exception 'Active lab order not found'; end if;
end $$;

create or replace function public.replace_order_examinations(p_sale uuid,p_exams jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v public.sales;
begin
  perform public.require_perm('history.edit');
  if not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  select * into v from public.sales where id=p_sale and store_id=public.auth_store_id() and voided_at is null for update;
  if not found then raise exception 'Active invoice not found'; end if;
  delete from public.order_examinations where sale_id=p_sale;
  insert into public.order_examinations(sale_id,store_id,exam_type,sphere_od,cylinder_od,axis_od,sphere_os,cylinder_os,axis_os,ipd,lens_info,frame_info,frame_color,frame_status,doctor_name,image_path)
  select p_sale,v.store_id,r.exam_type,r.sphere_od,r.cylinder_od,r.axis_od,r.sphere_os,r.cylinder_os,r.axis_os,r.ipd,r.lens_info,r.frame_info,r.frame_color,r.frame_status,r.doctor_name,r.image_path
  from jsonb_populate_recordset(null::public.order_examinations,p_exams) r;
end $$;

-- Direct header edits may change only the fields offered by History. Lab-only
-- staff use set_lab_status(), so they cannot rewrite an invoice via PATCH.
create or replace function public.guard_sale_access() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  perform public.require_perm('history.edit');
  if old.voided_at is not null then raise exception 'A voided invoice cannot be edited'; end if;
  if (to_jsonb(new) - array['doctor_name','delivery_date','rx_image_path','frame_image_path','lab_status','lab_status_changed_at','lab_started_at','lab_started_by','lab_ready_at'])
     is distinct from (to_jsonb(old) - array['doctor_name','delivery_date','rx_image_path','frame_image_path','lab_status','lab_status_changed_at','lab_started_at','lab_started_by','lab_ready_at']) then
    raise exception 'Use the checkout or refund action to change this invoice' using errcode='42501';
  end if;
  if new.lab_status is distinct from old.lab_status then perform public.require_perm('lab.edit'); end if;
  if not public.is_store_admin() and
    ((old.rx_image_path is not null and new.rx_image_path is distinct from old.rx_image_path) or
     (old.frame_image_path is not null and new.frame_image_path is distinct from old.frame_image_path)) then
    raise exception 'Replace requires admin' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists aa_sale_access on public.sales;
create trigger aa_sale_access before update on public.sales for each row execute function public.guard_sale_access();
drop policy if exists lensy_action_update on public.sales;
create policy lensy_action_update on public.sales as restrictive for update to authenticated
  using(public.resolve_can('history.edit')) with check(public.resolve_can('history.edit'));

-- Payment collection is one invoice-locked transaction. Direct ledger inserts
-- are revoked, including negative/refund inserts and forged store references.
create or replace function public.collect_sale_payment(p_sale uuid,p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v public.sales; v_total numeric;
begin
  perform public.require_perm('history.edit');
  if not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
  select * into v from public.sales where id=p_sale and store_id=public.auth_store_id() and voided_at is null for update;
  if not found then raise exception 'Active invoice not found'; end if;
  if jsonb_array_length(p_lines)=0 or exists(select 1 from jsonb_to_recordset(p_lines) as p(amount numeric,method text)
    where p.amount is null or p.amount<=0 or p.method not in ('cash','wallet','instapay','card') or p.method is null) then
    raise exception 'Invalid payment';
  end if;
  select sum(p.amount) into v_total from jsonb_to_recordset(p_lines) as p(amount numeric);
  if v_total > coalesce(v.net_amount,0)-coalesce(v.amount_paid,0) then raise exception 'Payment exceeds balance'; end if;
  insert into public.sale_payments(sale_id,store_id,amount,method,kind,paid_at,recorded_by)
  select p_sale,v.store_id,p.amount,p.method,'payment',now(),auth.uid()
  from jsonb_to_recordset(p_lines) as p(amount numeric,method text);
end $$;
revoke insert,update,delete on public.sale_payments from authenticated,anon;

-- Private notes stay private; edit/delete also require their real action grant.
drop policy if exists lensy_note_visibility on public.notes;
create policy lensy_note_visibility on public.notes as restrictive for select to authenticated
  using(public.resolve_can('notes.view') and (user_id is null or user_id=auth.uid()));
drop policy if exists lensy_note_author_insert on public.notes;
create policy lensy_note_author_insert on public.notes as restrictive for insert to authenticated
  with check(created_by=auth.uid() and (user_id is null or user_id=auth.uid()));
drop policy if exists lensy_note_author_update on public.notes;
create policy lensy_note_author_update on public.notes as restrictive for update to authenticated
  using(created_by=auth.uid()) with check(created_by=auth.uid());
drop policy if exists lensy_note_author_delete on public.notes;
create policy lensy_note_author_delete on public.notes as restrictive for delete to authenticated
  using(created_by=auth.uid() or public.is_store_admin());

revoke execute on function public.set_lab_status(uuid,text),public.replace_order_examinations(uuid,jsonb),
  public.collect_sale_payment(uuid,jsonb) from public,anon;
grant execute on function public.set_lab_status(uuid,text),public.replace_order_examinations(uuid,jsonb),
  public.collect_sale_payment(uuid,jsonb) to authenticated;

select public.record_schema_version(29,'effective permissions, checked staff administration and workflow actions');
commit;
