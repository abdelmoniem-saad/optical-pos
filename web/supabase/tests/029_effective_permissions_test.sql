-- Disposable test database only. Every fixture is rolled back.
begin;
select no_plan();
create function a_store() returns uuid language sql as $$select id from public.stores order by created_at limit 1$$;
insert into public.roles(id,name,store_id) values
 ('29000000-0000-4000-8000-000000000001','owner',a_store()),
 ('29000000-0000-4000-8000-000000000002','Access cashier',a_store()),
 ('29000000-0000-4000-8000-000000000003','Access manager',a_store())
on conflict(store_id,name) do nothing;
create function a_owner() returns uuid language sql as $$select id from public.roles where name='owner'$$;
insert into auth.users(id,email) values
 ('29000000-0000-4000-8000-000000000011','owner@access.test'),
 ('29000000-0000-4000-8000-000000000012','cashier@access.test'),
 ('29000000-0000-4000-8000-000000000013','manager@access.test');
insert into public.users(id,username,password_hash,store_id,role_id,is_active) values
 ('29000000-0000-4000-8000-000000000011','access_owner','-',a_store(),a_owner(),true),
 ('29000000-0000-4000-8000-000000000012','access_cashier','-',a_store(),'29000000-0000-4000-8000-000000000002',true),
 ('29000000-0000-4000-8000-000000000013','access_manager','-',a_store(),'29000000-0000-4000-8000-000000000003',true);
insert into public.role_permissions(role_id,permission_id)
select '29000000-0000-4000-8000-000000000002'::uuid,id from public.permissions where code in ('history.view','history.edit','lab.view');
insert into public.role_permissions(role_id,permission_id)
select '29000000-0000-4000-8000-000000000003'::uuid,id from public.permissions where code in ('staff.view','staff.edit','staff.create','staff.delete');
insert into public.sales(id,store_id,invoice_no,total_amount,net_amount,amount_paid,lab_status)
values('29000000-0000-4000-8000-000000000021',a_store(),'ACCESS029',100,100,0,'Not Started');
create function a_as(p uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',p::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',p)::text,true);
end$$;
set role authenticated;
select a_as('29000000-0000-4000-8000-000000000012');
select is(resolve_can('history.edit'),true,'position grant works with View');
select is(resolve_can('lab.edit'),false,'view-only lab user cannot edit');
select is((my_permissions()->>'active')::boolean,true,'authority identifies active staff');
select throws_ok($$select set_lab_status('29000000-0000-4000-8000-000000000021','Ready')$$,'42501',null,'lab write rejected on server');
select lives_ok($$select collect_sale_payment('29000000-0000-4000-8000-000000000021','[{"amount":30,"method":"cash"}]')$$,'authorized collection succeeds');
select is((select amount_paid from sales where invoice_no='ACCESS029'),30::numeric,'ledger refreshes invoice');
select throws_ok($$select collect_sale_payment('29000000-0000-4000-8000-000000000021','[{"amount":80,"method":"cash"}]')$$,'P0001','Payment exceeds balance','overpayment refused');
select throws_ok($$select collect_sale_payment('29000000-0000-4000-8000-000000000021','[{"amount":-10,"method":"cash"}]')$$,'P0001','Invalid payment','refund cannot bypass refund action');
select throws_ok($$update users set role_id=a_owner() where id=auth.uid()$$,'42501',null,'direct self promotion refused');
select throws_ok($$select seed_refund_permission()$$,'42501',null,'revoked grants cannot be reseeded by staff');
select throws_ok($$select seed_closing_permissions()$$,'42501',null,'closing grants cannot be reseeded by staff');
select throws_ok($$select set_user_permission(auth.uid(),'staff.edit',true)$$,'42501',null,'cashier cannot edit overrides');
select a_as('29000000-0000-4000-8000-000000000013');
select is(can_assign_role(a_owner(),a_store()),false,'manager cannot assign administrator');
select throws_ok($$select set_staff_access('29000000-0000-4000-8000-000000000012',a_owner(),true)$$,'P0001','Cannot assign this position','administrator escalation refused');
select throws_ok($$select create_staff_role('  Admin ')$$,'P0001','This position name is reserved','reserved role spelling cannot bypass checks');
select lives_ok($$select set_user_permission('29000000-0000-4000-8000-000000000012','history.edit',false)$$,'explicit Deny saves');
select is(resolve_can('history.edit','29000000-0000-4000-8000-000000000012'),false,'Deny overrides position');
select lives_ok($$select set_user_permission('29000000-0000-4000-8000-000000000012','history.edit',null)$$,'Inherit removes exception');
select is(resolve_can('history.edit','29000000-0000-4000-8000-000000000012'),true,'inherited grant restored');
select lives_ok($$select set_user_permission('29000000-0000-4000-8000-000000000012','lab.edit',true)$$,'Allow exception saves');
select is(resolve_can('lab.edit','29000000-0000-4000-8000-000000000012'),true,'Allow overrides missing grant');
select lives_ok($$select set_role_permission('29000000-0000-4000-8000-000000000002','history.view',false)$$,'View can be removed');
select is(resolve_can('history.edit','29000000-0000-4000-8000-000000000012'),false,'removing View blocks dependent actions');
select a_as('29000000-0000-4000-8000-000000000012');
select throws_ok($$select collect_sale_payment('29000000-0000-4000-8000-000000000021','[{"amount":10,"method":"cash"}]')$$,'42501',null,'revocation takes effect with same JWT');
select lives_ok($$select set_lab_status('29000000-0000-4000-8000-000000000021','Ready')$$,'lab exception enables only lab action');
select a_as('29000000-0000-4000-8000-000000000013');
select lives_ok($$select set_staff_access('29000000-0000-4000-8000-000000000012',null,true)$$,'position removal saves');
select is(resolve_can('lab.edit','29000000-0000-4000-8000-000000000012'),false,'unassigned user cannot retain Allow exception');
select a_as('29000000-0000-4000-8000-000000000012');
select is(auth_store_id(),null::uuid,'unassigned user loses tenant access');
select is((my_permissions()->>'assigned')::boolean,false,'authority reports no assignment');
select a_as('29000000-0000-4000-8000-000000000013');
select lives_ok($$select set_staff_access('29000000-0000-4000-8000-000000000012','29000000-0000-4000-8000-000000000002',false)$$,'deactivation saves');
select a_as('29000000-0000-4000-8000-000000000012');
select is((my_permissions()->>'active')::boolean,false,'inactive staff are denied with same JWT');
select is(jsonb_array_length(my_permissions()->'codes'),0,'inactive staff have no effective codes');
select a_as('29000000-0000-4000-8000-000000000011');
select is(resolve_can('history.refund'),true,'owner has supported refund action');
select is(resolve_can('settings.delete'),false,'unsupported actions stay unsupported');
select throws_ok($$select set_staff_access(auth.uid(),null,false)$$,'P0001','Ask another administrator to change your own access','self lockout refused');
select throws_ok($$select set_role_permission(a_owner(),'history.view',false)$$,'P0001','Owner/admin positions always have full access.','administrator bypass is explicit and immutable');
reset role;
insert into public.stores(id,name) values('29000000-0000-4000-8000-000000000099','Access other shop');
insert into public.platform_admins(auth_uid) values('29000000-0000-4000-8000-000000000011');
set role authenticated;
select lives_ok($$insert into public.roles(name,store_id) values('Admin','29000000-0000-4000-8000-000000000099')$$,'platform can create a second store Admin role');
select a_as('29000000-0000-4000-8000-000000000013');
select is(can_assign_role((select id from public.roles where name='Admin' and store_id=a_store()),'29000000-0000-4000-8000-000000000099'),false,'role assignment cannot cross stores');
reset role;
select * from finish();
rollback;
