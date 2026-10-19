import { ALL_CODES, resolveCan } from '../src/data/permissionModel'
const sellerSession = new URLSearchParams(location.search).get('qaRole') === 'seller'
const roleAdmin = { id: 'admin-role', name: 'Admin', store_id: 'demo' }
const roleSeller = { id: 'seller-role', name: 'Seller', store_id: 'demo' }
const users = [
  { id: 'demo-admin', username: 'demo-admin', full_name: 'مدير تجريبي', role_id: roleAdmin.id, roles: roleAdmin, store_id: 'demo', is_active: true },
  { id: 'demo-seller', username: 'demo-seller', full_name: 'موظف تجريبي', role_id: roleSeller.id, roles: roleSeller, store_id: 'demo', is_active: true },
]
const grants = new Set(['pos.view','pos.create','customers.view','customers.create','lab.view','history.view'])
const overrides: Record<string,boolean> = {}
const customer = { id: 'demo-customer', name: 'عميل تجريبي', phone: '01000000000', store_id: 'demo' }
const sale = { id: 'demo-sale', invoice_no: 'DEMO029', customer_id: customer.id, customers: customer, user_id: users[0].id, users: users[0], store_id: 'demo', order_date: '2026-10-19T09:00:00Z', delivery_date: '2026-10-20', total_amount: 1000, discount: 0, net_amount: 1000, amount_paid: 300, lab_status: 'Ready', voided_at: null, kind: 'sale', sale_items: [] }
const session = { user: { id: sellerSession ? 'demo-seller' : 'demo-admin', email: 'demo@example.test', user_metadata: { full_name: 'LOCAL DEMO' } }, access_token: 'local-fixture-only' }
class Result {
  constructor(public data: any) {}
  select() { return this } order() { return this } limit() { return this } range() { return this }
  eq(key: string, value: unknown) { if (Array.isArray(this.data)) this.data=this.data.filter(r => r[key]===value); return this }
  in() { return this } or() { return this } not() { return this } ilike() { return this } gte() { return this } lte() { return this } lt() { return this } is() { return this }
  returns() { return this }
  maybeSingle() { this.data=Array.isArray(this.data)?this.data[0]??null:this.data; return this }
  single() { return this.maybeSingle() }
  then(resolve: any, reject: any) { return Promise.resolve({ data: this.data, error: null }).then(resolve,reject) }
}
export const supabase = {
  auth: { getSession: async()=>({data:{session}}), getUser: async()=>({data:{user:session.user},error:null}), onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}), signOut:async()=>({error:null}) },
  from(table: string) {
    const tables: Record<string,unknown> = {
      users, roles:[roleAdmin,roleSeller], role_permissions:[...grants].map(code=>({role_id:roleSeller.id,permissions:{code}})),
      user_permissions:Object.entries(overrides).map(([code,allow])=>({user_id:'demo-seller',allow,permissions:{code}})),
      sales:[sale], customers:[customer], inventory:[{id:'demo-product',name:'إطار تجريبي',category:'Frame',stock_qty:2,sale_price:1000,cost_price:400}],
      sale_payments:[{id:'payment',sale_id:sale.id,method:'cash',amount:sale.amount_paid,kind:'payment',paid_at:sale.order_date}], settings:[], order_examinations:[],
    }
    return new Result(structuredClone(tables[table]??[]))
  },
  rpc(name: string, args: any = {}) {
    if (name==='set_role_permission') { if(args.p_granted) grants.add(args.p_code); else grants.delete(args.p_code); return new Result(null) }
    if (name==='set_user_permission') { if(args.p_allow===null) delete overrides[args.p_code]; else overrides[args.p_code]=args.p_allow; return new Result(null) }
    if (name==='set_lab_status') { sale.lab_status=args.p_status; return new Result(null) }
    if (name==='collect_sale_payment') { sale.amount_paid+=args.p_lines.reduce((s:any,p:any)=>s+p.amount,0); return new Result(null) }
    const data: Record<string,unknown> = {
      my_permissions:{is_admin:!sellerSession,active:true,assigned:true,codes:sellerSession ? ALL_CODES.filter(c=>resolveCan(grants,overrides,c)):ALL_CODES}, auth_store_id:'demo',is_platform_admin:false,
      my_license_state:[{state:'active',plan:'demo',store_name:'LOCAL VISUAL FIXTURE',expires_at:null}],
      schema_version:29, current_schema_version:29, lab_queue:[{sale_id:sale.id,invoice_no:sale.invoice_no,lab_status:sale.lab_status,hours_in_status:28,customer_name:customer.name}],
      store_day_range:[{from_at:'2026-10-19T00:00:00Z',to_at:'2026-10-20T00:00:00Z'}],
      report_sales_window:[{revenue:1000,paid:sale.amount_paid,balance_due:1000-sale.amount_paid,order_count:1,pending_lab:0,ready_lab:1}],
      report_top_customers:[{full_name:customer.name,revenue:1000}],report_voided_count:[{voided_count:0,voided_net:0}],
      search_text:[{kind:'sale',id:sale.id,label:sale.invoice_no,detail:''}],
    }
    return new Result(data[name]??[])
  },
}
