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
  v_in   public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale public.sales;
begin
  insert into public.sales
    (invoice_no, customer_id, user_id, total_amount, discount, net_amount,
     amount_paid, payment_method, order_date, doctor_name, lab_status)
  values
    (v_in.invoice_no, v_in.customer_id, v_in.user_id, v_in.total_amount,
     v_in.discount, v_in.net_amount, v_in.amount_paid,
     coalesce(v_in.payment_method, 'Cash'), v_in.order_date,
     v_in.doctor_name, v_in.lab_status)
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
     frame_color, frame_status, image_path)
  select v_sale.id, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info,
         r.frame_info, r.frame_color, r.frame_status, r.image_path
  from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  return v_sale;
end$$;

grant execute on function public.create_sale_order(jsonb, jsonb, jsonb) to authenticated;
