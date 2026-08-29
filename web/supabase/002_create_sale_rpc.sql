-- LensyPOS — atomic checkout
-- ===========================
-- Wraps the whole POS checkout (sale header + line items + stock movements +
-- examinations) in ONE transaction. If any step fails the whole thing rolls
-- back, so you can never get a half-written order. The web app calls this via
-- supabase.rpc('create_sale_order', ...) and falls back to client-side inserts
-- only if this function isn't installed yet.
--
-- Uses jsonb_populate_record(set) so column TYPES are taken from the live table
-- definitions — no hardcoded casts to drift out of sync.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run. Safe to re-run.

create or replace function public.create_sale_order(
  p_sale  jsonb,
  p_items jsonb default '[]'::jsonb,
  p_exams jsonb default '[]'::jsonb
) returns public.sales
language plpgsql
security invoker
as $$
declare
  v_in      public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale    public.sales;
  v_inv     text := v_in.invoice_no;
  v_max_num int;
begin
  -- If invoice_no is null, empty, or already taken, compute next available 6-digit invoice
  if v_inv is null or trim(v_inv) = '' or exists (select 1 from public.sales where invoice_no = v_inv) then
    select coalesce(max(
      case
        when invoice_no ~ '^\d+$' then invoice_no::int
        else 0
      end
    ), 0) + 1
    into v_max_num
    from public.sales;

    loop
      v_inv := lpad(v_max_num::text, 6, '0');
      exit when not exists (select 1 from public.sales where invoice_no = v_inv);
      v_max_num := v_max_num + 1;
    end loop;
  end if;

  insert into public.sales
    (invoice_no, customer_id, user_id, total_amount, discount, net_amount,
     amount_paid, payment_method, order_date, delivery_date, doctor_name, lab_status)
  values
    (v_inv, v_in.customer_id, v_in.user_id, v_in.total_amount,
     v_in.discount, v_in.net_amount, v_in.amount_paid,
     coalesce(v_in.payment_method, 'Cash'), coalesce(v_in.order_date, now()),
     v_in.delivery_date, v_in.doctor_name, v_in.lab_status)
  returning * into v_sale;

  -- line items
  insert into public.sale_items (sale_id, product_id, qty, unit_price, total_price, name)
  select v_sale.id, r.product_id, r.qty, r.unit_price, r.total_price, r.name
  from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- one negative stock movement per line
  insert into public.stock_movements (product_id, qty, type, ref_no, note, created_at)
  select r.product_id, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
  from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- examinations
  insert into public.order_examinations
    (sale_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select v_sale.id, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info,
         r.frame_info, r.frame_color, r.frame_status, coalesce(r.doctor_name, v_sale.doctor_name), r.image_path
  from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  return v_sale;
end$$;

grant execute on function public.create_sale_order(jsonb, jsonb, jsonb) to authenticated;
