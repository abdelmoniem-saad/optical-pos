-- ===========================================================================
-- 034 - register ingest: the cloud replays the register PC's op log
--       (offline-v2 Phase 1b, docs/offline-v2/design.md sections 3 and 4.4)
--
-- !! WORKING NUMBER - NOT APPLIED UNTIL PHASE 4 !!
--    034 is written and tested now but stays on its branch until the Phase 4
--    end-to-end parity test is green (design 4 preamble, 4.4). When applied it
--    takes the next free number, together with its record_schema_version
--    stamp, its test files and the register build's EXPECTED_SCHEMA_VERSION.
--    Paste it only AFTER 033 (it follows 033's token contract, part 4).
--
-- 034 CHANGES NO EXISTING BEHAVIOUR for a store that is not register_only:
-- my_license_state() and license_feature() are re-pointed onto store-
-- parameterised internals with the same answers, and everything else is new.
--
-- BUILT IN THREE STEPS (one file). Step 1 is the framework and the simple
-- writers; step 2 the money and purchase writers (part 6); step 3 the staff
-- and RBAC writers, the undo log, register_revert_ops, the exports,
-- fill_gap and prune (part 7).
--
-- 1) STORE-PARAMETERISED INTERNALS (design 3.2, 3.5; revoked from clients)
--    _license_state(store): the licence row as my_license_state() answers it,
--      plus max_staff, features and is_revoked for the register's piggyback.
--      my_license_state() is now `_license_state(auth_store_id())` minus the
--      three extra columns: same rows, same answers, so the two never drift.
--    _license_feature_for(store, name): 027's rule for a named store.
--      license_feature(name) is now `_license_feature_for(auth_store_id(),
--      name)`: same answers (027:54-65; a store-less caller still reads
--      ALLOWED). Under the register JWT auth_store_id() is NULL, which is why
--      ingest uses the internal one with the ingest store.
--    _store_day_range(store, day): the half-open UTC instants of the store's
--      local day, with the zone from store_time_zone_for(store) (025). The
--      public store_day_range() would answer the UTC day for the register.
--
-- 2) THE KIND TABLE _register_kind_perms (RLS forced, no client grants), one
--    row per op kind of design 3.6:
--      kind     the op's k
--      perms    permission codes evaluated by _register_flags against the
--               state before the op: every element is required; an element
--               'a|b' needs any one of them. The flag is 'perm:<element>'.
--               Codes that depend on the target (create vs edit on an upsert,
--               lab.edit or history.refund on a re-checkout, staff.delete on
--               an access change) are NOT listed: the writer evaluates them
--               with _ingest_can(store, actor, code).
--      money    MONEY_KINDS (design 3.6): drives in_closed_shift and the
--               noop refusal money_skip_forbidden. Must equal the PC's
--               MONEY_KINDS constant.
--      writer   the _ingest_<kind> function (one per row of design 3.6; the
--               log kinds and noop share _ingest_log).
--      log      LOG_KINDS (design 2.3): no licence or feature flag.
--      feature  a plan feature the kind needs (flag 'feature:<code>').
--      fields   the payload's known top-level keys; any other key flags
--               unknown_fields (the payload is stored whole). NULL = not checked.
--      min_v, max_v  the supported OP_FORMAT range (design 3.1).
--    Every kind has its real writer (no stub is left after step 3).
--
-- 3) THE WRITER CONTRACT (design 3.6; every writer in this file follows it)
--    _ingest_<x>(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb,
--                p_kind text) returns text[]
--    SECURITY DEFINER, search_path=public, no client grant. p_kind is the
--    op's kind (several kinds share one writer; DEVIATION from design 3.6's
--    four-argument signature, which had no way to tell them apart).
--    store_id = p_store on every row; actor columns = p_actor; time columns =
--    p_at; ids = the PC's ids; rows are looked up by (id, store_id = p_store)
--    and references checked with _ingest_ref(table, id, store). A writer
--    never calls a public RPC, price_cart, sale_event_time, next_invoice_no,
--    auth_store_id(), license_write_ok() or require_perm().
--    It returns its own flag codes (post-write findings and the target-
--    dependent perm: codes). It raises, and register_ingest classifies:
--      'refused: <code>'   -> refused: rolled back, recorded, queue continues
--      'malformed: <what>' -> MAL hold
--      'state: <what>'     -> STATE hold
--      SQLSTATE class 22/23 -> INT hold; 40001/40P01 -> retry, no hold;
--      anything else       -> FAULT hold.
--    Extra figures for the phone go to register_ops.detail through
--    _ingest_detail(jsonb) (merged, kept only when the op is applied).
--    GUCs it may read: lensy.store, lensy.actor, lensy.event_at, lensy.seq
--    (the op's seq, e.g. for register_commands.applied_seq). A GUC a writer
--    sets itself with set_config(..., true) is undone if its op fails; it
--    must still clear it before returning (lensy.money_write, design 3.6).
--    Under these GUCs and the token 033's guard lets the writes through and
--    audit_row/lab_status_stamp take the op's actor and time.
--
-- 4) THE BATCH (design 3.3). register_ingest(epoch, protocol, pending,
--    oldest_pending_at, ops) - the register's own login only (auth.uid() =
--    store_registers.register_uid):
--      no register row -> {current:false, reason:'replaced'}; revoked (or the
--      store no longer register_only) -> 'revoked'; quarantined ->
--      'quarantined' with conflict {s}; another epoch -> 'replaced' with the
--      current epoch; protocol below min_protocol -> upgrade_required; more
--      than 200 ops or 256 KB -> retry with reason 'batch_too_large'.
--      Then, outside any savepoint: lensy.ingest = '1', lensy.store = store
--      and 033's ingest token (_register_bypass(store, 'ingest', true)).
--      Per op, in order: s <= last_seq is a dup (same op_id) or a SEQ
--      CONFLICT (anything else: quarantine, alert 'seq_conflict',
--      conflict_seq, stop); s > last_seq + 1 is a gap (stop); an op_id
--      already logged at another seq is recorded as dup_import; otherwise,
--      inside its own savepoint: lensy.actor, lensy.event_at, lensy.seq; the
--      envelope's shape and version range; _register_guard (refusals);
--      _register_flags (pre-op state); the writer; one register_ops row
--      (ok, flagged or, for noop, skipped). An applied or refused op moves
--      last_seq (and max_t, capped at now() + 10 min) and ends a hold at its
--      seq. A failure rolls back that op only and is classified as part 3
--      says; a hold stops the batch. Before every op but the first the
--      budget (lensy.ingest_budget_ms, at most 3000 ms) may stop it with
--      more:true. store_registers (locked for the call) is written ONCE, at
--      the end: last_seq, max_t, held_*, skipped_total, the alert or the
--      quarantine, last_ingest_at, last_contact_at, pending_reported,
--      oldest_pending_at. Then every lensy.* GUC it set is cleared and the
--      token closed.
--    The response carries the envelope of design 3.2: current, reason,
--    epoch, acked_seq, more, retry, server_now, min_protocol, catalog,
--    held{s, code, msg}, conflict{s}, results[{s, st, v}] (non-ok only),
--    dup, license, commands (unapplied register_commands), store_day,
--    flags_total, skipped_total, parked_total.
--    DECISION (design 3.2 leaves the carrier open): the PC's own finding
--    tz_mismatch travels in an optional envelope key f (text array); only
--    'tz_mismatch' is honoured there.
--    register_ping(epoch, pending, oldest_pending_at) answers the same
--    envelope with no ops and stamps last_contact_at.
--    register_resolve_held(store, seq, reason) - platform admins: parks the
--    held op (design 3.8): a 'parked' register_ops row with the held op as
--    payload, last_seq advanced, held_* cleared, parked_total + 1, audit_log.
--
-- 5) REFUSALS AND FLAGS BUILT HERE (design 3.4, 3.5). _register_guard:
--    foreign_actor, no_session_sid (sid may be null only for auth.lockout,
--    a staff.set_access carrying via_command, and noop). _ingest_ref: foreign_id. _ingest_log:
--    money_skip_forbidden. _register_flags: actor_inactive, perm:<code>,
--    no_session, after_remote_deactivation (an unapplied owner command to
--    switch the actor off, issued at or before t), licence (business kinds
--    only: the log kinds commit in every licence state, design 2.3),
--    feature:<code>, clock_ahead, clock_back,
--    in_closed_shift, unknown_fields; register_ingest: tz_mismatch. Writers:
--    negative_stock (stock.adjust), note_authorship, delete_missing,
--    target_missing, clock_reset, skipped:<kind>; step 2's writers: part 6;
--    step 3's staff writers: part 7 (refusals protected_target,
--    reserved_name, reserved_role, bad_command; flags assign_admin,
--    self_change, max_staff, reactivated_after_remote_deactivation).
--
-- 6) THE MONEY AND PURCHASE WRITERS (step 2; design 3.6, 3.7, 2.6). Each
--    stores the rows the PC derived, verbatim, and turns 030's guards into
--    flags (design 3.7); it never re-prices, re-derives or re-dates a row
--    (sale_event_time is NOT applied: t is the PC's, every row of the op
--    gets it). Payloads (top-level keys = the kind table's fields):
--      sale.create      {id, invoice_no, idempotency_key, customer_id, kind,
--                       total_amount, discount, net_amount, payment_method,
--                       delivery_date, doctor_name, lab_status, rx_image_path,
--                       frame_image_path, renumbered_from?, items[{id,
--                       product_id, name, qty, unit_price, total_price,
--                       discount, discount_reason, movement_id}], exams[{id,
--                       ...order_examinations}], payments[{id, method,
--                       amount > 0}]}. One 'sale' movement per line with a
--                       product (movement_id, -qty); invoice_counter (store,
--                       '') raised with greatest to max numeric invoice + 1.
--      sale.recheckout  {sale_id, the header (as create, minus invoice,
--                       kind, idempotency), items[], exams[] (replaced, ids
--                       as sent), movements[{id, product_id, qty}] (the
--                       per-product deltas, appended), payments[{id, method,
--                       amount <> 0}] (the per-method deltas, appended;
--                       positive rows first), expect}. customer_id,
--                       payment_method and doctor_name keep the old value
--                       when null (030:635-637). lensy.money_write is set
--                       just before the header UPDATE and cleared after the
--                       last ledger row.
--      sale.header      {sale_id, doctor_name?, delivery_date?,
--                       rx_image_path?, frame_image_path?, lab_status?}:
--                       only the keys present are written.
--      sale.exams       {sale_id, exams[]} (replaced; exams is required).
--      sale.lab_status  {sale_id, status} (Not Started|In Lab|Ready|Received).
--      payment.collect  {sale_id, lines[{id, method, amount > 0}], expect}.
--      sale.refund      {sale_id, row{id, method, amount > 0}, note, expect}:
--                       one row of -amount; note = 'Refund <inv>[: note]'.
--      sale.void        {sale_id, reason, refunds[{id, method, amount < 0}],
--                       restock[{id, product_id, qty > 0}], expect}.
--      shift.close      {id, from_at, to_at, counted_cash, expected_cash,
--                       expected_by_tender, expected_total, variance?,
--                       order_count, prescription_count, void_count,
--                       refund_total, lab_delivered, note}.
--      purchase.upsert  {id, supplier_id, total_amount, amount_paid,
--                       purchase_date, items[{id, product_id, qty,
--                       unit_cost, total_cost}]} (the unreceived lines);
--                       purchase.delete {id}.
--      purchase.payment.add {id, purchase_id, amount, paid_at?, note};
--                       purchase.payment.delete {id}.
--      purchase.receive {purchase_id, lines[{item_id, movement_id}],
--                       cost_after{product_id: cost}}.
--    expect = {paid?, tenders?} with tenders [{method, amount}] or
--    {method: amount}; compared with the ledger BEFORE the op, both sides
--    grouped by tender_key, tolerance 0.005 -> divergence. Ledger notes are
--    the online RPCs' ('Refund <inv>[: note]', 'Re-checkout refund <inv>',
--    'Void <inv>'); stock notes too ('POS Sale: ', 'POS Re-checkout: ',
--    'Void <inv>[: reason]', 'Received from purchase <id>').
--    Holds: a missing sale (any sale.* kind but create, payment.collect) or
--    purchase (purchase.receive) -> 'state:'; a voided sale for recheckout,
--    collect, refund and void -> 'state:'; lab_status on a sale with no lab
--    order -> 'state:'; purchase.receive of a line that is missing, of another
--    purchase, received, without product or qty <= 0 -> 'state:';
--    purchase.upsert changing a received line or naming another purchase's
--    line -> 'state:'; shift.close variance <> counted - expected -> MAL;
--    a bad shape -> MAL; ids already present / CHECKs / FKs -> INT.
--    Flags: price_changed, negative_stock, unknown_tender, overpaid,
--    header_rule, kind_rule, invoice_renumbered (create); refund_first,
--    unknown_tender, perm:history.refund, perm:lab.edit,
--    photo_replace_not_admin, price_changed, divergence (expect, or
--    movements that are not the quantity change), refund_exceeds_tender
--    (a tender the op took money off is below zero), overpaid, header_rule,
--    negative_stock (recheckout); perm:lab.edit, photo_replace_not_admin,
--    edit_voided (header); edit_voided (exams, lab_status); unknown_tender,
--    overpaid, divergence (collect); refund_exceeds_tender, divergence
--    (refund); void_derivation_differs, void_not_zero, divergence (void);
--    z_mismatch (shift.close; the server's _z_report over close_shift's
--    window, which report_window ends at the next midnight, 016:35-43);
--    perm:suppliers.create|edit, delete_missing (purchase.upsert/delete);
--    delete_missing (purchase.payment.delete); cost_mismatch
--    (purchase.receive: the PC's cost_after stored, the server's weighted
--    cost of 032 in detail). Figures go to detail under the flag's name.
--
-- 7) STEP 3: STAFF AND RBAC, THE UNDO LOG, REVERT, EXPORTS, GAP, PRUNE
--    Staff writers (design 2.7, 3.6; 029/031's staff RPCs turned into flags):
--      staff.create         {id, username, full_name?, role_id?, is_active?}
--                           -> users row with password_hash 'register-local',
--                           created_at = t. id in auth.users, platform_admins
--                           or a register login -> refused protected_target;
--                           lower(btrim(username)) superadmin|register ->
--                           refused reserved_name; username not
--                           ^[^@\s]{2,32}$ -> MAL; a name equal to another
--                           user's of the store under lower(btrim()) -> the
--                           033 per-store index (INT hold).
--      staff.set_access     {user_id, role_id?, active, via_command?}; role_id
--                           absent keeps the role (null = no position).
--                           via_command (only here) must name an unapplied
--                           'staff.deactivate' command of this store for that
--                           user, with active false, else refused bad_command;
--                           it sets register_commands.applied_seq = lensy.seq.
--      staff.update_profile {user_id, full_name}.
--      Both: the owner, a cloud login, a platform admin or a register login as
--      target -> refused protected_target; target missing -> target_missing.
--      Flags: self_change (the actor's own access), assign_admin (a non-admin
--      actor giving or changing admin/owner access, 029 can_assign_role),
--      perm:staff.delete (active changes, 029:180), max_staff (switching on,
--      or creating an active user, at the licence's max_staff active users,
--      031), reactivated_after_remote_deactivation (switching on a user with
--      an owner command issued at or before t: applied, or not yet applied).
--      role.create          {id, name}: btrim'd; lower() admin|owner|superadmin
--                           -> refused reserved_role; another role of the store
--                           with that lower(btrim(name)) -> 23505 (INT hold).
--      role.set_permission  {role_id, code, granted, id?}: an admin/owner/
--                           superadmin role -> refused reserved_role; code not
--                           in supported_permissions() -> MAL; self_change when
--                           the actor removes staff.view/staff.edit from his
--                           own role (029:135-138). id = the new grant row's id.
--      user.set_permission  {user_id, code, allow (true|false|null = remove),
--                           id?}: protected target -> refused protected_target;
--                           self_change when user_id = the actor.
--    UNDO LOG (design 4.4, 6.3). register_undo (store_id, seq, n, table_name,
--      pk, action, before_row), RLS forced, no client grant. The AFTER row
--      trigger zz_register_undo -> _register_undo_capture() on the 25 tables
--      of 033's guard writes one row per changed row, ONLY under the ingest
--      gate (_register_ingest_store()), keyed by lensy.seq. Cascades are
--      caught too (stock_qty and amount_paid syncs, invoice_counter, FK
--      cascades): they run inside the op.
--    register_revert_ops(store, from_seq, reason) - platform admins only;
--      the register must be quarantined or revoked and from_seq <= last_seq.
--      Under 033's 'admin' token it replays the undo rows of seq >= from_seq
--      in reverse n order (insert -> delete; update -> before_row; delete ->
--      re-insert), never writing inventory.stock_qty or sales.amount_paid
--      (the sync triggers recompute them from the reverted ledgers), nor
--      users.password_hash, stores.register_only or stores.owner_uid (ingest
--      never changes them; set_store_owner and the setup functions do);
--      lensy.money_write around each sales UPDATE, and the lab times put back
--      after it (lab_status_stamp re-stamps them). It clears
--      register_commands.applied_seq in the range, moves those register_ops
--      rows to register_ops_foreign (status 'reverted', the original status
--      kept), sets last_seq = from_seq - 1, recomputes max_t (and the skip and
--      park totals), clears held_*, and writes audit_log ('revert'). A range
--      reaching a pruned seq raises 'undo_pruned' (55000).
--    EXPORTS (design 4.4, 6.2). register_export(table, after, limit <= 1000)
--      and register_export_heads(): the register login only, while its setup
--      window is open (033 register_snapshot_open()); whitelisted tables and
--      columns (_register_export_cols); users without password_hash, with a
--      computed protected flag; keyset paging on the table's key (after = the
--      last key of the previous page). register_snapshot_done() closes the
--      window. register_export_ops(from_seq, limit <= 500): the store OWNER's
--      session only (stores.owner_uid; never a register login): contiguous
--      register_ops rows (noop, parked, dup_import and lost included);
--      'retention' (55000) when from_seq reaches a pruned payload.
--    register_fill_gap(store, from, to, reason) - platform admins: 'lost' noop
--      rows for from = last_seq + 1 .. to; last_seq = to; audit_log.
--    prune_register_ops(before) - platform admins: payloads received more
--      than 400 days ago (and before p_before) are dropped, the row skeleton
--      kept; undo rows 60 days after INGEST (register_ops.received_at). Both
--      prune a seq prefix per store and record it (store_registers
--      payload_pruned_seq, undo_pruned_seq), which is what 'retention' and
--      'undo_pruned' test.
--
-- Idempotent: safe to paste more than once.
-- ===========================================================================
begin;

-- ============================================================
-- 1) store-parameterised internals
-- ============================================================
-- 026:82-101's answer for a named store, plus the piggyback's extra fields.
create or replace function public._license_state(p_store uuid)
returns table (state text, plan text, starts_at timestamptz, expires_at timestamptz,
               store_name text, max_staff integer, features jsonb, is_revoked boolean)
language sql stable security definer set search_path = public as $$
  select
    case
      when s.id is null then 'none'
      when l.id is null then 'none'
      when l.is_revoked then 'expired'
      when l.starts_at > now() then 'pending'
      when l.expires_at is null or l.expires_at > now() then 'active'
      when l.expires_at > now() - interval '30 days' then 'grace'
      else 'expired'
    end,
    l.plan,
    l.starts_at,
    l.expires_at,
    s.name,
    l.max_staff,
    l.features,
    l.is_revoked
  from public.stores s
  left join public.store_licenses l on l.store_id = s.id
  where s.id = p_store
$$;

-- Same return type as 026, so create or replace keeps its grant.
create or replace function public.my_license_state()
returns table (state text, plan text, starts_at timestamptz, expires_at timestamptz,
                store_name text)
language sql stable security definer set search_path = public as $$
  select l.state, l.plan, l.starts_at, l.expires_at, l.store_name
    from public._license_state(public.auth_store_id()) l
$$;

-- 027:54-65's rule for a named store.
create or replace function public._license_feature_for(p_store uuid, p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
             when (l.features ->> p_name) = 'true'  then true
             when (l.features ->> p_name) = 'false' then false
             else true
           end
      from public.store_licenses l
     where l.store_id = p_store
  ), true)
$$;

create or replace function public.license_feature(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select public._license_feature_for(public.auth_store_id(), p_name)
$$;

-- 016's store_day_range with the zone of a NAMED store (025's lookup).
create or replace function public._store_day_range(p_store uuid, p_day date default null)
returns table (from_at timestamptz, to_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_zone text := public.store_time_zone_for(p_store);
  v_day  date := coalesce(p_day, (now() at time zone v_zone)::date);
begin
  return query
  select (v_day::text || ' 00:00:00')::timestamp at time zone v_zone,
         ((v_day + 1)::text || ' 00:00:00')::timestamp at time zone v_zone;
end $$;

-- ============================================================
-- 2) the kind table
-- ============================================================
create table if not exists public._register_kind_perms (
  kind    text primary key,
  perms   text[]  not null default '{}',
  money   boolean not null default false,
  writer  text    not null,
  log     boolean not null default false,
  feature text,
  fields  text[],
  min_v   integer not null default 1 check (min_v >= 1),
  max_v   integer not null default 1,
  constraint register_kind_perms_v_ck check (max_v >= min_v)
);
alter table public._register_kind_perms enable row level security;
alter table public._register_kind_perms force row level security;
revoke all on table public._register_kind_perms from public, anon, authenticated, service_role;

-- min_v/max_v stay 1 (OP_FORMAT 1 everywhere) until a kind's format moves;
-- such a change adds them to this list and to the update below.
insert into public._register_kind_perms (kind, perms, money, writer, log, feature, fields) values
  -- entities (step 1)
  ('customer.upsert',  '{}',                        false, '_ingest_customer',     false, null,
     '{id,name,phone,phone2,email,city,address,notes,created_at,store_id}'),
  ('customer.delete',  '{customers.delete}',        false, '_ingest_customer',     false, null, '{id}'),
  ('product.upsert',   '{}',                        false, '_ingest_product',      false, null,
     '{id,name,sku,barcode,category,brand,frame_type,frame_color,cost_price,sale_price,created_at,store_id,initial}'),
  ('stock.adjust',     '{inventory.edit}',          true,  '_ingest_stock_adjust', false, null,
     '{movement_id,product_id,qty,type,ref_no,note}'),
  ('metadata.upsert',  '{inventory.edit}',          false, '_ingest_metadata',     false, null,
     '{table,id,name,sort_order,created_at,store_id}'),
  ('metadata.delete',  '{inventory.edit}',          false, '_ingest_metadata',     false, null, '{table,id}'),
  ('metadata.reorder', '{inventory.edit}',          false, '_ingest_metadata',     false, null, '{table,ids}'),
  ('supplier.upsert',  '{}',                        false, '_ingest_supplier',     false, null,
     '{id,name,phone,email,address,created_at,store_id}'),
  ('supplier.delete',  '{suppliers.delete}',        false, '_ingest_supplier',     false, null, '{id}'),
  ('note.upsert',      '{}',                        false, '_ingest_note',         false, null,
     '{id,body,user_id,created_by,created_at,updated_at,store_id}'),
  ('note.delete',      '{notes.delete}',            false, '_ingest_note',         false, null, '{id}'),
  ('setting.set',      '{settings.edit}',           false, '_ingest_settings',     false, null,
     '{id,key,value,created_at,store_id}'),
  ('store.update',     '{settings.edit}',           false, '_ingest_settings',     false, null,
     '{allow_negative_stock,time_zone}'),
  -- purchases and money (step 2). The perms are 029's: purchases.* is an
  -- alias of suppliers.* (029:25-41, _resolve_can_for), so delete_purchase's
  -- second check is the same code; purchase.upsert's create/edit is the
  -- writer's (target-dependent).
  ('purchase.upsert',         '{}',                    false, '_ingest_purchase',          false, null,
     '{id,supplier_id,total_amount,amount_paid,purchase_date,created_at,store_id,items}'),
  ('purchase.delete',         '{suppliers.delete}',    false, '_ingest_purchase',          false, null, '{id}'),
  ('purchase.payment.add',    '{suppliers.edit}',      true,  '_ingest_purchase_payment',  false, null,
     '{id,purchase_id,amount,paid_at,note,created_at,store_id}'),
  ('purchase.payment.delete', '{suppliers.edit}',      true,  '_ingest_purchase_payment',  false, null, '{id}'),
  ('purchase.receive',        '{suppliers.edit}',      true,  '_ingest_purchase_receive',  false, null,
     '{purchase_id,lines,cost_after}'),
  ('sale.create',             '{pos.create}',          true,  '_ingest_sale_create',       false, null,
     '{id,invoice_no,idempotency_key,customer_id,kind,total_amount,discount,net_amount,amount_paid,payment_method,'
     'order_date,delivery_date,doctor_name,lab_status,rx_image_path,frame_image_path,user_id,created_at,store_id,'
     'renumbered_from,items,exams,payments}'),
  ('sale.recheckout',         '{pos.edit|history.edit}', true, '_ingest_sale_recheckout',  false, null,
     '{sale_id,customer_id,total_amount,discount,net_amount,payment_method,delivery_date,doctor_name,lab_status,'
     'rx_image_path,frame_image_path,items,exams,movements,payments,expect}'),
  ('sale.header',             '{history.edit}',        false, '_ingest_sale_header',       false, null,
     '{sale_id,doctor_name,delivery_date,rx_image_path,frame_image_path,lab_status}'),
  ('sale.exams',              '{history.edit}',        false, '_ingest_sale_exams',        false, null, '{sale_id,exams}'),
  ('sale.lab_status',         '{lab.edit}',            false, '_ingest_sale_lab_status',   false, 'lab', '{sale_id,status}'),
  ('payment.collect',         '{history.edit}',        true,  '_ingest_payment_collect',   false, null, '{sale_id,lines,expect}'),
  ('sale.refund',             '{history.refund}',      true,  '_ingest_sale_refund',       false, null, '{sale_id,row,note,expect}'),
  ('sale.void',               '{history.void}',        true,  '_ingest_sale_void',         false, null,
     '{sale_id,reason,refunds,restock,expect}'),
  ('shift.close',             '{closing.edit}',        true,  '_ingest_shift_close',       false, null,
     '{id,from_at,to_at,counted_cash,expected_cash,expected_by_tender,expected_total,variance,order_count,'
     'prescription_count,void_count,refund_total,lab_delivered,note}'),
  -- staff and RBAC (step 3)
  -- (029's staff RPCs: require_staff_editor = staff.edit for roles and
  -- permissions; staff.delete when active changes is the writer's)
  ('staff.create',            '{staff.create}',        false, '_ingest_staff_create',      false, null,
     '{id,username,full_name,role_id,is_active,created_at,store_id}'),
  ('staff.set_access',        '{staff.edit}',          false, '_ingest_staff_update',      false, null,
     '{user_id,role_id,active,via_command}'),
  ('staff.update_profile',    '{staff.edit}',          false, '_ingest_staff_update',      false, null, '{user_id,full_name}'),
  ('role.create',             '{staff.edit}',          false, '_ingest_rbac',              false, null,
     '{id,name,created_at,store_id}'),
  ('role.set_permission',     '{staff.edit}',          false, '_ingest_rbac',              false, null, '{id,role_id,code,granted}'),
  ('user.set_permission',     '{staff.edit}',          false, '_ingest_rbac',              false, null, '{id,user_id,code,allow}'),
  -- the log kinds and noop (step 1): no table write
  ('session.start',  '{}', false, '_ingest_log', true, null, '{sid,user_id}'),
  ('session.end',    '{}', false, '_ingest_log', true, null, '{sid,user_id,reason}'),
  ('credential.set', '{}', false, '_ingest_log', true, null, '{user_id,by,kind}'),
  ('auth.lockout',   '{}', false, '_ingest_log', true, null, '{user_id,failures,until}'),
  ('clock.reset',    '{}', false, '_ingest_log', true, null, '{from,to}'),
  ('noop',           '{}', false, '_ingest_log', true, null, '{skipped,reason,by}')
on conflict (kind) do update
  set perms = excluded.perms, money = excluded.money, writer = excluded.writer,
      log = excluded.log, feature = excluded.feature, fields = excluded.fields;

-- no_session looks up the store's session ops by sid on every op.
create index if not exists register_ops_session_idx
  on public.register_ops (store_id, sid) where kind in ('session.start', 'session.end');

-- ============================================================
-- 3) helpers for the writers
-- ============================================================
-- A uuid, or NULL for anything that is not one (no exception, no savepoint).
create or replace function public._ingest_uuid(p text) returns uuid
language sql immutable set search_path = public as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

-- An instant WITH its zone (the PC sends ISO with Z or an offset), else NULL.
create or replace function public._ingest_ts(p text) returns timestamptz
language plpgsql stable set search_path = public as $$
begin
  if p is null or p !~ '(Z|z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    return null;
  end if;
  return p::timestamptz;
exception when others then
  return null;
end $$;

-- A required uuid field of a payload, else 'malformed: <key>'.
create or replace function public._ingest_id(p jsonb, p_key text) returns uuid
language plpgsql immutable set search_path = public as $$
declare
  v uuid := public._ingest_uuid(p ->> p_key);
begin
  if v is null then
    raise exception 'malformed: %', p_key using errcode = '22023';
  end if;
  return v;
end $$;

-- Is row p_id of p_tbl in p_store? true: yes; false: in no store; in ANOTHER
-- store -> 'refused: foreign_id' (a forger probing another tenant).
create or replace function public._ingest_ref(p_tbl text, p_id uuid, p_store uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid;
begin
  if p_tbl is null or p_tbl <> all (array[
       'customers', 'inventory', 'stock_movements', 'sales', 'sale_items', 'order_examinations',
       'sale_payments', 'shift_closes', 'suppliers', 'purchases', 'purchase_items',
       'purchase_payments', 'notes', 'settings', 'lens_types', 'frame_colors', 'frame_types',
       'prescriptions', 'warehouses', 'users', 'roles']) then
    raise exception '_ingest_ref: no such table %', p_tbl;
  end if;
  if p_id is null then
    raise exception 'malformed: % id', p_tbl using errcode = '22023';
  end if;
  execute format('select t.store_id from public.%I t where t.id = $1', p_tbl) into v_store using p_id;
  if v_store is null then
    return false;
  end if;
  if v_store <> p_store then
    raise exception 'refused: foreign_id'
      using detail = format('%s %s belongs to another store', p_tbl, p_id);
  end if;
  return true;
end $$;

-- A target-dependent permission check: '{}' or '{perm:<code>}'.
create or replace function public._ingest_can(p_store uuid, p_actor uuid, p_code text) returns text[]
language sql stable security definer set search_path = public as $$
  select case when public._resolve_can_for(p_code, p_actor, p_store) then '{}'::text[]
              else array['perm:' || p_code] end
$$;

-- Figures behind a flag, merged into this op's register_ops.detail.
create or replace function public._ingest_detail(p jsonb) returns void
language plpgsql set search_path = public as $$
begin
  perform set_config('lensy.detail',
    (coalesce(nullif(current_setting('lensy.detail', true), '')::jsonb, '{}'::jsonb) || coalesce(p, '{}'::jsonb))::text,
    true);
end $$;

-- ============================================================
-- 4) refusals and flags
-- ============================================================
-- Forger-only conditions every kind shares (design 3.4). NULL = not refused.
-- Kind-specific refusals are raised by the writers ('refused: <code>').
create or replace function public._register_guard(p_store uuid, p_kind text, p_actor uuid, p_sid uuid, p jsonb)
returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.users u where u.id = p_actor and u.store_id = p_store) then
    return 'foreign_actor';
  end if;
  -- (a noop is the PC rewriting a held head in place, design 3.8: it may
  -- keep a sid-less original's envelope)
  if p_sid is null and p_kind not in ('auth.lockout', 'noop')
     and not (p_kind = 'staff.set_access' and coalesce(p, '{}'::jsonb) ? 'via_command') then
    return 'no_session_sid';
  end if;
  return null;
end $$;

-- Policy flags, evaluated against the state BEFORE the op (design 3.5).
-- p_max_t: the register's max_t before this op (register_ingest passes its
-- running value; NULL reads store_registers, for a direct call).
create or replace function public._register_flags(p_store uuid, p_kind text, p_actor uuid, p_sid uuid,
                                                  p_at timestamptz, p jsonb, p_max_t timestamptz default null)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  k       public._register_kind_perms;
  v_flags text[] := '{}';
  v_code  text;
  v_log   boolean;
  l       public.store_licenses;
  v_max_t timestamptz;
  v_close timestamptz;
  v_extra text[];
begin
  select * into k from public._register_kind_perms where kind = p_kind;
  if not found or p_kind = 'noop' then
    return v_flags;
  end if;
  v_log := k.log or (p_kind = 'staff.set_access' and coalesce(p, '{}'::jsonb) ? 'via_command');

  -- actor and permission
  if not exists (select 1 from public.users u
                   join public.roles r on r.id = u.role_id and r.store_id = u.store_id
                  where u.id = p_actor and u.store_id = p_store and u.is_active is true) then
    v_flags := v_flags || 'actor_inactive'::text;
  end if;
  foreach v_code in array k.perms loop
    if not exists (select 1 from unnest(string_to_array(v_code, '|')) c
                    where public._resolve_can_for(btrim(c), p_actor, p_store)) then
      v_flags := v_flags || ('perm:' || v_code);
    end if;
  end loop;
  -- an open session of this actor: started (at an earlier seq) and not ended
  if p_kind <> 'session.start' and p_sid is not null
     and (not exists (select 1 from public.register_ops o
                       where o.store_id = p_store and o.sid = p_sid and o.kind = 'session.start'
                         and o.actor = p_actor and o.status in ('ok', 'flagged'))
          or exists (select 1 from public.register_ops o
                      where o.store_id = p_store and o.sid = p_sid and o.kind = 'session.end'
                        and o.status in ('ok', 'flagged'))) then
    v_flags := v_flags || 'no_session'::text;
  end if;
  -- the owner switched this actor off from the phone (design 2.7) and the PC
  -- has not applied the command yet: the op still happened, flag it
  if exists (select 1 from public.register_commands c
              where c.store_id = p_store and c.user_id = p_actor and c.kind = 'staff.deactivate'
                and c.applied_seq is null and c.issued_at <= p_at) then
    v_flags := v_flags || 'after_remote_deactivation'::text;
  end if;

  -- licence and plan (business kinds only; the log kinds commit in every state)
  if not v_log then
    select * into l from public.store_licenses where store_id = p_store;
    if not found or l.is_revoked or p_at < l.starts_at
       or (l.expires_at is not null and p_at >= l.expires_at) then
      v_flags := v_flags || 'licence'::text;
    end if;
    if k.feature is not null and not public._license_feature_for(p_store, k.feature) then
      v_flags := v_flags || ('feature:' || k.feature);
    end if;
  end if;

  -- time
  if p_at > now() + interval '10 minutes' then
    v_flags := v_flags || 'clock_ahead'::text;
  end if;
  v_max_t := p_max_t;
  if v_max_t is null then
    select r.max_t into v_max_t from public.store_registers r where r.store_id = p_store;
  end if;
  if v_max_t is not null and p_at < v_max_t - interval '5 minutes' then
    v_flags := v_flags || 'clock_back'::text;
  end if;
  if k.money then
    select max(c.to_at) into v_close from public.shift_closes c where c.store_id = p_store;
    if v_close is not null and p_at < v_close then
      v_flags := v_flags || 'in_closed_shift'::text;
    end if;
  end if;

  -- payload keys the kind does not know (stored whole all the same)
  if k.fields is not null and jsonb_typeof(p) = 'object' then
    select array_agg(x order by x) into v_extra
      from jsonb_object_keys(p) x where x <> all (k.fields);
    if v_extra is not null then
      v_flags := v_flags || 'unknown_fields'::text;
      perform public._ingest_detail(jsonb_build_object('unknown_fields', to_jsonb(v_extra)));
    end if;
  end if;
  return v_flags;
end $$;

-- ============================================================
-- 5) the writers built in step 1
-- ============================================================
-- customer.upsert (full row) / customer.delete {id}. A delete of a customer
-- with sales fails its foreign key (INT hold; the PC refuses it first).
create or replace function public._ingest_customer(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := public._ingest_id(p, 'id');
  v_has   boolean := public._ingest_ref('customers', v_id, p_store);
  v_flags text[] := '{}';
begin
  if p_kind = 'customer.delete' then
    if not v_has then
      return array['delete_missing'];
    end if;
    delete from public.customers where id = v_id and store_id = p_store;
    return v_flags;
  end if;

  v_flags := public._ingest_can(p_store, p_actor, case when v_has then 'customers.edit' else 'customers.create' end);
  if v_has then
    update public.customers
       set name = p ->> 'name', phone = p ->> 'phone', phone2 = p ->> 'phone2', email = p ->> 'email',
           city = p ->> 'city', address = p ->> 'address', notes = p ->> 'notes'
     where id = v_id and store_id = p_store;
  else
    insert into public.customers (id, store_id, name, phone, phone2, email, city, address, notes, created_at)
    values (v_id, p_store, p ->> 'name', p ->> 'phone', p ->> 'phone2', p ->> 'email',
            p ->> 'city', p ->> 'address', p ->> 'notes', p_at);
  end if;
  return v_flags;
end $$;

-- product.upsert: the row without stock_qty (a cache the movements keep),
-- optional initial {movement_id, qty > 0}. An empty sku is stored as NULL
-- (031's rule), so the PC's applyOp must do the same.
create or replace function public._ingest_product(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := public._ingest_id(p, 'id');
  v_has   boolean := public._ingest_ref('inventory', v_id, p_store);
  v_sku   text := case when btrim(p ->> 'sku') = '' then null else p ->> 'sku' end;
  v_flags text[];
  v_init  jsonb := case when jsonb_typeof(p -> 'initial') = 'object' then p -> 'initial' end;
  v_mid   uuid;
  v_qty   integer;
begin
  if p ? 'initial' and jsonb_typeof(p -> 'initial') <> 'null' and v_init is null then
    raise exception 'malformed: initial' using errcode = '22023';
  end if;
  v_flags := public._ingest_can(p_store, p_actor, case when v_has then 'inventory.edit' else 'inventory.create' end);
  if v_has then
    update public.inventory
       set name = p ->> 'name', sku = v_sku, barcode = p ->> 'barcode', category = p ->> 'category',
           brand = p ->> 'brand', frame_type = p ->> 'frame_type', frame_color = p ->> 'frame_color',
           cost_price = coalesce((p ->> 'cost_price')::numeric, 0),
           sale_price = coalesce((p ->> 'sale_price')::numeric, 0)
     where id = v_id and store_id = p_store;
  else
    insert into public.inventory (id, store_id, name, sku, barcode, category, brand, frame_type, frame_color,
                                  cost_price, sale_price, created_at)
    values (v_id, p_store, p ->> 'name', v_sku, p ->> 'barcode', p ->> 'category', p ->> 'brand',
            p ->> 'frame_type', p ->> 'frame_color',
            coalesce((p ->> 'cost_price')::numeric, 0), coalesce((p ->> 'sale_price')::numeric, 0), p_at);
  end if;

  if v_init is not null then
    v_mid := public._ingest_id(v_init, 'movement_id');
    if jsonb_typeof(v_init -> 'qty') <> 'number' or (v_init ->> 'qty') !~ '^[0-9]{1,9}$'
       or (v_init ->> 'qty')::integer <= 0 then
      raise exception 'malformed: initial.qty' using errcode = '22023';
    end if;
    v_qty := (v_init ->> 'qty')::integer;
    perform public._ingest_ref('stock_movements', v_mid, p_store);   -- another store's id -> refused
    insert into public.stock_movements (id, product_id, qty, type, store_id, created_at)
    values (v_mid, v_id, v_qty, 'initial', p_store, p_at);
  end if;
  return v_flags;
end $$;

-- stock.adjust {movement_id, product_id, qty <> 0, type, ref_no, note}. A
-- product missing everywhere fails the movement's foreign key (INT hold).
create or replace function public._ingest_stock_adjust(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_mid   uuid := public._ingest_id(p, 'movement_id');
  v_pid   uuid := public._ingest_id(p, 'product_id');
  v_qty   integer;
  v_allow boolean;
  v_stock integer;
begin
  if jsonb_typeof(p -> 'qty') <> 'number' or (p ->> 'qty') !~ '^-?[0-9]{1,9}$' or (p ->> 'qty')::integer = 0 then
    raise exception 'malformed: qty' using errcode = '22023';
  end if;
  v_qty := (p ->> 'qty')::integer;
  perform public._ingest_ref('inventory', v_pid, p_store);
  perform public._ingest_ref('stock_movements', v_mid, p_store);
  insert into public.stock_movements (id, product_id, qty, type, ref_no, note, store_id, created_at)
  values (v_mid, v_pid, v_qty, coalesce(nullif(btrim(p ->> 'type'), ''), 'adjustment'),
          p ->> 'ref_no', p ->> 'note', p_store, p_at);

  -- 030's new-units guard, as a finding: the units already left the shelf.
  select s.allow_negative_stock into v_allow from public.stores s where s.id = p_store;
  select i.stock_qty into v_stock from public.inventory i where i.id = v_pid;
  if v_qty < 0 and not coalesce(v_allow, true) and coalesce(v_stock, 0) < 0 then
    perform public._ingest_detail(jsonb_build_object('stock_after', v_stock));
    return array['negative_stock'];
  end if;
  return '{}';
end $$;

-- metadata.upsert {table, id, name, sort_order} / .delete {table, id} /
-- .reorder {table, ids[]} (sort_order = position, 1-based, as the client's
-- reorder). table is lens_types, frame_colors or frame_types; frame_types
-- has no sort_order.
create or replace function public._ingest_metadata(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_tbl   text := p ->> 'table';
  v_id    uuid;
  v_has   boolean;
  v_sort  boolean;
  v_ord   integer;
  v_x     jsonb;
  v_miss  jsonb := '[]';
begin
  if v_tbl is null or v_tbl not in ('lens_types', 'frame_colors', 'frame_types') then
    raise exception 'malformed: table' using errcode = '22023';
  end if;
  v_sort := v_tbl <> 'frame_types';

  if p_kind = 'metadata.reorder' then
    if not v_sort or jsonb_typeof(p -> 'ids') <> 'array' then
      raise exception 'malformed: ids' using errcode = '22023';
    end if;
    v_ord := 0;
    for v_x in select e from jsonb_array_elements(p -> 'ids') e loop
      v_ord := v_ord + 1;
      v_id := public._ingest_uuid(v_x #>> '{}');
      if v_id is null then
        raise exception 'malformed: ids' using errcode = '22023';
      end if;
      if public._ingest_ref(v_tbl, v_id, p_store) then
        execute format('update public.%I set sort_order = $1 where id = $2 and store_id = $3', v_tbl)
          using v_ord, v_id, p_store;
      else
        v_miss := v_miss || to_jsonb(v_id);
      end if;
    end loop;
    if jsonb_array_length(v_miss) > 0 then
      perform public._ingest_detail(jsonb_build_object('missing', v_miss));
      return array['target_missing'];
    end if;
    return '{}';
  end if;

  v_id := public._ingest_id(p, 'id');
  v_has := public._ingest_ref(v_tbl, v_id, p_store);
  if p_kind = 'metadata.delete' then
    if not v_has then
      return array['delete_missing'];
    end if;
    execute format('delete from public.%I where id = $1 and store_id = $2', v_tbl) using v_id, p_store;
    return '{}';
  end if;

  -- upsert
  if not v_sort and jsonb_typeof(p -> 'sort_order') not in ('null') then
    raise exception 'malformed: sort_order (frame_types has none)' using errcode = '22023';
  end if;
  if v_has then
    if v_sort then
      execute format('update public.%I set name = $1, sort_order = $2 where id = $3 and store_id = $4', v_tbl)
        using p ->> 'name', (p ->> 'sort_order')::integer, v_id, p_store;
    else
      execute format('update public.%I set name = $1 where id = $2 and store_id = $3', v_tbl)
        using p ->> 'name', v_id, p_store;
    end if;
  else
    if v_sort then
      execute format('insert into public.%I (id, store_id, name, sort_order, created_at) values ($1, $2, $3, $4, $5)', v_tbl)
        using v_id, p_store, p ->> 'name', (p ->> 'sort_order')::integer, p_at;
    else
      execute format('insert into public.%I (id, store_id, name, created_at) values ($1, $2, $3, $4)', v_tbl)
        using v_id, p_store, p ->> 'name', p_at;
    end if;
  end if;
  return '{}';
end $$;

-- supplier.upsert (full row) / supplier.delete {id}. Deleting a supplier
-- that purchases reference is a STATE hold (the PC refuses it first).
create or replace function public._ingest_supplier(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := public._ingest_id(p, 'id');
  v_has   boolean := public._ingest_ref('suppliers', v_id, p_store);
  v_flags text[] := '{}';
begin
  if p_kind = 'supplier.delete' then
    if not v_has then
      return array['delete_missing'];
    end if;
    if exists (select 1 from public.purchases x where x.supplier_id = v_id) then
      raise exception 'state: supplier % has purchases', v_id;
    end if;
    delete from public.suppliers where id = v_id and store_id = p_store;
    return v_flags;
  end if;

  v_flags := public._ingest_can(p_store, p_actor, case when v_has then 'suppliers.edit' else 'suppliers.create' end);
  if v_has then
    update public.suppliers
       set name = p ->> 'name', phone = p ->> 'phone', email = p ->> 'email', address = p ->> 'address'
     where id = v_id and store_id = p_store;
  else
    insert into public.suppliers (id, store_id, name, phone, email, address, created_at)
    values (v_id, p_store, p ->> 'name', p ->> 'phone', p ->> 'email', p ->> 'address', p_at);
  end if;
  return v_flags;
end $$;

-- note.upsert {id, body, user_id} / note.delete {id}. created_by is the
-- actor on a new note and kept on an edit. note_authorship mirrors 029's
-- note policies (029:825-832): a note is written by its author, a private
-- note (user_id) is the author's own, a delete is the author's or an admin's.
create or replace function public._ingest_note(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := public._ingest_id(p, 'id');
  v_has   boolean := public._ingest_ref('notes', v_id, p_store);
  v_old   public.notes;
  v_user  uuid;
  v_flags text[] := '{}';
  v_auth  boolean := false;
begin
  if v_has then
    select * into v_old from public.notes where id = v_id and store_id = p_store;
  end if;

  if p_kind = 'note.delete' then
    if not v_has then
      return array['delete_missing'];
    end if;
    if v_old.created_by is distinct from p_actor and not public._is_store_admin_for(p_actor, p_store) then
      v_flags := v_flags || 'note_authorship'::text;
    end if;
    delete from public.notes where id = v_id and store_id = p_store;
    return v_flags;
  end if;

  if jsonb_typeof(p -> 'user_id') not in ('null') and p ? 'user_id' then
    v_user := public._ingest_id(p, 'user_id');
    perform public._ingest_ref('users', v_user, p_store);
  end if;
  if v_user is not null and v_user <> p_actor then
    v_auth := true;
  end if;
  if v_has then
    v_flags := public._ingest_can(p_store, p_actor, 'notes.edit');
    if v_old.created_by is distinct from p_actor then
      v_auth := true;
    end if;
    update public.notes set body = p ->> 'body', user_id = v_user, updated_at = p_at
     where id = v_id and store_id = p_store;
  else
    v_flags := public._ingest_can(p_store, p_actor, 'notes.create');
    if p ? 'created_by' and (p ->> 'created_by') is distinct from p_actor::text then
      v_auth := true;
    end if;
    insert into public.notes (id, store_id, body, user_id, created_by, created_at)
    values (v_id, p_store, p ->> 'body', v_user, p_actor, p_at);
  end if;
  if v_auth then
    v_flags := v_flags || 'note_authorship'::text;
  end if;
  return v_flags;
end $$;

-- setting.set {id?, key, value} (on conflict (store_id, key); a new row
-- takes the PC's id) / store.update {allow_negative_stock?, time_zone?}. A
-- zone Postgres does not know is MAL: it would break every store_day.
create or replace function public._ingest_settings(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_key text := p ->> 'key';
  v_id  uuid;
begin
  if p_kind = 'store.update' then
    if not (p ? 'allow_negative_stock' or p ? 'time_zone') then
      raise exception 'malformed: store.update needs allow_negative_stock or time_zone' using errcode = '22023';
    end if;
    if p ? 'allow_negative_stock' and jsonb_typeof(p -> 'allow_negative_stock') <> 'boolean' then
      raise exception 'malformed: allow_negative_stock' using errcode = '22023';
    end if;
    if p ? 'time_zone' and not exists (select 1 from pg_timezone_names z where z.name = p ->> 'time_zone') then
      raise exception 'malformed: time_zone' using errcode = '22023';
    end if;
    update public.stores
       set allow_negative_stock = case when p ? 'allow_negative_stock'
                                       then (p ->> 'allow_negative_stock')::boolean else allow_negative_stock end,
           time_zone = case when p ? 'time_zone' then p ->> 'time_zone' else time_zone end
     where id = p_store;
    return '{}';
  end if;

  if v_key is null or btrim(v_key) = '' then
    raise exception 'malformed: key' using errcode = '22023';
  end if;
  if v_key = 'time_zone'
     and not exists (select 1 from pg_timezone_names z where z.name = p ->> 'value') then
    raise exception 'malformed: time_zone' using errcode = '22023';
  end if;
  if p ? 'id' and jsonb_typeof(p -> 'id') <> 'null' then
    v_id := public._ingest_id(p, 'id');
    perform public._ingest_ref('settings', v_id, p_store);
  end if;
  insert into public.settings (id, store_id, key, value, created_at)
  values (coalesce(v_id, gen_random_uuid()), p_store, v_key, p ->> 'value', p_at)
  on conflict (store_id, key) do update set value = excluded.value;
  return '{}';
end $$;

-- session.start, session.end, credential.set, auth.lockout, clock.reset and
-- noop: recorded in register_ops only. A noop (admin Skip, design 3.8) of a
-- MONEY_KINDS op is refused.
create or replace function public._ingest_log(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_k text;
begin
  if p_kind = 'session.end' and p ? 'reason'
     and (p ->> 'reason') not in ('signout', 'idle', 'switch', 'deactivated', 'reload') then
    raise exception 'malformed: reason' using errcode = '22023';
  end if;
  if p_kind = 'clock.reset' then
    if public._ingest_ts(p ->> 'from') is null or public._ingest_ts(p ->> 'to') is null then
      raise exception 'malformed: clock.reset needs from and to' using errcode = '22023';
    end if;
    perform public._ingest_detail(jsonb_build_object('from', p -> 'from', 'to', p -> 'to'));
    return array['clock_reset'];
  end if;
  if p_kind = 'noop' then
    if jsonb_typeof(p -> 'skipped') <> 'object' or jsonb_typeof(p -> 'skipped' -> 'k') <> 'string' then
      raise exception 'malformed: skipped' using errcode = '22023';
    end if;
    v_k := p -> 'skipped' ->> 'k';
    if exists (select 1 from public._register_kind_perms x where x.kind = v_k and x.money) then
      raise exception 'refused: money_skip_forbidden';
    end if;
    return array['skipped:' || v_k];
  end if;
  return '{}';
end $$;

-- ============================================================
-- 5b) the money and purchase writers (step 2)
-- ============================================================
-- Helpers these writers share (internal, no client grant, section 8).

-- A payload array: absent or JSON null -> '[]'; anything else that is not
-- an array -> 'malformed: <key>'.
create or replace function public._ingest_arr(p jsonb, p_key text) returns jsonb
language plpgsql immutable security definer set search_path = public as $$
begin
  if p is null or jsonb_typeof(p -> p_key) is null or jsonb_typeof(p -> p_key) = 'null' then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(p -> p_key) <> 'array' then
    raise exception 'malformed: %', p_key using errcode = '22023';
  end if;
  return p -> p_key;
end $$;

-- A JSON number; a required one missing (or not a number) -> 'malformed: <key>'.
create or replace function public._ingest_num(p jsonb, p_key text, p_required boolean default true) returns numeric
language plpgsql immutable security definer set search_path = public as $$
begin
  if jsonb_typeof(p -> p_key) = 'number' then
    return (p ->> p_key)::numeric;
  end if;
  if not p_required and (jsonb_typeof(p -> p_key) is null or jsonb_typeof(p -> p_key) = 'null') then
    return null;
  end if;
  raise exception 'malformed: %', p_key using errcode = '22023';
end $$;

-- Every element of a payload array is an object whose p_key is a uuid that
-- no OTHER store uses (_ingest_ref: refused foreign_id). An id already in
-- this store fails its primary key later (INT hold).
create or replace function public._ingest_rows(p_arr jsonb, p_what text, p_key text, p_tbl text, p_store uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
begin
  for e in select x from jsonb_array_elements(p_arr) x loop
    if jsonb_typeof(e) <> 'object' or public._ingest_uuid(e ->> p_key) is null then
      raise exception 'malformed: %.%', p_what, p_key using errcode = '22023';
    end if;
    perform public._ingest_ref(p_tbl, (e ->> p_key)::uuid, p_store);
  end loop;
end $$;

-- An optional uuid field that names a row of p_tbl: NULL when absent or
-- null, 'malformed: <key>' when not a uuid, refused when another store's.
create or replace function public._ingest_opt_ref(p jsonb, p_key text, p_tbl text, p_store uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v uuid;
begin
  if jsonb_typeof(p -> p_key) is null or jsonb_typeof(p -> p_key) = 'null' then
    return null;
  end if;
  v := public._ingest_id(p, p_key);
  perform public._ingest_ref(p_tbl, v, p_store);
  return v;
end $$;

-- Sale lines {id, product_id?, qty, unit_price, ...}: shape and tenancy; a
-- line with a product needs movement_id when p_movement (sale.create).
create or replace function public._ingest_items_check(p_store uuid, p_items jsonb, p_movement boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
begin
  perform public._ingest_rows(p_items, 'items', 'id', 'sale_items', p_store);
  for e in select x from jsonb_array_elements(p_items) x loop
    if jsonb_typeof(e -> 'qty') <> 'number' or (e ->> 'qty') !~ '^-?[0-9]{1,9}$' then
      raise exception 'malformed: items.qty' using errcode = '22023';
    end if;
    if jsonb_typeof(e -> 'unit_price') <> 'number' then
      raise exception 'malformed: items.unit_price' using errcode = '22023';
    end if;
    if public._ingest_opt_ref(e, 'product_id', 'inventory', p_store) is not null and p_movement then
      if public._ingest_uuid(e ->> 'movement_id') is null then
        raise exception 'malformed: items.movement_id' using errcode = '22023';
      end if;
      perform public._ingest_ref('stock_movements', (e ->> 'movement_id')::uuid, p_store);
    end if;
  end loop;
end $$;

-- Ledger rows {id, method, amount}: shape, tenancy and the sign the kind
-- needs (p_sign 1: > 0, -1: < 0, 0: <> 0).
create or replace function public._ingest_pay_check(p_store uuid, p_rows jsonb, p_what text, p_sign integer)
returns void
language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  a numeric;
begin
  perform public._ingest_rows(p_rows, p_what, 'id', 'sale_payments', p_store);
  for e in select x from jsonb_array_elements(p_rows) x loop
    if jsonb_typeof(e -> 'amount') <> 'number' then
      raise exception 'malformed: %.amount', p_what using errcode = '22023';
    end if;
    a := (e ->> 'amount')::numeric;
    if a = 0 or (p_sign > 0 and a < 0) or (p_sign < 0 and a > 0) then
      raise exception 'malformed: %.amount (sign)', p_what using errcode = '22023';
    end if;
    if jsonb_typeof(e -> 'method') is distinct from 'string' then
      raise exception 'malformed: %.method', p_what using errcode = '22023';
    end if;
  end loop;
end $$;

-- A sale the op targets, locked: missing from this store -> STATE hold
-- (another store's -> refused foreign_id); voided -> STATE hold when p_live
-- (design 3.6, "Missing target").
create or replace function public._ingest_sale(p jsonb, p_store uuid, p_live boolean) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := public._ingest_id(p, 'sale_id');
  v    public.sales;
begin
  if not public._ingest_ref('sales', v_id, p_store) then
    raise exception 'state: sale % is missing', v_id;
  end if;
  select * into v from public.sales where id = v_id and store_id = p_store for update;
  if p_live and v.voided_at is not null then
    raise exception 'state: sale % is voided', v_id;
  end if;
  return v;
end $$;

-- New money only on a tender the shop takes (030:268-274, 610-617). The PC
-- stores tenderKey(m), so anything but these four exact strings is flagged.
create or replace function public._ingest_tender_ok(p_method text) returns boolean
language sql immutable security definer set search_path = public as $$
  select coalesce(p_method in ('cash', 'wallet', 'instapay', 'card'), false)
$$;

-- divergence (design 3.7, the canary): the PC's expect {paid?, tenders?}
-- against this sale's ledger BEFORE the op. tenders is [{method, amount}]
-- or {method: amount}; both sides grouped by tender_key, a method netting
-- to 0 dropped, tolerance 0.005 (030:482-511).
create or replace function public._ingest_expect(p_sale uuid, p_expect jsonb) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_led  numeric;
  v_tend jsonb;
  v_bad  boolean := false;
begin
  if p_expect is null or jsonb_typeof(p_expect) = 'null' then
    return '{}';
  end if;
  if jsonb_typeof(p_expect) <> 'object' then
    raise exception 'malformed: expect' using errcode = '22023';
  end if;
  select coalesce(sum(sp.amount), 0) into v_led from public.sale_payments sp where sp.sale_id = p_sale;
  if jsonb_typeof(p_expect -> 'paid') is not null and jsonb_typeof(p_expect -> 'paid') <> 'null' then
    if jsonb_typeof(p_expect -> 'paid') <> 'number' then
      raise exception 'malformed: expect.paid' using errcode = '22023';
    end if;
    v_bad := abs((p_expect ->> 'paid')::numeric - v_led) > 0.005;
  end if;
  v_tend := p_expect -> 'tenders';
  if jsonb_typeof(v_tend) = 'object' then
    select coalesce(jsonb_agg(jsonb_build_object('method', x.key, 'amount', x.value)), '[]'::jsonb)
      into v_tend from jsonb_each(v_tend) x;
  end if;
  if v_tend is not null and jsonb_typeof(v_tend) <> 'null' then
    if jsonb_typeof(v_tend) <> 'array'
       or exists (select 1 from jsonb_array_elements(v_tend) e where jsonb_typeof(e -> 'amount') <> 'number') then
      raise exception 'malformed: expect.tenders' using errcode = '22023';
    end if;
    v_bad := v_bad or exists (
      with seen as (
        select public.tender_key(e ->> 'method') as m, sum((e ->> 'amount')::numeric) as a
          from jsonb_array_elements(v_tend) e
         group by 1
        having abs(sum((e ->> 'amount')::numeric)) > 0.005
      ), cur as (
        select public.tender_key(sp.method) as m, sum(sp.amount) as a
          from public.sale_payments sp
         where sp.sale_id = p_sale
         group by 1
        having abs(sum(sp.amount)) > 0.005
      )
      select 1 from seen full join cur on cur.m = seen.m
       where abs(coalesce(seen.a, 0) - coalesce(cur.a, 0)) > 0.005);
  end if;
  if v_bad then
    perform public._ingest_detail(jsonb_build_object('divergence', jsonb_build_object(
      'expect', p_expect, 'paid', v_led,
      'tenders', (select coalesce(jsonb_object_agg(x.m, x.a), '{}'::jsonb)
                    from (select public.tender_key(sp.method) as m, sum(sp.amount) as a
                            from public.sale_payments sp where sp.sale_id = p_sale group by 1) x))));
    return array['divergence'];
  end if;
  return '{}';
end $$;

-- header_rule: price_cart's header (030:174-190) applied to the lines AS
-- STORED and the PC's net: the lines' gross is the total, every discount the
-- header discount, a net within 0.01 above the lines snaps to them, a net
-- further above is a negotiated total with discount 0.
create or replace function public._ingest_header_rule(p_items jsonb, p_total numeric, p_discount numeric, p_net numeric)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_items numeric;
  v_total numeric;
  v_disc  numeric;
  v_net   numeric;
begin
  select coalesce(sum((e ->> 'qty')::numeric * (e ->> 'unit_price')::numeric), 0) into v_items
    from jsonb_array_elements(p_items) e;
  v_net := greatest(0, round(coalesce(p_net, 0), 2));
  if v_net <= v_items + 0.01 then
    v_total := v_items;
    v_disc  := least(v_items, round(greatest(0, v_items - v_net), 2));
    v_net   := v_total - v_disc;
  else
    v_total := v_net;
    v_disc  := 0;
  end if;
  if coalesce(p_net, 0) < -0.01 or v_total is distinct from p_total or v_disc is distinct from p_discount
     or v_net is distinct from p_net then
    perform public._ingest_detail(jsonb_build_object('header_rule', jsonb_build_object(
      'sent', jsonb_build_object('total_amount', p_total, 'discount', p_discount, 'net_amount', p_net),
      'rule', jsonb_build_object('total_amount', v_total, 'discount', v_disc, 'net_amount', v_net))));
    return array['header_rule'];
  end if;
  return '{}';
end $$;

-- price_changed: a line whose unit price is not the catalogue's
-- (030:149-160, tolerance 0.01; no catalogue lock at ingest).
create or replace function public._ingest_price_changed(p_store uuid, p_items jsonb) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  select jsonb_agg(jsonb_build_object('product_id', i.id, 'unit_price', (e ->> 'unit_price')::numeric,
                                      'catalogue', i.sale_price))
    into v
    from jsonb_array_elements(p_items) e
    join public.inventory i on i.id = public._ingest_uuid(e ->> 'product_id') and i.store_id = p_store
   where abs(coalesce((e ->> 'unit_price')::numeric, 0) - coalesce(i.sale_price, 0)) > 0.01;
  if v is not null then
    perform public._ingest_detail(jsonb_build_object('price_changed', v));
    return array['price_changed'];
  end if;
  return '{}';
end $$;

-- negative_stock: the store forbids it and a product this op took units of
-- is now below zero (030's new-units guard, 030:544-562, as a finding).
create or replace function public._ingest_neg_stock(p_store uuid, p_products uuid[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  if coalesce((select s.allow_negative_stock from public.stores s where s.id = p_store), true) then
    return '{}';
  end if;
  select jsonb_agg(jsonb_build_object('product_id', i.id, 'stock_after', i.stock_qty) order by i.id) into v
    from public.inventory i
   where i.id = any(p_products) and i.store_id = p_store and coalesce(i.stock_qty, 0) < 0;
  if v is not null then
    perform public._ingest_detail(jsonb_build_object('negative_stock', v));
    return array['negative_stock'];
  end if;
  return '{}';
end $$;

-- photo_replace_not_admin: replacing a stored photo path is an admin's
-- (029:785-789, 030:472-476). Only the keys present in p are compared.
create or replace function public._ingest_photo(p_store uuid, p_actor uuid, p_old public.sales, p jsonb) returns text[]
language plpgsql security definer set search_path = public as $$
begin
  if public._is_store_admin_for(p_actor, p_store) then
    return '{}';
  end if;
  if (p ? 'rx_image_path' and p_old.rx_image_path is not null
      and (p ->> 'rx_image_path') is distinct from p_old.rx_image_path)
     or (p ? 'frame_image_path' and p_old.frame_image_path is not null
         and (p ->> 'frame_image_path') is distinct from p_old.frame_image_path) then
    return array['photo_replace_not_admin'];
  end if;
  return '{}';
end $$;

-- The lines of a sale, as sent (ids, prices, discounts verbatim).
create or replace function public._ingest_items(p_store uuid, p_sale uuid, p_at timestamptz, p_items jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.sale_items
    (id, sale_id, store_id, product_id, qty, unit_price, total_price, name, discount, discount_reason, created_at)
  select r.id, p_sale, p_store, r.product_id, r.qty, r.unit_price, coalesce(r.total_price, r.qty * r.unit_price),
         r.name, coalesce(r.discount, 0), r.discount_reason, p_at
    from jsonb_populate_recordset(null::public.sale_items, p_items) r
$$;

-- The examinations of a sale; a missing doctor takes p_doctor (the
-- checkout's rule, 030:385-393; replace_order_examinations passes none).
create or replace function public._ingest_exams(p_store uuid, p_sale uuid, p_at timestamptz, p_exams jsonb, p_doctor text)
returns void
language sql security definer set search_path = public as $$
  insert into public.order_examinations
    (id, sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od, sphere_os, cylinder_os, axis_os,
     ipd, lens_info, frame_info, frame_color, frame_status, doctor_name, image_path, created_at)
  select r.id, p_sale, p_store, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od, r.sphere_os, r.cylinder_os,
         r.axis_os, r.ipd, r.lens_info, r.frame_info, r.frame_color, r.frame_status,
         coalesce(r.doctor_name, p_doctor), r.image_path, p_at
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r
$$;

-- Ledger rows as sent, positive before negative (the amount_paid >= 0 CHECK
-- is evaluated per row): kind payment/refund by sign, paid_at = t,
-- recorded_by = the op's actor (never the column default auth.uid(), the
-- register login, which fails its foreign key).
create or replace function public._ingest_ledger(p_store uuid, p_actor uuid, p_at timestamptz, p_sale uuid,
                                                 p_rows jsonb, p_refund_note text)
returns void
language sql security definer set search_path = public as $$
  insert into public.sale_payments (id, sale_id, amount, method, kind, note, paid_at, store_id, recorded_by, created_at)
  select (e ->> 'id')::uuid, p_sale, (e ->> 'amount')::numeric, e ->> 'method',
         case when (e ->> 'amount')::numeric > 0 then 'payment' else 'refund' end,
         case when (e ->> 'amount')::numeric < 0 then p_refund_note end,
         p_at, p_store, p_actor, p_at
    from jsonb_array_elements(p_rows) e
   order by (e ->> 'amount')::numeric desc, e ->> 'method'
$$;

-- sale.create (design 3.6): the header {id, invoice_no, idempotency_key,
-- customer_id, kind, total_amount, discount, net_amount, payment_method,
-- delivery_date, doctor_name, lab_status, rx_image_path, frame_image_path,
-- renumbered_from?}, items[{id, product_id, name, qty, unit_price,
-- total_price, discount, discount_reason, movement_id}], exams[{id, ...}],
-- payments[{id, method, amount > 0}]. Every row as sent, at t; one 'sale'
-- movement per line with a product; amount_paid follows the ledger (012);
-- invoice_counter raised to at least the number + 1 (design 2.6).
create or replace function public._ingest_sale_create(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := public._ingest_id(p, 'id');
  v_inv   text := nullif(btrim(p ->> 'invoice_no'), '');
  v_items jsonb := public._ingest_arr(p, 'items');
  v_exams jsonb := public._ingest_arr(p, 'exams');
  v_pays  jsonb := public._ingest_arr(p, 'payments');
  v_total numeric := public._ingest_num(p, 'total_amount');
  v_disc  numeric := public._ingest_num(p, 'discount');
  v_net   numeric := public._ingest_num(p, 'net_amount');
  v_kind  text := coalesce(nullif(p ->> 'kind', ''), 'sale');
  v_cust  uuid;
  v_idem  uuid;
  v_paid  numeric;
  v_flags text[] := '{}';
begin
  if v_inv is null then
    raise exception 'malformed: invoice_no' using errcode = '22023';
  end if;
  perform public._ingest_ref('sales', v_id, p_store);
  v_cust := public._ingest_opt_ref(p, 'customer_id', 'customers', p_store);
  if jsonb_typeof(p -> 'idempotency_key') is not null and jsonb_typeof(p -> 'idempotency_key') <> 'null' then
    v_idem := public._ingest_id(p, 'idempotency_key');
  end if;
  perform public._ingest_items_check(p_store, v_items, true);
  perform public._ingest_rows(v_exams, 'exams', 'id', 'order_examinations', p_store);
  perform public._ingest_pay_check(p_store, v_pays, 'payments', 1);

  v_flags := v_flags || public._ingest_price_changed(p_store, v_items);

  insert into public.sales
    (id, store_id, invoice_no, idempotency_key, customer_id, user_id, total_amount, discount, net_amount,
     amount_paid, payment_method, order_date, delivery_date, doctor_name, lab_status, rx_image_path,
     frame_image_path, kind, created_at)
  values
    (v_id, p_store, v_inv, v_idem, v_cust, p_actor, v_total, v_disc, v_net,
     0, coalesce(p ->> 'payment_method', 'Cash'), p_at, (p ->> 'delivery_date')::timestamptz, p ->> 'doctor_name',
     p ->> 'lab_status', p ->> 'rx_image_path', p ->> 'frame_image_path', v_kind, p_at);
  perform public._ingest_items(p_store, v_id, p_at, v_items);
  insert into public.stock_movements (id, product_id, store_id, qty, type, ref_no, note, created_at)
  select (e ->> 'movement_id')::uuid, (e ->> 'product_id')::uuid, p_store, -(e ->> 'qty')::integer, 'sale',
         v_inv, 'POS Sale: ' || v_inv, p_at
    from jsonb_array_elements(v_items) e
   where public._ingest_uuid(e ->> 'product_id') is not null;
  perform public._ingest_exams(p_store, v_id, p_at, v_exams, p ->> 'doctor_name');
  perform public._ingest_ledger(p_store, p_actor, p_at, v_id, v_pays, null);

  -- design 2.6: the counter never hands out a number the PC already used
  if v_inv ~ '^[0-9]{1,18}$' then
    insert into public.invoice_counter (store_id, prefix, next_val)
    select p_store, '', coalesce(max(case when s.invoice_no ~ '^[0-9]{1,18}$' then s.invoice_no::bigint end), 0) + 1
      from public.sales s where s.store_id = p_store
    on conflict (store_id, prefix) do update
      set next_val = greatest(public.invoice_counter.next_val, excluded.next_val);
  end if;

  -- findings
  select coalesce(sum((e ->> 'amount')::numeric), 0) into v_paid from jsonb_array_elements(v_pays) e;
  if exists (select 1 from jsonb_array_elements(v_pays) e where not public._ingest_tender_ok(e ->> 'method')) then
    v_flags := v_flags || 'unknown_tender'::text;
  end if;
  if v_paid > v_net + 0.01 then
    v_flags := v_flags || 'overpaid'::text;
    perform public._ingest_detail(jsonb_build_object('overpaid', jsonb_build_object('paid', v_paid, 'net', v_net)));
  end if;
  v_flags := v_flags || public._ingest_header_rule(v_items, v_total, v_disc, v_net);
  -- 022/030:321-329: 'prescription' only for a zero-total, unpaid cart
  if v_kind is distinct from (case when v_kind = 'prescription' and v_total = 0 and v_paid = 0
                                   then 'prescription' else 'sale' end) then
    v_flags := v_flags || 'kind_rule'::text;
  end if;
  if jsonb_typeof(p -> 'renumbered_from') is not null and jsonb_typeof(p -> 'renumbered_from') <> 'null' then
    v_flags := v_flags || 'invoice_renumbered'::text;
    perform public._ingest_detail(jsonb_build_object('renumbered_from', p -> 'renumbered_from', 'invoice_no', v_inv));
  end if;
  v_flags := v_flags || public._ingest_neg_stock(p_store,
    array(select distinct (e ->> 'product_id')::uuid from jsonb_array_elements(v_items) e
           where public._ingest_uuid(e ->> 'product_id') is not null));
  return v_flags;
end $$;

-- sale.recheckout (design 3.6, 030:419-703 on the register path):
-- {sale_id, customer_id, total_amount, discount, net_amount, payment_method,
-- delivery_date, doctor_name, lab_status, rx_image_path, frame_image_path,
-- items[full, with ids], exams[full, with ids], movements[{id, product_id,
-- qty}], payments[{id, method, amount <> 0}] (the per-method DELTAS the PC
-- appended), expect{paid, tenders}}. Items and exams are replaced; the
-- ledger and the stock are appended to (never deleted). customer_id,
-- payment_method and doctor_name keep the old value when null (030:635-637);
-- the other header fields are set as sent. The money columns change under
-- lensy.money_write, set just before the header UPDATE and cleared after the
-- last ledger row (design 3.6, the 030:630-697 order).
create or replace function public._ingest_sale_recheckout(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old   public.sales := public._ingest_sale(p, p_store, true);
  v_items jsonb := public._ingest_arr(p, 'items');
  v_exams jsonb := public._ingest_arr(p, 'exams');
  v_moves jsonb := public._ingest_arr(p, 'movements');
  v_pays  jsonb := public._ingest_arr(p, 'payments');
  v_total numeric := public._ingest_num(p, 'total_amount');
  v_disc  numeric := public._ingest_num(p, 'discount');
  v_net   numeric := public._ingest_num(p, 'net_amount');
  v_cust  uuid := public._ingest_opt_ref(p, 'customer_id', 'customers', p_store);
  v_flags text[] := '{}';
  v_led   numeric;
  v_sum   numeric;
  v_x     jsonb;
  v_e     jsonb;
begin
  perform public._ingest_items_check(p_store, v_items, false);
  perform public._ingest_rows(v_exams, 'exams', 'id', 'order_examinations', p_store);
  perform public._ingest_rows(v_moves, 'movements', 'id', 'stock_movements', p_store);
  for v_e in select x from jsonb_array_elements(v_moves) x loop
    if public._ingest_uuid(v_e ->> 'product_id') is null then
      raise exception 'malformed: movements.product_id' using errcode = '22023';
    end if;
    perform public._ingest_ref('inventory', (v_e ->> 'product_id')::uuid, p_store);
    if jsonb_typeof(v_e -> 'qty') <> 'number' or (v_e ->> 'qty') !~ '^-?[0-9]{1,9}$' or (v_e ->> 'qty')::integer = 0 then
      raise exception 'malformed: movements.qty' using errcode = '22023';
    end if;
  end loop;
  perform public._ingest_pay_check(p_store, v_pays, 'payments', 0);

  -- findings on the state before the op
  v_flags := v_flags || public._ingest_expect(v_old.id, p -> 'expect');
  select coalesce(sum(sp.amount), 0) into v_led from public.sale_payments sp where sp.sale_id = v_old.id;
  select coalesce(sum((e ->> 'amount')::numeric), 0) into v_sum from jsonb_array_elements(v_pays) e;
  if v_sum < -0.005 then                                   -- 030:576-587
    v_flags := v_flags || 'refund_first'::text;
    perform public._ingest_detail(jsonb_build_object('refund_first', jsonb_build_object('ledger', v_led, 'back', -v_sum)));
  end if;
  if exists (select 1 from jsonb_array_elements(v_pays) e
              where (e ->> 'amount')::numeric > 0 and not public._ingest_tender_ok(e ->> 'method')) then
    v_flags := v_flags || 'unknown_tender'::text;           -- 030:610-617: a legacy tender takes no new money
  end if;
  if exists (select 1 from jsonb_array_elements(v_pays) e where (e ->> 'amount')::numeric < 0) then
    v_flags := v_flags || public._ingest_can(p_store, p_actor, 'history.refund');   -- 030:622-624
  end if;
  if (p ->> 'lab_status') is distinct from v_old.lab_status then
    v_flags := v_flags || public._ingest_can(p_store, p_actor, 'lab.edit');         -- 030:470-471
  end if;
  v_flags := v_flags || public._ingest_photo(p_store, p_actor, v_old,
    jsonb_build_object('rx_image_path', p -> 'rx_image_path', 'frame_image_path', p -> 'frame_image_path'));
  v_flags := v_flags || public._ingest_price_changed(p_store, v_items);
  -- the movements must be what 030:657-675 appends: per product, the change
  -- of the quantity this sale holds
  with o as (
    select sm.product_id, -sum(sm.qty) as q
      from public.stock_movements sm
     where sm.type = 'sale' and sm.ref_no = v_old.invoice_no and sm.store_id = p_store
     group by sm.product_id
  ), n as (
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'qty')::integer) as q
      from jsonb_array_elements(v_items) e
     where public._ingest_uuid(e ->> 'product_id') is not null
     group by 1
  ), d as (
    select coalesce(n.product_id, o.product_id) as product_id, -(coalesce(n.q, 0) - coalesce(o.q, 0)) as q
      from o full join n on n.product_id = o.product_id
     where coalesce(n.q, 0) <> coalesce(o.q, 0)
  ), s as (
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'qty')::integer) as q
      from jsonb_array_elements(v_moves) e
     group by 1
  )
  select jsonb_agg(jsonb_build_object('product_id', coalesce(d.product_id, s.product_id), 'rule', coalesce(d.q, 0),
                                      'sent', coalesce(s.q, 0)))
    into v_x
    from d full join s on s.product_id = d.product_id
   where coalesce(d.q, 0) <> coalesce(s.q, 0);
  if v_x is not null then
    v_flags := v_flags || 'divergence'::text;
    perform public._ingest_detail(jsonb_build_object('movements', v_x));
  end if;

  -- the writes, in 030's order
  delete from public.sale_items         where sale_id = v_old.id;
  delete from public.order_examinations where sale_id = v_old.id;
  perform set_config('lensy.money_write', '1', true);
  update public.sales
     set total_amount     = v_total,
         discount         = v_disc,
         net_amount       = v_net,
         payment_method   = coalesce(p ->> 'payment_method', payment_method),
         customer_id      = coalesce(v_cust, customer_id),
         doctor_name      = coalesce(p ->> 'doctor_name', doctor_name),
         delivery_date    = (p ->> 'delivery_date')::timestamptz,
         lab_status       = p ->> 'lab_status',
         rx_image_path    = p ->> 'rx_image_path',
         frame_image_path = p ->> 'frame_image_path'
   where id = v_old.id;
  perform public._ingest_items(p_store, v_old.id, p_at, v_items);
  insert into public.stock_movements (id, product_id, store_id, qty, type, ref_no, note, created_at)
  select (e ->> 'id')::uuid, (e ->> 'product_id')::uuid, p_store, (e ->> 'qty')::integer, 'sale',
         v_old.invoice_no, 'POS Re-checkout: ' || coalesce(v_old.invoice_no, ''), p_at
    from jsonb_array_elements(v_moves) e;
  perform public._ingest_exams(p_store, v_old.id, p_at, v_exams, coalesce(p ->> 'doctor_name', v_old.doctor_name));
  perform public._ingest_ledger(p_store, p_actor, p_at, v_old.id, v_pays,
                                'Re-checkout refund ' || coalesce(v_old.invoice_no, ''));
  perform set_config('lensy.money_write', '', true);

  -- findings on the state after the op (a tender this op took money off
  -- now holds less than nothing: 028's per-tender ceiling)
  select jsonb_agg(jsonb_build_object('method', x.method, 'held', x.a)) into v_x
    from (select sp.method, sum(sp.amount) as a from public.sale_payments sp
           where sp.sale_id = v_old.id
             and sp.method in (select e ->> 'method' from jsonb_array_elements(v_pays) e
                                where (e ->> 'amount')::numeric < 0)
           group by sp.method having sum(sp.amount) < -0.005) x;
  if v_x is not null then
    v_flags := v_flags || 'refund_exceeds_tender'::text;
    perform public._ingest_detail(jsonb_build_object('refund_exceeds_tender', v_x));
  end if;
  if v_led + v_sum > v_net + 0.01 then
    v_flags := v_flags || 'overpaid'::text;
    perform public._ingest_detail(jsonb_build_object('overpaid', jsonb_build_object('paid', v_led + v_sum, 'net', v_net)));
  end if;
  v_flags := v_flags || public._ingest_header_rule(v_items, v_total, v_disc, v_net);
  v_flags := v_flags || public._ingest_neg_stock(p_store,
    array(select distinct (e ->> 'product_id')::uuid from jsonb_array_elements(v_moves) e
           where (e ->> 'qty')::integer < 0));
  return v_flags;
end $$;

-- sale.header {sale_id, doctor_name?, delivery_date?, rx_image_path?,
-- frame_image_path?, lab_status?}: History's whitelist (029:780-783); only
-- the keys present are written (a PATCH). Applied on a voided sale with
-- edit_voided. A lab_status change needs lab.edit (and is stamped with t).
create or replace function public._ingest_sale_header(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old   public.sales := public._ingest_sale(p, p_store, false);
  v_flags text[] := '{}';
begin
  if jsonb_typeof(p -> 'lab_status') not in ('null')
     and (p ->> 'lab_status') not in ('Not Started', 'In Lab', 'Ready', 'Received') then
    raise exception 'malformed: lab_status' using errcode = '22023';
  end if;
  if v_old.voided_at is not null then
    v_flags := v_flags || 'edit_voided'::text;
  end if;
  if p ? 'lab_status' and (p ->> 'lab_status') is distinct from v_old.lab_status then
    v_flags := v_flags || public._ingest_can(p_store, p_actor, 'lab.edit');
  end if;
  v_flags := v_flags || public._ingest_photo(p_store, p_actor, v_old, p);
  update public.sales
     set doctor_name      = case when p ? 'doctor_name' then p ->> 'doctor_name' else doctor_name end,
         delivery_date    = case when p ? 'delivery_date' then (p ->> 'delivery_date')::timestamptz else delivery_date end,
         rx_image_path    = case when p ? 'rx_image_path' then p ->> 'rx_image_path' else rx_image_path end,
         frame_image_path = case when p ? 'frame_image_path' then p ->> 'frame_image_path' else frame_image_path end,
         lab_status       = case when p ? 'lab_status' then p ->> 'lab_status' else lab_status end
   where id = v_old.id;
  return v_flags;
end $$;

-- sale.exams {sale_id, exams[full, with ids]}: replaced (029:758-770, the
-- doctor as sent). Applied on a voided sale with edit_voided.
create or replace function public._ingest_sale_exams(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old   public.sales := public._ingest_sale(p, p_store, false);
  v_exams jsonb;
begin
  if jsonb_typeof(p -> 'exams') is distinct from 'array' then
    raise exception 'malformed: exams' using errcode = '22023';
  end if;
  v_exams := p -> 'exams';
  perform public._ingest_rows(v_exams, 'exams', 'id', 'order_examinations', p_store);
  delete from public.order_examinations where sale_id = v_old.id;
  perform public._ingest_exams(p_store, v_old.id, p_at, v_exams, null);
  return case when v_old.voided_at is not null then array['edit_voided'] else '{}'::text[] end;
end $$;

-- sale.lab_status {sale_id, status}: the vocabulary of 029:748-756 (else
-- MAL); a sale with no lab order (lab_status null) is a STATE hold; applied
-- on a voided sale with edit_voided. lab_status_stamp (033) dates it t.
create or replace function public._ingest_sale_lab_status(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_status text := p ->> 'status';
  v_old    public.sales;
begin
  if v_status is null or v_status not in ('Not Started', 'In Lab', 'Ready', 'Received') then
    raise exception 'malformed: status' using errcode = '22023';
  end if;
  v_old := public._ingest_sale(p, p_store, false);
  if v_old.lab_status is null then
    raise exception 'state: sale % has no lab order', v_old.id;
  end if;
  update public.sales set lab_status = v_status where id = v_old.id;
  return case when v_old.voided_at is not null then array['edit_voided'] else '{}'::text[] end;
end $$;

-- payment.collect {sale_id, lines[{id, method, amount > 0}], expect}
-- (029:800-817): payment rows at t on a live sale.
create or replace function public._ingest_payment_collect(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old   public.sales := public._ingest_sale(p, p_store, true);
  v_lines jsonb := public._ingest_arr(p, 'lines');
  v_flags text[] := '{}';
  v_sum   numeric;
begin
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'malformed: lines' using errcode = '22023';
  end if;
  perform public._ingest_pay_check(p_store, v_lines, 'lines', 1);
  v_flags := v_flags || public._ingest_expect(v_old.id, p -> 'expect');
  if exists (select 1 from jsonb_array_elements(v_lines) e where not public._ingest_tender_ok(e ->> 'method')) then
    v_flags := v_flags || 'unknown_tender'::text;
  end if;
  select sum((e ->> 'amount')::numeric) into v_sum from jsonb_array_elements(v_lines) e;
  if v_sum > coalesce(v_old.net_amount, 0) - coalesce(v_old.amount_paid, 0) then   -- 029:812
    v_flags := v_flags || 'overpaid'::text;
    perform public._ingest_detail(jsonb_build_object('overpaid', jsonb_build_object(
      'collected', v_sum, 'balance', coalesce(v_old.net_amount, 0) - coalesce(v_old.amount_paid, 0))));
  end if;
  perform public._ingest_ledger(p_store, p_actor, p_at, v_old.id, v_lines, null);
  return v_flags;
end $$;

-- sale.refund {sale_id, row{id, method, amount > 0}, note, expect}
-- (028:96-169): one refund row of -amount on the EXACT stored method, at t;
-- its note is 028's ('Refund <invoice>[: <note>]').
create or replace function public._ingest_sale_refund(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old   public.sales := public._ingest_sale(p, p_store, true);
  v_row   jsonb := p -> 'row';
  v_flags text[] := '{}';
  v_amt   numeric;
  v_here  numeric;
begin
  if jsonb_typeof(v_row) is distinct from 'object' then
    raise exception 'malformed: row' using errcode = '22023';
  end if;
  perform public._ingest_pay_check(p_store, jsonb_build_array(v_row), 'row', 1);
  v_amt := (v_row ->> 'amount')::numeric;
  v_flags := v_flags || public._ingest_expect(v_old.id, p -> 'expect');
  select coalesce(sum(sp.amount), 0) into v_here
    from public.sale_payments sp where sp.sale_id = v_old.id and sp.method = v_row ->> 'method';
  if v_amt > v_here then                                            -- 028:143-151
    v_flags := v_flags || 'refund_exceeds_tender'::text;
    perform public._ingest_detail(jsonb_build_object('refund_exceeds_tender', jsonb_build_object(
      'method', v_row ->> 'method', 'refund', v_amt, 'held', v_here)));
  end if;
  insert into public.sale_payments (id, sale_id, amount, method, kind, note, paid_at, store_id, recorded_by, created_at)
  values ((v_row ->> 'id')::uuid, v_old.id, -v_amt, v_row ->> 'method', 'refund',
          'Refund ' || coalesce(v_old.invoice_no, '')
            || case when p ->> 'note' is null or btrim(p ->> 'note') = '' then '' else ': ' || (p ->> 'note') end,
          p_at, p_store, p_actor, p_at);
  return v_flags;
end $$;

-- sale.void {sale_id, reason, refunds[{id, method, amount < 0}],
-- restock[{id, product_id, qty > 0}], expect} (030:712-785): the rows as
-- sent (restock 'return' movements, then the refunds), then voided_at = t,
-- voided_by = the actor. void_derivation_differs when they are not what
-- 030 derives (one refund per exact method still held; restock = the sale's
-- lines, or nothing); void_not_zero when the ledger does not end at 0.
create or replace function public._ingest_sale_void(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_old     public.sales := public._ingest_sale(p, p_store, true);
  v_refunds jsonb := public._ingest_arr(p, 'refunds');
  v_restock jsonb := public._ingest_arr(p, 'restock');
  v_reason  text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  v_flags   text[] := '{}';
  v_after   numeric;
  v_e       jsonb;
begin
  perform public._ingest_pay_check(p_store, v_refunds, 'refunds', -1);
  perform public._ingest_rows(v_restock, 'restock', 'id', 'stock_movements', p_store);
  for v_e in select x from jsonb_array_elements(v_restock) x loop
    if public._ingest_uuid(v_e ->> 'product_id') is null then
      raise exception 'malformed: restock.product_id' using errcode = '22023';
    end if;
    perform public._ingest_ref('inventory', (v_e ->> 'product_id')::uuid, p_store);
    if jsonb_typeof(v_e -> 'qty') <> 'number' or (v_e ->> 'qty') !~ '^[0-9]{1,9}$' or (v_e ->> 'qty')::integer = 0 then
      raise exception 'malformed: restock.qty' using errcode = '22023';
    end if;
  end loop;

  v_flags := v_flags || public._ingest_expect(v_old.id, p -> 'expect');
  if exists (
       with srv as (
         select sp.method as m, -sum(sp.amount) as a
           from public.sale_payments sp where sp.sale_id = v_old.id
          group by sp.method having sum(sp.amount) > 0
       ), pc as (
         select e ->> 'method' as m, sum((e ->> 'amount')::numeric) as a
           from jsonb_array_elements(v_refunds) e group by 1
       )
       select 1 from srv full join pc on pc.m = srv.m where coalesce(srv.a, 0) <> coalesce(pc.a, 0))
     or (jsonb_array_length(v_restock) > 0 and exists (
       with srv as (
         select si.product_id as id, sum(si.qty) as q
           from public.sale_items si where si.sale_id = v_old.id and si.product_id is not null and si.qty > 0
          group by 1
       ), pc as (
         select (e ->> 'product_id')::uuid as id, sum((e ->> 'qty')::integer) as q
           from jsonb_array_elements(v_restock) e group by 1
       )
       select 1 from srv full join pc on pc.id = srv.id where coalesce(srv.q, 0) <> coalesce(pc.q, 0))) then
    v_flags := v_flags || 'void_derivation_differs'::text;
    perform public._ingest_detail(jsonb_build_object('void_derivation', jsonb_build_object(
      'refunds', (select coalesce(jsonb_object_agg(x.method, x.a), '{}'::jsonb)
                    from (select sp.method, -sum(sp.amount) as a from public.sale_payments sp
                           where sp.sale_id = v_old.id group by sp.method having sum(sp.amount) > 0) x),
      'restock', (select coalesce(jsonb_object_agg(x.id, x.q), '{}'::jsonb)
                    from (select si.product_id as id, sum(si.qty) as q from public.sale_items si
                           where si.sale_id = v_old.id and si.product_id is not null and si.qty > 0 group by 1) x))));
  end if;

  insert into public.stock_movements (id, product_id, store_id, qty, type, ref_no, note, created_at)
  select (e ->> 'id')::uuid, (e ->> 'product_id')::uuid, p_store, (e ->> 'qty')::integer, 'return', v_old.invoice_no,
         'Void ' || coalesce(v_old.invoice_no, '') || case when v_reason is null then '' else ': ' || v_reason end, p_at
    from jsonb_array_elements(v_restock) e;
  perform public._ingest_ledger(p_store, p_actor, p_at, v_old.id, v_refunds, 'Void ' || coalesce(v_old.invoice_no, ''));
  update public.sales
     set voided_at = p_at, voided_by = p_actor, void_reason = v_reason
   where id = v_old.id;

  select coalesce(sum(sp.amount), 0) into v_after from public.sale_payments sp where sp.sale_id = v_old.id;
  if abs(v_after) > 0.005 then
    v_flags := v_flags || 'void_not_zero'::text;
    perform public._ingest_detail(jsonb_build_object('void_not_zero', v_after));
  end if;
  return v_flags;
end $$;

-- shift.close {id, from_at, to_at, counted_cash, expected_cash,
-- expected_by_tender, expected_total, variance?, order_count,
-- prescription_count, void_count, refund_total, lab_delivered, note}: the
-- PC's figures are stored verbatim (closed_at = t, closed_by = the actor);
-- variance must be counted_cash - expected_cash (else MAL); the window
-- CHECK and unique (023:84) hold as INT. z_mismatch when the server's
-- _z_report for the same window differs; both figure sets go to detail.
-- The window is close_shift's (024:121-182): it reads z_report, whose
-- report_window (016:35-43) moves the end up to the next UTC midnight, so
-- the recompute does the same (the PC's zreport.ts ports that rounding).
create or replace function public._ingest_shift_close(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := public._ingest_id(p, 'id');
  v_from    timestamptz := public._ingest_ts(p ->> 'from_at');
  v_to      timestamptz := public._ingest_ts(p ->> 'to_at');
  v_counted numeric := public._ingest_num(p, 'counted_cash');
  v_cash    numeric := public._ingest_num(p, 'expected_cash');
  v_total   numeric := public._ingest_num(p, 'expected_total');
  v_tender  jsonb := coalesce(nullif(p -> 'expected_by_tender', 'null'::jsonb), '{}'::jsonb);
  v_var     numeric;
  v_pc      jsonb;
  v_srv     jsonb;
  z         record;
begin
  if v_from is null then
    raise exception 'malformed: from_at' using errcode = '22023';
  end if;
  if v_to is null then
    raise exception 'malformed: to_at' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tender) <> 'object' then
    raise exception 'malformed: expected_by_tender' using errcode = '22023';
  end if;
  v_var := round(v_counted - v_cash, 2);
  if public._ingest_num(p, 'variance', false) is distinct from v_var and jsonb_typeof(p -> 'variance') = 'number' then
    raise exception 'malformed: variance must be counted_cash - expected_cash' using errcode = '22023';
  end if;
  perform public._ingest_ref('shift_closes', v_id, p_store);
  v_pc := jsonb_build_object(
    'expected_cash', v_cash, 'expected_by_tender', v_tender, 'expected_total', v_total,
    'order_count', coalesce(public._ingest_num(p, 'order_count', false), 0),
    'prescription_count', coalesce(public._ingest_num(p, 'prescription_count', false), 0),
    'void_count', coalesce(public._ingest_num(p, 'void_count', false), 0),
    'refund_total', coalesce(public._ingest_num(p, 'refund_total', false), 0),
    'lab_delivered', coalesce(public._ingest_num(p, 'lab_delivered', false), 0));
  insert into public.shift_closes
    (id, store_id, closed_at, closed_by, from_at, to_at, counted_cash, expected_cash, expected_by_tender,
     expected_total, variance, order_count, prescription_count, void_count, refund_total, lab_delivered, note)
  values
    (v_id, p_store, p_at, p_actor, v_from, v_to, v_counted, v_cash, v_tender, v_total, v_var,
     (v_pc ->> 'order_count')::bigint, (v_pc ->> 'prescription_count')::bigint, (v_pc ->> 'void_count')::bigint,
     (v_pc ->> 'refund_total')::numeric, (v_pc ->> 'lab_delivered')::bigint, nullif(btrim(p ->> 'note'), ''));

  select * into z from public._z_report(p_store, v_from, ((v_to at time zone 'UTC')::date + 1)::timestamptz);
  v_srv := jsonb_build_object(
    'expected_cash', z.expected_cash, 'expected_by_tender', z.expected_by_tender, 'expected_total', z.expected_total,
    'order_count', z.order_count, 'prescription_count', z.prescription_count, 'void_count', z.void_count,
    'refund_total', z.refund_total, 'lab_delivered', z.lab_delivered);
  if v_srv <> v_pc then
    perform public._ingest_detail(jsonb_build_object('z_mismatch', jsonb_build_object('pc', v_pc, 'server', v_srv)));
    return array['z_mismatch'];
  end if;
  return '{}';
end $$;

-- purchase.upsert {id, supplier_id, total_amount, amount_paid,
-- purchase_date, items[{id, product_id, qty, unit_cost, total_cost}]} (the
-- header and its UNRECEIVED lines; a received line is history: sent
-- unchanged it is left alone, changed it is a STATE hold, as is a line of
-- another purchase) / purchase.delete {id} (029:677-706: lines, payments,
-- the purchase; missing -> delete_missing). purchase_date: as sent, else t
-- on a new purchase.
create or replace function public._ingest_purchase(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid := public._ingest_id(p, 'id');
  v_has   boolean := public._ingest_ref('purchases', v_id, p_store);
  v_items jsonb;
  v_sup   uuid;
  v_flags text[];
  r       record;
  v_e     jsonb;
begin
  if p_kind = 'purchase.delete' then
    if not v_has then
      return array['delete_missing'];
    end if;
    delete from public.purchase_items    where purchase_id = v_id;
    delete from public.purchase_payments where purchase_id = v_id;
    delete from public.purchases         where id = v_id and store_id = p_store;
    return '{}';
  end if;

  v_items := public._ingest_arr(p, 'items');
  perform public._ingest_rows(v_items, 'items', 'id', 'purchase_items', p_store);
  for v_e in select x from jsonb_array_elements(v_items) x loop
    perform public._ingest_opt_ref(v_e, 'product_id', 'inventory', p_store);
  end loop;
  v_sup := public._ingest_opt_ref(p, 'supplier_id', 'suppliers', p_store);
  v_flags := public._ingest_can(p_store, p_actor, case when v_has then 'suppliers.edit' else 'suppliers.create' end);

  if v_has then
    update public.purchases
       set supplier_id   = v_sup,
           total_amount  = coalesce(public._ingest_num(p, 'total_amount', false), 0),
           amount_paid   = coalesce(public._ingest_num(p, 'amount_paid', false), 0),
           purchase_date = coalesce((p ->> 'purchase_date')::timestamptz, purchase_date)
     where id = v_id and store_id = p_store;
  else
    insert into public.purchases (id, store_id, supplier_id, total_amount, amount_paid, purchase_date, created_at)
    values (v_id, p_store, v_sup, coalesce(public._ingest_num(p, 'total_amount', false), 0),
            coalesce(public._ingest_num(p, 'amount_paid', false), 0),
            coalesce((p ->> 'purchase_date')::timestamptz, p_at), p_at);
  end if;

  for r in select pi.*, x.product_id as n_product, x.qty as n_qty, x.unit_cost as n_unit, x.total_cost as n_total
             from jsonb_populate_recordset(null::public.purchase_items, v_items) x
             join public.purchase_items pi on pi.id = x.id
            where pi.purchase_id is distinct from v_id
               or (pi.received_at is not null
                   and (pi.product_id is distinct from x.product_id or pi.qty is distinct from coalesce(x.qty, 1)
                        or pi.unit_cost is distinct from coalesce(x.unit_cost, 0)
                        or pi.total_cost is distinct from coalesce(x.total_cost, 0))) loop
    if r.purchase_id is distinct from v_id then
      raise exception 'state: purchase item % belongs to another purchase', r.id;
    end if;
    raise exception 'state: purchase item % is already received', r.id;
  end loop;
  delete from public.purchase_items pi
   where pi.purchase_id = v_id and pi.received_at is null
     and pi.id not in (select (e ->> 'id')::uuid from jsonb_array_elements(v_items) e);
  insert into public.purchase_items (id, purchase_id, store_id, product_id, qty, unit_cost, total_cost, created_at)
  select x.id, v_id, p_store, x.product_id, coalesce(x.qty, 1), coalesce(x.unit_cost, 0), coalesce(x.total_cost, 0), p_at
    from jsonb_populate_recordset(null::public.purchase_items, v_items) x
   where not exists (select 1 from public.purchase_items pi where pi.id = x.id and pi.received_at is not null)
  on conflict (id) do update
    set product_id = excluded.product_id, qty = excluded.qty, unit_cost = excluded.unit_cost,
        total_cost = excluded.total_cost;
  return v_flags;
end $$;

-- purchase.payment.add {id, purchase_id, amount, paid_at?, note} (paid_at,
-- a date: as sent, else the store's local day of t) /
-- purchase.payment.delete {id} (missing -> delete_missing).
create or replace function public._ingest_purchase_payment(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id  uuid := public._ingest_id(p, 'id');
  v_has boolean := public._ingest_ref('purchase_payments', v_id, p_store);
  v_pid uuid;
begin
  if p_kind = 'purchase.payment.delete' then
    if not v_has then
      return array['delete_missing'];
    end if;
    delete from public.purchase_payments where id = v_id and store_id = p_store;
    return '{}';
  end if;
  v_pid := public._ingest_id(p, 'purchase_id');
  perform public._ingest_ref('purchases', v_pid, p_store);       -- missing everywhere: its FK holds INT
  insert into public.purchase_payments (id, purchase_id, store_id, amount, paid_at, note, created_at)
  values (v_id, v_pid, p_store, public._ingest_num(p, 'amount'),
          coalesce((p ->> 'paid_at')::date, (p_at at time zone public.store_time_zone_for(p_store))::date),
          p ->> 'note', p_at);
  return '{}';
end $$;

-- purchase.receive {purchase_id, lines[{item_id, movement_id}],
-- cost_after{product_id: cost}} (032's receive_purchase): per line, in the
-- order sent, a 'purchase' movement of the line's qty at t, the weighted
-- cost against the stock held BEFORE it, received_at = t. A missing
-- purchase or line, a line of another purchase, already received, without
-- a product or with qty <= 0 is a STATE hold. Then the PC's cost_after is
-- stored for every product received (cost_mismatch, with both figures in
-- detail, when it differs from the server's).
create or replace function public._ingest_purchase_receive(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_pid   uuid := public._ingest_id(p, 'purchase_id');
  v_lines jsonb := public._ingest_arr(p, 'lines');
  v_cost  jsonb := p -> 'cost_after';
  v_item  uuid;
  v_mid   uuid;
  v_old   integer;
  v_srv   numeric;
  v_pc    numeric;
  v_prod  uuid;
  v_done  uuid[] := '{}';
  v_miss  jsonb := '[]';
  r       public.purchase_items;
  v_e     jsonb;
begin
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'malformed: lines' using errcode = '22023';
  end if;
  if jsonb_typeof(v_cost) is distinct from 'object' then
    raise exception 'malformed: cost_after' using errcode = '22023';
  end if;
  if not public._ingest_ref('purchases', v_pid, p_store) then
    raise exception 'state: purchase % is missing', v_pid;
  end if;
  for v_e in select x from jsonb_array_elements(v_lines) x loop
    v_item := public._ingest_uuid(v_e ->> 'item_id');
    v_mid  := public._ingest_uuid(v_e ->> 'movement_id');
    if v_item is null then
      raise exception 'malformed: lines.item_id' using errcode = '22023';
    end if;
    if v_mid is null then
      raise exception 'malformed: lines.movement_id' using errcode = '22023';
    end if;
    perform public._ingest_ref('stock_movements', v_mid, p_store);
    if not public._ingest_ref('purchase_items', v_item, p_store) then
      raise exception 'state: purchase item % is missing', v_item;
    end if;
    select * into r from public.purchase_items where id = v_item for update;
    if r.purchase_id is distinct from v_pid then
      raise exception 'state: purchase item % belongs to another purchase', v_item;
    end if;
    if r.received_at is not null then
      raise exception 'state: purchase item % is already received', v_item;
    end if;
    if r.product_id is null or coalesce(r.qty, 0) <= 0 then
      raise exception 'state: purchase item % has no product or no quantity', v_item;
    end if;
    insert into public.stock_movements (id, product_id, store_id, qty, type, ref_no, note, created_at)
    values (v_mid, r.product_id, p_store, r.qty, 'purchase', v_pid::text,
            format('Received from purchase %s', v_pid), p_at);
    select coalesce(i.stock_qty, 0) - r.qty into v_old
      from public.inventory i where i.id = r.product_id and i.store_id = p_store;
    update public.inventory
       set cost_price = case when v_old > 0
                             then round((v_old * coalesce(cost_price, 0) + r.qty * coalesce(r.unit_cost, 0))
                                        / (v_old + r.qty)::numeric, 2)
                             else coalesce(r.unit_cost, cost_price) end
     where id = r.product_id and store_id = p_store;
    update public.purchase_items set received_at = p_at where id = v_item;
    v_done := v_done || r.product_id;
  end loop;

  foreach v_prod in array array(select distinct x from unnest(v_done) x order by x) loop
    if jsonb_typeof(v_cost -> v_prod::text) is distinct from 'number' then
      raise exception 'malformed: cost_after.%', v_prod using errcode = '22023';
    end if;
    v_pc := (v_cost ->> v_prod::text)::numeric;
    select i.cost_price into v_srv from public.inventory i where i.id = v_prod;
    if v_srv is distinct from v_pc then
      v_miss := v_miss || jsonb_build_object('product_id', v_prod, 'pc', v_pc, 'server', v_srv);
      update public.inventory set cost_price = v_pc where id = v_prod and store_id = p_store;
    end if;
  end loop;
  if jsonb_array_length(v_miss) > 0 then
    perform public._ingest_detail(jsonb_build_object('cost_mismatch', v_miss));
    return array['cost_mismatch'];
  end if;
  return '{}';
end $$;

-- ============================================================
-- 6) the staff and RBAC writers (step 3; header part 7)
-- ============================================================
-- A target the register may never change (design 2.7, 3.4): the store's
-- owner, a cloud login (033's is_cloud_principal: an auth login whose row is
-- not register-local, 'register-convert' included), a platform admin, or a
-- register login. A converted cashier (register-local, banned auth login) is
-- NOT protected: the PC manages it.
create or replace function public._ingest_protected(p_store uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user is not null and (
       exists (select 1 from public.stores s where s.id = p_store and s.owner_uid = p_user)
    or public.is_cloud_principal(p_user)
    or exists (select 1 from public.platform_admins pa where pa.auth_uid = p_user)
    or exists (select 1 from public.store_registers r where r.register_uid = p_user))
$$;

-- An admin/owner position (029's is_store_admin names).
create or replace function public._ingest_admin_role(p_role uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select lower(btrim(r.name)) in ('admin', 'owner') from public.roles r where r.id = p_role), false)
$$;

-- max_staff: the licence's limit reached by the store's ACTIVE users (031).
create or replace function public._ingest_seats_full(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select l.max_staff is not null
                          and (select count(*) from public.users u
                                where u.store_id = p_store and u.is_active is true) >= l.max_staff
                     from public.store_licenses l where l.store_id = p_store), false)
$$;

-- A permission code of the catalogue (exactly, as 029's RPCs), else MAL.
create or replace function public._ingest_code(p jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if jsonb_typeof(p -> 'code') is distinct from 'string'
     or not ((p ->> 'code') = any(public.supported_permissions())) then
    raise exception 'malformed: code' using errcode = '22023';
  end if;
  return p ->> 'code';
end $$;

-- staff.create {id, username, full_name?, role_id?, is_active?}: a new
-- register-local cashier with the PC's id (design 2.7).
create or replace function public._ingest_staff_create(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id     uuid := public._ingest_id(p, 'id');
  v_name   text;
  v_role   uuid;
  v_active boolean := true;
  v_flags  text[] := '{}';
begin
  perform public._ingest_ref('users', v_id, p_store);       -- another store's staff -> refused
  if exists (select 1 from auth.users a where a.id = v_id)
     or exists (select 1 from public.platform_admins pa where pa.auth_uid = v_id)
     or exists (select 1 from public.store_registers r where r.register_uid = v_id) then
    raise exception 'refused: protected_target'
      using detail = format('staff.create of %s: a login, a vendor account or a register login', v_id);
  end if;
  if jsonb_typeof(p -> 'username') is distinct from 'string' then
    raise exception 'malformed: username' using errcode = '22023';
  end if;
  v_name := p ->> 'username';
  if lower(btrim(v_name)) in ('superadmin', 'register') then
    raise exception 'refused: reserved_name' using detail = format('username %s is reserved', v_name);
  end if;
  if v_name !~ '^[^@[:space:]]{2,32}$' then
    raise exception 'malformed: username' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'full_name') not in ('string', 'null') then
    raise exception 'malformed: full_name' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'is_active') not in ('boolean', 'null') then
    raise exception 'malformed: is_active' using errcode = '22023';
  end if;
  v_active := coalesce((p ->> 'is_active')::boolean, true);
  v_role := public._ingest_opt_ref(p, 'role_id', 'roles', p_store);

  if public._ingest_admin_role(v_role) and not public._is_store_admin_for(p_actor, p_store) then
    v_flags := v_flags || 'assign_admin'::text;
  end if;
  if v_active and public._ingest_seats_full(p_store) then
    v_flags := v_flags || 'max_staff'::text;
  end if;
  insert into public.users (id, username, password_hash, full_name, role_id, is_active, created_at, store_id)
  values (v_id, v_name, 'register-local', p ->> 'full_name', v_role, v_active, p_at, p_store);
  return v_flags;
end $$;

-- staff.set_access {user_id, role_id?, active, via_command?} and
-- staff.update_profile {user_id, full_name} (029:166-182, 031:152-178 as
-- flags; protected targets and bad commands refused).
create or replace function public._ingest_staff_update(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id     uuid := public._ingest_id(p, 'user_id');
  v_has    boolean := public._ingest_ref('users', v_id, p_store);
  v_old    public.users;
  v_cmd    uuid;
  v_role   uuid;
  v_active boolean;
  v_flags  text[] := '{}';
begin
  -- An owner command applied by the PC (design 2.7): only a switch-off of
  -- the user an unapplied command of this store names. Checked first: a
  -- forger may use it only to do exactly what the owner asked.
  if p ? 'via_command' then
    v_cmd := public._ingest_uuid(p ->> 'via_command');
    if p_kind <> 'staff.set_access' or v_cmd is null
       or (p -> 'active') is distinct from 'false'::jsonb
       or not exists (select 1 from public.register_commands c
                       where c.id = v_cmd and c.store_id = p_store and c.user_id = v_id
                         and c.kind = 'staff.deactivate' and c.applied_seq is null) then
      raise exception 'refused: bad_command'
        using detail = format('via_command %s names no open switch-off of user %s', p ->> 'via_command', v_id);
    end if;
  end if;
  if not v_has then
    perform public._ingest_detail(jsonb_build_object('missing', v_id));
    return array['target_missing'];
  end if;
  if public._ingest_protected(p_store, v_id) then
    raise exception 'refused: protected_target'
      using detail = format('user %s is the owner, a cloud login, a vendor account or a register login', v_id);
  end if;
  select * into v_old from public.users where id = v_id and store_id = p_store for update;

  if p_kind = 'staff.update_profile' then
    if jsonb_typeof(p -> 'full_name') not in ('string', 'null') then
      raise exception 'malformed: full_name' using errcode = '22023';
    end if;
    update public.users set full_name = case when p ? 'full_name' then p ->> 'full_name' else full_name end
     where id = v_id and store_id = p_store;
    return v_flags;
  end if;

  -- staff.set_access
  if jsonb_typeof(p -> 'active') is distinct from 'boolean' then
    raise exception 'malformed: active' using errcode = '22023';
  end if;
  v_active := (p ->> 'active')::boolean;
  v_role := case when p ? 'role_id' then public._ingest_opt_ref(p, 'role_id', 'roles', p_store) else v_old.role_id end;

  if v_id = p_actor then
    v_flags := v_flags || 'self_change'::text;
  end if;
  if not public._is_store_admin_for(p_actor, p_store)
     and (public._ingest_admin_role(v_role) or public._is_store_admin_for(v_id, p_store)) then
    v_flags := v_flags || 'assign_admin'::text;
  end if;
  if v_active is distinct from v_old.is_active then
    v_flags := v_flags || public._ingest_can(p_store, p_actor, 'staff.delete');
  end if;
  if v_active and v_old.is_active is not true and public._ingest_seats_full(p_store) then
    v_flags := v_flags || 'max_staff'::text;
  end if;
  -- the owner switched this user off from the phone: switching on again
  -- (or re-asserting on while the command waits) is for the owner to see
  if v_active and exists (select 1 from public.register_commands c
                           where c.store_id = p_store and c.user_id = v_id and c.kind = 'staff.deactivate'
                             and c.issued_at <= p_at
                             and (c.applied_seq is null or v_old.is_active is not true)) then
    v_flags := v_flags || 'reactivated_after_remote_deactivation'::text;
  end if;

  update public.users set role_id = v_role, is_active = v_active where id = v_id and store_id = p_store;
  if v_cmd is not null then
    update public.register_commands
       set applied_seq = nullif(current_setting('lensy.seq', true), '')::bigint
     where id = v_cmd;
  end if;
  return v_flags;
end $$;

-- role.create {id, name}, role.set_permission {role_id, code, granted, id?},
-- user.set_permission {user_id, code, allow, id?} (029:111-164 as flags;
-- reserved roles, admin/owner grants and protected targets refused).
create or replace function public._ingest_rbac(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_rid   uuid;
  v_name  text;
  v_code  text;
  v_pid   uuid;
  v_row   uuid;
  v_flags text[] := '{}';
begin
  if p_kind = 'role.create' then
    v_id := public._ingest_id(p, 'id');
    perform public._ingest_ref('roles', v_id, p_store);
    if jsonb_typeof(p -> 'name') is distinct from 'string' or btrim(p ->> 'name') = '' then
      raise exception 'malformed: name' using errcode = '22023';
    end if;
    v_name := btrim(p ->> 'name');
    if lower(v_name) in ('admin', 'owner', 'superadmin') then
      raise exception 'refused: reserved_role' using detail = format('position name %s is reserved', p ->> 'name');
    end if;
    if exists (select 1 from public.roles r where r.store_id = p_store and lower(btrim(r.name)) = lower(v_name)) then
      raise exception 'position % already exists in this store', v_name using errcode = '23505';
    end if;
    insert into public.roles (id, name, store_id, created_at) values (v_id, v_name, p_store, p_at);
    return v_flags;
  end if;

  -- an optional id for a new grant row: never another store's row
  if jsonb_typeof(p -> 'id') not in ('null') then
    v_row := public._ingest_id(p, 'id');
    if exists (select 1 from public.role_permissions x where x.id = v_row
                 and public.role_store(x.role_id) is distinct from p_store)
       or exists (select 1 from public.user_permissions x where x.id = v_row
                    and public.user_store(x.user_id) is distinct from p_store) then
      raise exception 'refused: foreign_id' using detail = format('permission row %s belongs to another store', v_row);
    end if;
  end if;

  if p_kind = 'role.set_permission' then
    v_rid := public._ingest_id(p, 'role_id');
    if not public._ingest_ref('roles', v_rid, p_store) then
      perform public._ingest_detail(jsonb_build_object('missing', v_rid));
      return array['target_missing'];
    end if;
    select r.name into v_name from public.roles r where r.id = v_rid;
    if lower(btrim(v_name)) in ('admin', 'owner', 'superadmin') then
      raise exception 'refused: reserved_role' using detail = format('position %s always has full access', v_name);
    end if;
    v_code := public._ingest_code(p);
    if jsonb_typeof(p -> 'granted') is distinct from 'boolean' then
      raise exception 'malformed: granted' using errcode = '22023';
    end if;
    if not (p ->> 'granted')::boolean and v_code in ('staff.view', 'staff.edit')
       and exists (select 1 from public.users u where u.id = p_actor and u.role_id = v_rid) then
      v_flags := v_flags || 'self_change'::text;
    end if;
    select x.id into v_pid from public.permissions x where x.code = v_code;
    if (p ->> 'granted')::boolean then
      insert into public.role_permissions (id, role_id, permission_id)
      values (coalesce(v_row, gen_random_uuid()), v_rid, v_pid)
      on conflict (role_id, permission_id) do nothing;
    else
      delete from public.role_permissions where role_id = v_rid and permission_id = v_pid;
    end if;
    return v_flags;
  end if;

  -- user.set_permission
  v_id := public._ingest_id(p, 'user_id');
  if not public._ingest_ref('users', v_id, p_store) then
    perform public._ingest_detail(jsonb_build_object('missing', v_id));
    return array['target_missing'];
  end if;
  if public._ingest_protected(p_store, v_id) then
    raise exception 'refused: protected_target'
      using detail = format('user %s is the owner, a cloud login, a vendor account or a register login', v_id);
  end if;
  v_code := public._ingest_code(p);
  if jsonb_typeof(p -> 'allow') not in ('boolean', 'null') then
    raise exception 'malformed: allow' using errcode = '22023';
  end if;
  if v_id = p_actor then
    v_flags := v_flags || 'self_change'::text;
  end if;
  select x.id into v_pid from public.permissions x where x.code = v_code;
  if jsonb_typeof(p -> 'allow') is distinct from 'boolean' then
    delete from public.user_permissions where user_id = v_id and permission_id = v_pid;
  else
    insert into public.user_permissions (id, user_id, permission_id, allow)
    values (coalesce(v_row, gen_random_uuid()), v_id, v_pid, (p ->> 'allow')::boolean)
    on conflict (user_id, permission_id) do update set allow = excluded.allow;
  end if;
  return v_flags;
end $$;

-- ============================================================
-- 7) the envelope, ingest, ping, park
-- ============================================================
-- The register's view of its store (design 3.2): everything but the
-- per-batch fields, which register_ingest adds.
create or replace function public._register_envelope(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r     public.store_registers;
  v_day jsonb;
  v_lic jsonb;
begin
  select * into r from public.store_registers where store_id = p_store;
  begin
    select jsonb_build_object('from', d.from_at, 'to', d.to_at) into v_day
      from public._store_day_range(p_store, null) d;
  exception when others then
    v_day := null;      -- an unusable zone must never stop the register's sync
  end;
  select jsonb_build_object('state', l.state, 'plan', l.plan, 'starts_at', l.starts_at,
                            'expires_at', l.expires_at, 'max_staff', l.max_staff,
                            'features', l.features, 'is_revoked', l.is_revoked)
    into v_lic
    from public._license_state(p_store) l;
  return jsonb_build_object(
    'current', true,
    'reason', null,
    'epoch', r.epoch,
    'acked_seq', r.last_seq,
    'more', false,
    'retry', false,
    'server_now', now(),
    'min_protocol', r.min_protocol,
    'catalog', md5(array_to_string(public.supported_permissions(), ',')),
    'held', case when r.held_seq is null then null
                 else jsonb_build_object('s', r.held_seq, 'code', r.held_code,
                                         'msg', r.held_error ->> 'message') end,
    'conflict', null,
    'results', '[]'::jsonb,
    'dup', 0,
    'license', v_lic,
    'commands', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'user_id', c.user_id,
                                                              'issued_at', c.issued_at)
                                           order by c.issued_at, c.id)
                            from public.register_commands c
                           where c.store_id = p_store and c.applied_seq is null), '[]'::jsonb),
    'store_day', v_day,
    'flags_total', (select count(*) from public.register_ops o where o.store_id = p_store and o.status = 'flagged'),
    'skipped_total', r.skipped_total,
    'parked_total', r.parked_total);
end $$;

-- One write of store_registers per call (the row is locked for the whole
-- batch): the loop keeps last_seq, max_t, held_*, the skip count and the
-- alerts in locals, and the epilogue writes them with the stamps.
create or replace function public.register_ingest(p_epoch integer, p_protocol integer, p_pending integer,
                                                  p_oldest_pending_at timestamptz, p_ops jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_started  timestamptz := clock_timestamp();
  r          public.store_registers;
  v_store    uuid;
  v_budget   integer;
  v_tok      boolean := false;
  v_n        integer;
  v_i        integer;
  v_op       jsonb;
  v_s        bigint;
  v_id       uuid;
  v_prev     uuid;
  v_dup_of   bigint;
  -- the store_registers fields the batch moves, written once at the end
  v_last     bigint;
  v_max_t    timestamptz;
  v_skipped  integer := 0;
  v_hseq     bigint;
  v_hcode    text;
  v_herr     jsonb;
  v_hat      timestamptz;
  v_hop      jsonb;
  v_refused  boolean := false;
  v_conflict bigint;
  -- the op
  v_kind     text;
  v_k        public._register_kind_perms;
  v_v        integer;
  v_actor    uuid;
  v_sid      uuid;
  v_at       timestamptz;
  v_p        jsonb;
  v_guard    text;
  v_flags    text[];
  v_wflags   text[];
  v_status   text;
  v_detail   jsonb;
  v_refusal  text;
  v_code     text;
  v_upgrade  boolean;
  v_state    text;
  v_msg      text;
  v_con      text;
  v_det      text;
  -- the response
  v_results  jsonb := '[]';
  v_dup      integer := 0;
  v_more     boolean := false;
  v_retry    boolean := false;
  v_upg_any  boolean := false;
  v_out      jsonb;
begin
  -- 1-2: who is calling, and may it send?
  select * into r from public.store_registers where register_uid = auth.uid() for update;
  if auth.uid() is null or not found then
    return jsonb_build_object('current', false, 'reason', 'replaced', 'server_now', now());
  end if;
  if r.revoked_at is not null or not public.store_is_register_only(r.store_id) then
    return jsonb_build_object('current', false, 'reason', 'revoked', 'server_now', now());
  end if;
  if r.quarantined_at is not null then
    return jsonb_build_object('current', false, 'reason', 'quarantined',
                              'conflict', jsonb_build_object('s', r.conflict_seq), 'server_now', now());
  end if;
  if p_epoch is distinct from r.epoch then
    return jsonb_build_object('current', false, 'reason', 'replaced', 'epoch', r.epoch, 'server_now', now());
  end if;
  v_store := r.store_id;
  if coalesce(p_protocol, 0) < r.min_protocol then
    update public.store_registers set last_contact_at = now() where store_id = v_store;
    return public._register_envelope(v_store) || jsonb_build_object('upgrade_required', true);
  end if;
  if p_ops is not null and jsonb_typeof(p_ops) <> 'array' then
    raise exception 'malformed: ops must be a JSON array' using errcode = '22023';
  end if;
  v_n := coalesce(jsonb_array_length(p_ops), 0);
  if v_n > 200 or coalesce(octet_length(p_ops::text), 0) > 262144 then
    update public.store_registers set last_contact_at = now() where store_id = v_store;
    return public._register_envelope(v_store) || jsonb_build_object('retry', true, 'reason', 'batch_too_large');
  end if;
  begin
    v_budget := least(coalesce(nullif(current_setting('lensy.ingest_budget_ms', true), '')::integer, 3000), 3000);
  exception when others then
    v_budget := 3000;
  end;

  -- 3: the batch prologue, outside any savepoint (033's token contract)
  perform set_config('lensy.ingest', '1', true);
  perform set_config('lensy.store', v_store::text, true);
  v_tok := public._register_bypass(v_store, 'ingest', true);
  v_last := r.last_seq;
  v_max_t := r.max_t;
  v_hseq := r.held_seq; v_hcode := r.held_code; v_herr := r.held_error; v_hat := r.held_at; v_hop := r.held_op;

  -- 4: each op in order
  for v_i in 0 .. v_n - 1 loop
    -- f: the time budget, checked before every op but the first
    if v_i > 0 and clock_timestamp() - v_started >= v_budget * interval '1 millisecond' then
      v_more := true;
      exit;
    end if;
    v_op := p_ops -> v_i;
    v_s := case when jsonb_typeof(v_op) = 'object' and jsonb_typeof(v_op -> 's') = 'number'
                     and (v_op ->> 's') ~ '^[0-9]{1,18}$'
                then (v_op ->> 's')::bigint end;
    if v_s is null or v_s < 1 then
      v_hat := case when v_hseq = v_last + 1 then coalesce(v_hat, now()) else now() end;
      v_hseq := v_last + 1; v_hcode := 'MAL'; v_hop := v_op;
      v_herr := jsonb_build_object('sqlstate', '22023', 'message', 'malformed: s');
      exit;
    end if;
    v_id := public._ingest_uuid(v_op ->> 'i');

    -- a: already logged at this seq: the same op (dup) or a seq conflict
    if v_s <= v_last then
      v_prev := null;
      -- (a dup_import row keeps the op id it stood for in detail.op_id)
      select coalesce(o.op_id, public._ingest_uuid(o.detail ->> 'op_id')) into v_prev
        from public.register_ops o where o.store_id = v_store and o.seq = v_s;
      if v_prev is not null and v_prev = v_id then
        v_dup := v_dup + 1;
        continue;
      end if;
      v_conflict := v_s;
      exit;
    end if;
    -- b: a gap
    if v_s > v_last + 1 then
      v_results := v_results || jsonb_build_array(jsonb_build_object('s', v_s, 'st', 'gap'));
      exit;
    end if;
    if v_id is null then
      v_hat := case when v_hseq = v_s then coalesce(v_hat, now()) else now() end;
      v_hseq := v_s; v_hcode := 'MAL'; v_hop := v_op;
      v_herr := jsonb_build_object('sqlstate', '22023', 'message', 'malformed: i');
      exit;
    end if;
    -- c: the same op id at another seq (a re-sequenced resend)
    v_dup_of := null;
    select o.seq into v_dup_of from public.register_ops o where o.store_id = v_store and o.op_id = v_id;
    if v_dup_of is not null then
      insert into public.register_ops (store_id, seq, op_id, kind, v, actor, sid, occurred_at, status, detail, payload)
      values (v_store, v_s, null, coalesce(v_op ->> 'k', '?'), null, public._ingest_uuid(v_op ->> 'a'),
              public._ingest_uuid(v_op ->> 'sid'), public._ingest_ts(v_op ->> 't'), 'dup_import',
              jsonb_build_object('dup_of', v_dup_of, 'op_id', v_id), null);
      v_last := v_s;
      if v_hseq <= v_s then
        v_hseq := null; v_hcode := null; v_herr := null; v_hat := null; v_hop := null;
      end if;
      v_results := v_results || jsonb_build_array(jsonb_build_object('s', v_s, 'st', 'dup_import', 'dup_of', v_dup_of));
      continue;
    end if;

    -- d: apply, inside its own savepoint
    v_kind := null; v_v := null; v_actor := null; v_sid := null; v_at := null; v_p := null;
    v_refusal := null; v_code := null; v_upgrade := false;
    begin
      perform set_config('lensy.detail', '', true);
      if jsonb_typeof(v_op -> 'k') is distinct from 'string' then
        raise exception 'malformed: k' using errcode = '22023';
      end if;
      v_kind := v_op ->> 'k';
      select * into v_k from public._register_kind_perms where kind = v_kind;
      if not found then
        raise exception 'malformed: unknown kind %', v_kind using errcode = '22023';
      end if;
      if jsonb_typeof(v_op -> 'v') is distinct from 'number' or (v_op ->> 'v') !~ '^[0-9]{1,9}$' then
        raise exception 'malformed: v' using errcode = '22023';
      end if;
      v_v := (v_op ->> 'v')::integer;
      if v_v > v_k.max_v then
        raise exception 'upgrade: % v% is newer than this server (max %)', v_kind, v_v, v_k.max_v;
      end if;
      if v_v < v_k.min_v then
        raise exception 'malformed: % v% is no longer supported (min %)', v_kind, v_v, v_k.min_v
          using errcode = '22023';
      end if;
      v_actor := public._ingest_uuid(v_op ->> 'a');
      if v_actor is null then
        raise exception 'malformed: a' using errcode = '22023';
      end if;
      if jsonb_typeof(v_op -> 'sid') is not null and jsonb_typeof(v_op -> 'sid') <> 'null' then
        v_sid := public._ingest_uuid(v_op ->> 'sid');
        if v_sid is null then
          raise exception 'malformed: sid' using errcode = '22023';
        end if;
      end if;
      v_at := public._ingest_ts(v_op ->> 't');
      if v_at is null then
        raise exception 'malformed: t' using errcode = '22023';
      end if;
      v_p := coalesce(v_op -> 'p', '{}'::jsonb);
      if jsonb_typeof(v_p) <> 'object' then
        raise exception 'malformed: p' using errcode = '22023';
      end if;
      if jsonb_typeof(v_op -> 'e') not in ('number', 'null') then
        raise exception 'malformed: e' using errcode = '22023';
      end if;
      if jsonb_typeof(v_op -> 'f') not in ('array', 'null') then
        raise exception 'malformed: f' using errcode = '22023';
      end if;

      perform set_config('lensy.actor', v_actor::text, true);
      perform set_config('lensy.event_at', to_jsonb(v_at) #>> '{}', true);
      perform set_config('lensy.seq', v_s::text, true);

      v_guard := public._register_guard(v_store, v_kind, v_actor, v_sid, v_p);
      if v_guard is not null then
        raise exception 'refused: %', v_guard;
      end if;

      v_flags := public._register_flags(v_store, v_kind, v_actor, v_sid, v_at, v_p, v_max_t);
      if coalesce(v_op -> 'f', '[]'::jsonb) ? 'tz_mismatch' then
        v_flags := v_flags || 'tz_mismatch'::text;
      end if;
      execute format('select public.%I($1, $2, $3, $4, $5)', v_k.writer)
        into v_wflags using v_store, v_actor, v_at, v_p, v_kind;
      v_flags := array(select distinct x from unnest(v_flags || coalesce(v_wflags, '{}'::text[])) x order by x);

      v_status := case when v_kind = 'noop' then 'skipped'
                       when cardinality(v_flags) > 0 then 'flagged'
                       else 'ok' end;
      v_detail := nullif(current_setting('lensy.detail', true), '')::jsonb;
      if jsonb_typeof(v_op -> 'e') = 'number' then
        v_detail := coalesce(v_detail, '{}'::jsonb) || jsonb_build_object('e', v_op -> 'e');
      end if;
      insert into public.register_ops (store_id, seq, op_id, kind, v, actor, sid, occurred_at, status,
                                       violations, detail, payload)
      values (v_store, v_s, v_id, v_kind, v_v, v_actor, v_sid, v_at, v_status, v_flags, v_detail, v_p);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                              v_con = constraint_name, v_det = pg_exception_detail;
      if v_msg like 'refused:%' then
        v_refusal := btrim(substr(v_msg, 9));
      elsif v_msg like 'upgrade:%' then
        v_upgrade := true;
      elsif v_msg like 'malformed:%' then
        v_code := 'MAL';
      elsif v_state in ('40001', '40P01') then
        v_retry := true;
      elsif v_msg like 'state:%' then
        v_code := 'STATE';
      elsif left(v_state, 2) in ('22', '23') then
        v_code := 'INT';
      else
        v_code := 'FAULT';
      end if;
    end;

    -- e: what a failure means (the op's own writes are already rolled back)
    if v_refusal is not null then
      insert into public.register_ops (store_id, seq, op_id, kind, v, actor, sid, occurred_at, status,
                                       violations, detail, payload)
      values (v_store, v_s, v_id, v_kind, v_v, v_actor, v_sid, v_at, 'refused', array[v_refusal],
              jsonb_strip_nulls(jsonb_build_object('message', v_msg, 'detail', nullif(v_det, ''))), v_p);
      v_refused := true;
      v_results := v_results || jsonb_build_array(jsonb_build_object('s', v_s, 'st', 'refused', 'v', jsonb_build_array(v_refusal)));
    elsif v_upgrade then
      v_upg_any := true;
      v_results := v_results || jsonb_build_array(jsonb_build_object('s', v_s, 'st', 'server_upgrade_required'));
      exit;
    elsif v_retry then
      exit;
    elsif v_code is not null then
      v_hat := case when v_hseq = v_s then coalesce(v_hat, now()) else now() end;
      v_hseq := v_s; v_hcode := v_code; v_hop := v_op;
      v_herr := jsonb_strip_nulls(jsonb_build_object('sqlstate', v_state, 'constraint', nullif(v_con, ''),
                                                     'message', v_msg, 'detail', nullif(v_det, '')));
      exit;
    else
      -- applied: ok, flagged or (noop) skipped
      v_max_t := greatest(v_max_t, least(v_at, now() + interval '10 minutes'));
      if v_kind = 'noop' then
        v_skipped := v_skipped + 1;
      end if;
      if v_status <> 'ok' then
        v_results := v_results || jsonb_build_array(jsonb_build_object('s', v_s, 'st', v_status, 'v', to_jsonb(v_flags)));
      end if;
    end if;
    -- applied or refused: the log moves on, and a hold at this seq is over
    v_last := v_s;
    if v_hseq <= v_s then
      v_hseq := null; v_hcode := null; v_herr := null; v_hat := null; v_hop := null;
    end if;
  end loop;

  -- 5: one write of the register row with the stamps; then clear every GUC
  -- this call set and close the token
  update public.store_registers
     set last_seq          = v_last,
         max_t             = v_max_t,
         skipped_total     = skipped_total + v_skipped,
         held_seq          = v_hseq,
         held_code         = v_hcode,
         held_error        = v_herr,
         held_at           = v_hat,
         held_op           = v_hop,
         quarantined_at    = case when v_conflict is not null then now() else quarantined_at end,
         conflict_seq      = case when v_conflict is not null then v_conflict else conflict_seq end,
         alert             = case when v_conflict is not null then 'seq_conflict'
                                  when v_refused then coalesce(alert, 'refused') else alert end,
         alert_at          = case when v_conflict is not null then now()
                                  when v_refused and alert is null then now() else alert_at end,
         last_ingest_at    = now(),
         last_contact_at   = now(),
         pending_reported  = case when p_pending >= 0 then p_pending else pending_reported end,
         oldest_pending_at = p_oldest_pending_at
   where store_id = v_store;
  perform set_config('lensy.ingest', '', true);
  perform set_config('lensy.store', '', true);
  perform set_config('lensy.actor', '', true);
  perform set_config('lensy.event_at', '', true);
  perform set_config('lensy.seq', '', true);
  perform set_config('lensy.detail', '', true);
  if v_tok then
    perform public._register_bypass(v_store, 'ingest', false);
  end if;

  v_out := public._register_envelope(v_store)
           || jsonb_build_object('more', v_more, 'retry', v_retry, 'results', v_results, 'dup', v_dup);
  if v_conflict is not null then
    v_out := v_out || jsonb_build_object('current', false, 'reason', 'quarantined',
                                         'conflict', jsonb_build_object('s', v_conflict));
  end if;
  if v_upg_any then
    v_out := v_out || jsonb_build_object('server_upgrade_required', true);
  end if;
  return v_out;
end $$;

create or replace function public.register_ping(p_epoch integer, p_pending integer, p_oldest_pending_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.store_registers;
begin
  select * into r from public.store_registers where register_uid = auth.uid() for update;
  if auth.uid() is null or not found then
    return jsonb_build_object('current', false, 'reason', 'replaced', 'server_now', now());
  end if;
  if r.revoked_at is not null or not public.store_is_register_only(r.store_id) then
    return jsonb_build_object('current', false, 'reason', 'revoked', 'server_now', now());
  end if;
  if r.quarantined_at is not null then
    return jsonb_build_object('current', false, 'reason', 'quarantined',
                              'conflict', jsonb_build_object('s', r.conflict_seq), 'server_now', now());
  end if;
  if p_epoch is distinct from r.epoch then
    return jsonb_build_object('current', false, 'reason', 'replaced', 'epoch', r.epoch, 'server_now', now());
  end if;
  update public.store_registers
     set last_contact_at = now(),
         pending_reported = case when p_pending >= 0 then p_pending else pending_reported end,
         oldest_pending_at = p_oldest_pending_at
   where store_id = r.store_id;
  return public._register_envelope(r.store_id);
end $$;

-- The vendor park (design 3.8): the held op is recorded as 'parked' and the
-- queue moves past it. A later op that depends on it holds in turn.
create or replace function public.register_resolve_held(p_store uuid, p_seq bigint, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r    public.store_registers;
  v_op jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'only the vendor can park a held op' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'give a reason for parking the op' using errcode = '22023';
  end if;
  select * into r from public.store_registers where store_id = p_store for update;
  if not found then
    raise exception 'this shop has no register' using errcode = 'P0002';
  end if;
  if r.held_seq is null or p_seq is distinct from r.held_seq then
    raise exception 'no op is held at seq % (held: %)', p_seq, coalesce(r.held_seq::text, 'none')
      using errcode = '55000';
  end if;
  v_op := r.held_op;

  insert into public.register_ops (store_id, seq, op_id, kind, v, actor, sid, occurred_at, status,
                                   violations, detail, payload)
  values (p_store, r.held_seq,
          case when not exists (select 1 from public.register_ops o
                                 where o.store_id = p_store and o.op_id = public._ingest_uuid(v_op ->> 'i'))
               then public._ingest_uuid(v_op ->> 'i') end,
          coalesce(case when jsonb_typeof(v_op -> 'k') = 'string' then v_op ->> 'k' end, '?'),
          case when (v_op ->> 'v') ~ '^[0-9]{1,9}$' then (v_op ->> 'v')::integer end,
          public._ingest_uuid(v_op ->> 'a'), public._ingest_uuid(v_op ->> 'sid'), public._ingest_ts(v_op ->> 't'),
          'parked', '{}',
          jsonb_build_object('reason', p_reason, 'held_code', r.held_code, 'held_error', r.held_error,
                             'parked_by', auth.uid()),
          v_op -> 'p');
  update public.store_registers
     set last_seq = r.held_seq, held_seq = null, held_code = null, held_error = null, held_at = null,
         held_op = null, parked_total = parked_total + 1
   where store_id = p_store;
  insert into public.audit_log (actor, store_id, table_name, row_id, action, before_row, after_row)
  values (auth.uid(), p_store, 'register_ops', r.held_seq::text, 'park',
          jsonb_build_object('held_seq', r.held_seq, 'held_code', r.held_code, 'held_op', v_op),
          jsonb_build_object('status', 'parked', 'reason', p_reason));
  return jsonb_build_object('store_id', p_store, 'seq', r.held_seq, 'parked_total', r.parked_total + 1);
end $$;

-- ============================================================
-- 7b) the undo log and register_revert_ops (step 3; header part 7)
-- ============================================================
create table if not exists public.register_undo (
  n          bigserial primary key,
  store_id   uuid   not null references public.stores(id) on delete cascade,
  seq        bigint not null,
  table_name text   not null,
  pk         jsonb  not null,
  action     text   not null check (action in ('insert', 'update', 'delete')),
  before_row jsonb
);
create index if not exists register_undo_seq_idx on public.register_undo (store_id, seq);

-- The forged ops a revert took out of the log (design 6.3): register_ops'
-- columns, status 'reverted', plus what the revert knew.
create table if not exists public.register_ops_foreign (
  id              bigserial primary key,
  store_id        uuid not null references public.stores(id) on delete cascade,
  seq             bigint not null,
  op_id           uuid,
  kind            text not null,
  v               integer,
  actor           uuid,
  sid             uuid,
  occurred_at     timestamptz,
  received_at     timestamptz not null,
  status          text not null default 'reverted' check (status = 'reverted'),
  violations      text[] not null default '{}',
  detail          jsonb,
  payload         jsonb,
  original_status text,
  reverted_at     timestamptz not null default now(),
  reverted_by     uuid,
  revert_reason   text
);
create index if not exists register_ops_foreign_seq_idx on public.register_ops_foreign (store_id, seq);

-- The seq prefix prune_register_ops has emptied, per store.
alter table public.store_registers add column if not exists undo_pruned_seq bigint not null default 0;
alter table public.store_registers add column if not exists payload_pruned_seq bigint not null default 0;

do $$
declare t text;
begin
  foreach t in array array['register_undo', 'register_ops_foreign'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
  revoke all on sequence public.register_undo_n_seq, public.register_ops_foreign_id_seq
    from public, anon, authenticated, service_role;
end $$;

-- AFTER INSERT/UPDATE/DELETE FOR EACH ROW on the guard's tables; the
-- arguments are the table's primary-key columns. Outside the ingest gate it
-- returns at once (the first test is a GUC read, so ordinary stores pay
-- almost nothing).
create or replace function public._register_undo_capture() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_seq   text := current_setting('lensy.seq', true);
  v_row   jsonb;
  v_pk    jsonb := '{}';
  i       integer;
begin
  if coalesce(current_setting('lensy.ingest', true), '') <> '1' or coalesce(v_seq, '') !~ '^[0-9]{1,18}$' then
    return null;
  end if;
  v_store := public._register_ingest_store();
  if v_store is null then
    return null;
  end if;
  v_row := case when tg_op = 'INSERT' then to_jsonb(new) else to_jsonb(old) end;
  for i in 0 .. tg_nargs - 1 loop
    v_pk := v_pk || jsonb_build_object(tg_argv[i], v_row -> tg_argv[i]);
  end loop;
  insert into public.register_undo (store_id, seq, table_name, pk, action, before_row)
  values (v_store, v_seq::bigint, tg_table_name, v_pk, lower(tg_op),
          case when tg_op = 'INSERT' then null else v_row end);
  return null;
end $$;

revoke execute on function public._register_undo_capture() from public, anon, authenticated, service_role;

-- zz_ so it fires after the sync and audit triggers of the same row (AFTER
-- triggers fire in name order); the cascades those run are nested
-- statements whose own rows are captured first, so the reverse replay
-- undoes the row before what it caused.
do $$
declare
  t    text;
  v_pk text;
begin
  foreach t in array array[
    'customers', 'inventory', 'stock_movements', 'sales', 'sale_items',
    'order_examinations', 'sale_payments', 'shift_closes', 'invoice_counter',
    'suppliers', 'purchases', 'purchase_items', 'purchase_payments', 'notes',
    'settings', 'lens_types', 'frame_colors', 'frame_types', 'prescriptions',
    'warehouses', 'users', 'roles', 'role_permissions', 'user_permissions', 'stores'
  ] loop
    select string_agg(quote_literal(a.attname), ', ' order by array_position(i.indkey::int2[], a.attnum))
      into v_pk
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = format('public.%I', t)::regclass and i.indisprimary;
    if v_pk is null then
      raise exception '034: table % has no primary key for the undo log', t;
    end if;
    execute format('drop trigger if exists zz_register_undo on public.%I', t);
    execute format('create trigger zz_register_undo after insert or update or delete on public.%I
                    for each row execute function public._register_undo_capture(%s)', t, v_pk);
  end loop;
end $$;

-- Columns a revert never writes back: the two caches (their sync triggers
-- recompute them from the reverted ledgers) and what only the vendor and
-- the setup functions change (ingest never does).
create or replace function public._register_undo_keep(p_table text, p_col text) returns boolean
language sql immutable security definer set search_path = public as $$
  select (p_table, p_col) in (('inventory', 'stock_qty'), ('sales', 'amount_paid'), ('users', 'password_hash'),
                              ('stores', 'register_only'), ('stores', 'owner_uid'))
$$;

create or replace function public.register_revert_ops(p_store uuid, p_from_seq bigint, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r         public.store_registers;
  u         public.register_undo;
  v_prev    text := coalesce(current_setting('lensy.register_admin', true), '');
  v_tok     boolean;
  v_pk      text;
  v_cols    text;
  v_row     jsonb;
  v_undo    integer := 0;
  v_ops     integer;
  v_skipped integer;
  v_parked  integer;
  v_max_t   timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'only the vendor can revert register ops' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'give a reason for the revert' using errcode = '22023';
  end if;
  select * into r from public.store_registers where store_id = p_store for update;
  if not found then
    raise exception 'this shop has no register' using errcode = 'P0002';
  end if;
  if r.quarantined_at is null and r.revoked_at is null then
    raise exception 'the register is neither quarantined nor revoked: revoke it before reverting its ops'
      using errcode = '55000';
  end if;
  if p_from_seq is null or p_from_seq < 1 or p_from_seq > r.last_seq then
    raise exception 'from_seq % is outside the log (1..%)', p_from_seq, r.last_seq using errcode = '22023';
  end if;
  if p_from_seq <= r.undo_pruned_seq then
    raise exception 'undo_pruned: the undo log up to seq % is pruned; seq % cannot be reverted',
      r.undo_pruned_seq, p_from_seq using errcode = '55000';
  end if;

  v_tok := public._register_bypass(p_store, 'admin', true);
  perform set_config('lensy.register_admin', p_store::text, true);

  for u in select * from public.register_undo x
            where x.store_id = p_store and x.seq >= p_from_seq order by x.n desc loop
    select string_agg(format('%I', k), ', ') into v_pk from jsonb_object_keys(u.pk) k;
    if u.action = 'insert' then
      execute format('delete from public.%I where (%s) = (select %s from jsonb_populate_record(null::public.%I, $1))',
                     u.table_name, v_pk, v_pk, u.table_name)
        using u.pk;
    elsif u.action = 'update' then
      select string_agg(format('%I', a.attname), ', ' order by a.attnum) into v_cols
        from pg_attribute a
       where a.attrelid = format('public.%I', u.table_name)::regclass and a.attnum > 0 and not a.attisdropped
         and not public._register_undo_keep(u.table_name, a.attname);
      if u.table_name = 'sales' then
        perform set_config('lensy.money_write', '1', true);
      end if;
      execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $2))'
                     ' where (%s) = (select %s from jsonb_populate_record(null::public.%I, $1))',
                     u.table_name, v_cols, v_cols, u.table_name, v_pk, v_pk, u.table_name)
        using u.pk, u.before_row;
      if u.table_name = 'sales' then
        perform set_config('lensy.money_write', '', true);
        -- lab_status_stamp re-stamps the lab times when lab_status moves
        -- back; put them back as they were (lab_status no longer moves)
        update public.sales s
           set lab_status_changed_at = b.lab_status_changed_at, lab_started_at = b.lab_started_at,
               lab_ready_at = b.lab_ready_at
          from jsonb_populate_record(null::public.sales, u.before_row) b
         where s.id = b.id;
      end if;
    else
      -- a deleted row comes back with its caches empty: the ledger rows
      -- re-inserted after it refill them
      v_row := u.before_row || case u.table_name when 'inventory' then '{"stock_qty": 0}'::jsonb
                                                 when 'sales' then '{"amount_paid": 0}'::jsonb
                                                 else '{}'::jsonb end;
      execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)',
                     u.table_name, u.table_name)
        using v_row;
    end if;
    v_undo := v_undo + 1;
  end loop;

  update public.register_commands set applied_seq = null
   where store_id = p_store and applied_seq >= p_from_seq;
  insert into public.register_ops_foreign (store_id, seq, op_id, kind, v, actor, sid, occurred_at, received_at,
                                           status, violations, detail, payload, original_status, reverted_by,
                                           revert_reason)
  select o.store_id, o.seq, o.op_id, o.kind, o.v, o.actor, o.sid, o.occurred_at, o.received_at,
         'reverted', o.violations, o.detail, o.payload, o.status, auth.uid(), p_reason
    from public.register_ops o
   where o.store_id = p_store and o.seq >= p_from_seq
   order by o.seq;
  get diagnostics v_ops = row_count;
  select count(*) filter (where o.status = 'skipped'), count(*) filter (where o.status = 'parked')
    into v_skipped, v_parked
    from public.register_ops o where o.store_id = p_store and o.seq >= p_from_seq;
  delete from public.register_ops where store_id = p_store and seq >= p_from_seq;
  delete from public.register_undo where store_id = p_store and seq >= p_from_seq;
  -- max_t as register_ingest kept it: applied ops only, t capped at its
  -- arrival + 10 minutes
  select max(least(o.occurred_at, o.received_at + interval '10 minutes')) into v_max_t
    from public.register_ops o where o.store_id = p_store and o.status in ('ok', 'flagged', 'skipped');
  update public.store_registers
     set last_seq      = p_from_seq - 1,
         max_t         = v_max_t,
         skipped_total = greatest(skipped_total - v_skipped, 0),
         parked_total  = greatest(parked_total - v_parked, 0),
         held_seq = null, held_code = null, held_error = null, held_at = null, held_op = null
   where store_id = p_store;
  insert into public.audit_log (actor, store_id, table_name, row_id, action, before_row, after_row)
  values (auth.uid(), p_store, 'register_ops', p_from_seq::text, 'revert',
          jsonb_build_object('last_seq', r.last_seq, 'from_seq', p_from_seq, 'ops', v_ops),
          jsonb_build_object('last_seq', p_from_seq - 1, 'undo_rows', v_undo, 'reason', p_reason));

  perform set_config('lensy.register_admin', v_prev, true);
  if v_tok then
    perform public._register_bypass(p_store, 'admin', false);
  end if;
  return jsonb_build_object('store_id', p_store, 'from_seq', p_from_seq, 'ops', v_ops, 'undo_rows', v_undo,
                            'last_seq', p_from_seq - 1);
end $$;

-- ============================================================
-- 7c) exports, fill_gap, prune (step 3; header part 7)
-- ============================================================
-- The export whitelist: table, its keyset key, the columns sent, and how
-- the store's rows are found. password_hash and license_key are never sent.
create or replace function public._register_export_cols()
returns table (tbl text, keycol text, cols text[], scope text)
language sql immutable security definer set search_path = public as $$
  values
    ('customers', 'id', '{id,name,phone,phone2,email,city,address,notes,created_at,store_id}'::text[], 'store'),
    ('inventory', 'id', '{id,name,sku,barcode,category,brand,frame_type,frame_color,cost_price,sale_price,created_at,store_id,stock_qty}', 'store'),
    ('stock_movements', 'id', '{id,product_id,qty,type,ref_no,note,created_at,store_id,kind}', 'store'),
    ('sales', 'id', '{id,invoice_no,customer_id,user_id,total_amount,discount,net_amount,amount_paid,payment_method,doctor_name,'
                    'lab_status,order_date,delivery_date,created_at,rx_image_path,frame_image_path,store_id,idempotency_key,'
                    'voided_at,voided_by,void_reason,lab_status_changed_at,lab_started_at,lab_started_by,lab_ready_at,kind}', 'store'),
    ('sale_items', 'id', '{id,sale_id,product_id,name,qty,unit_price,total_price,created_at,store_id,discount,discount_reason}', 'store'),
    ('order_examinations', 'id', '{id,sale_id,exam_type,sphere_od,cylinder_od,axis_od,sphere_os,cylinder_os,axis_os,ipd,lens_info,'
                                 'frame_info,frame_color,frame_status,doctor_name,image_path,created_at,store_id}', 'store'),
    ('sale_payments', 'id', '{id,sale_id,amount,method,note,paid_at,recorded_by,store_id,created_at,kind}', 'store'),
    ('shift_closes', 'id', '{id,store_id,closed_at,closed_by,from_at,to_at,counted_cash,expected_cash,expected_by_tender,'
                           'expected_total,variance,order_count,prescription_count,void_count,refund_total,lab_delivered,note}', 'store'),
    ('invoice_counter', 'prefix', '{store_id,prefix,next_val}', 'store'),
    ('suppliers', 'id', '{id,name,phone,email,address,created_at,store_id}', 'store'),
    ('purchases', 'id', '{id,supplier_id,total_amount,amount_paid,purchase_date,created_at,store_id}', 'store'),
    ('purchase_items', 'id', '{id,purchase_id,product_id,qty,unit_cost,total_cost,created_at,store_id,received_at}', 'store'),
    ('purchase_payments', 'id', '{id,purchase_id,amount,paid_at,note,created_at,store_id}', 'store'),
    ('notes', 'id', '{id,user_id,created_by,body,created_at,updated_at,store_id}', 'store'),
    ('settings', 'id', '{id,key,value,created_at,store_id}', 'store'),
    ('lens_types', 'id', '{id,name,created_at,store_id,sort_order}', 'store'),
    ('frame_colors', 'id', '{id,name,created_at,store_id,sort_order}', 'store'),
    ('frame_types', 'id', '{id,name,created_at,store_id}', 'store'),
    ('users', 'id', '{id,username,full_name,role_id,is_active,created_at,store_id}', 'store'),
    ('roles', 'id', '{id,name,created_at,store_id}', 'store'),
    ('role_permissions', 'id', '{id,role_id,permission_id,value}', 'role'),
    ('user_permissions', 'id', '{id,user_id,permission_id,allow,value}', 'user'),
    ('permissions', 'id', '{id,code,name,description}', 'global'),
    ('stores', 'id', '{id,name,owner_name,owner_phone,owner_email,is_active,created_at,allow_negative_stock,time_zone,'
                     'register_only,owner_uid}', 'self'),
    ('store_licenses', 'id', '{id,store_id,plan,max_staff,is_revoked,features,starts_at,expires_at,created_at}', 'store')
$$;

-- The register's store while its setup window is open, else 42501.
create or replace function public._register_export_store() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.register_store_id();
begin
  if v_store is null or not public.register_snapshot_open() then
    raise exception 'the export is open only to the shop''s register during its setup window' using errcode = '42501';
  end if;
  return v_store;
end $$;

-- One page of one whitelisted table: {table, rows, after, more}. after is
-- the last key of the page (send it back for the next page).
create or replace function public.register_export(p_table text, p_after text default null, p_limit integer default 1000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public._register_export_store();
  c       record;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_sel   text;
  v_where text;
  v_after text;
  v_rows  jsonb;
begin
  select * into c from public._register_export_cols() x where x.tbl = p_table;
  if not found then
    raise exception 'table % is not exported', p_table using errcode = '22023';
  end if;
  select string_agg(format('t.%I', col), ', ') into v_sel from unnest(c.cols) col;
  if c.tbl = 'users' then
    v_sel := v_sel || ', public._ingest_protected($1, t.id) as protected';
  end if;
  v_where := case c.scope
               when 'store'  then 't.store_id = $1'
               when 'role'   then 'exists (select 1 from public.roles r where r.id = t.role_id and r.store_id = $1)'
               when 'user'   then 'exists (select 1 from public.users x where x.id = t.user_id and x.store_id = $1)'
               when 'self'   then 't.id = $1'
               else 'true' end;
  v_after := case when p_after is null then 'true'
                  when c.keycol = 'id' then format('t.%I > $2::uuid', c.keycol)
                  else format('t.%I > $2', c.keycol) end;
  execute format('select coalesce(jsonb_agg(to_jsonb(x) order by x.%I), ''[]''::jsonb)
                    from (select %s from public.%I t where %s and %s order by t.%I limit $3) x',
                 c.keycol, v_sel, c.tbl, v_where, v_after, c.keycol)
    into v_rows using v_store, p_after, v_limit;
  return jsonb_build_object('table', c.tbl, 'rows', v_rows,
                            'after', v_rows -> -1 ->> c.keycol,
                            'more', jsonb_array_length(v_rows) = v_limit);
end $$;

-- Row counts and JSON bytes per exported table, for the size estimate the
-- setup shows before the download (design 3.10).
create or replace function public.register_export_heads()
returns table (table_name text, row_count bigint, bytes bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public._register_export_store();
  c       record;
  v_where text;
  v_n     bigint;
  v_b     bigint;
begin
  for c in select * from public._register_export_cols() loop
    v_where := case c.scope
                 when 'store'  then 't.store_id = $1'
                 when 'role'   then 'exists (select 1 from public.roles r where r.id = t.role_id and r.store_id = $1)'
                 when 'user'   then 'exists (select 1 from public.users x where x.id = t.user_id and x.store_id = $1)'
                 when 'self'   then 't.id = $1'
                 else 'true' end;
    execute format('select count(*), coalesce(sum(octet_length(to_jsonb(t)::text)), 0) from public.%I t where %s',
                   c.tbl, v_where)
      into v_n, v_b using v_store;
    table_name := c.tbl; row_count := v_n; bytes := v_b;
    return next;
  end loop;
end $$;

-- The setup has its snapshot: the window closes (the register reads no
-- table again; design 4.4, 5).
create or replace function public.register_snapshot_done() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.register_store_id();
  v_at    timestamptz;
begin
  if v_store is null then
    raise exception 'only the shop''s register computer can close its setup window' using errcode = '42501';
  end if;
  update public.store_registers set snapshot_done_at = coalesce(snapshot_done_at, now())
   where store_id = v_store
  returning snapshot_done_at into v_at;
  return v_at;
end $$;

-- The store's op log for a re-hydrate (design 6.2): the OWNER's own session
-- only, never a register login; contiguous rows from p_from_seq.
create or replace function public.register_export_ops(p_from_seq bigint, p_limit integer default 500)
returns table (seq bigint, op_id uuid, kind text, v integer, actor uuid, sid uuid, occurred_at timestamptz,
               status text, violations text[], detail jsonb, payload jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store  uuid;
  v_pruned bigint;
begin
  if auth.uid() is not null and public.register_store_id() is null
     and not exists (select 1 from public.store_registers r where r.register_uid = auth.uid()) then
    select s.id into v_store from public.stores s where s.owner_uid = auth.uid() order by s.created_at limit 1;
  end if;
  if v_store is null then
    raise exception 'only the shop owner can read the register''s op log' using errcode = '42501';
  end if;
  select r.payload_pruned_seq into v_pruned from public.store_registers r where r.store_id = v_store;
  if coalesce(p_from_seq, 1) <= coalesce(v_pruned, 0) then
    raise exception 'retention: ops up to seq % are pruned (payloads are kept 400 days); set the register up again',
      v_pruned using errcode = '55000';
  end if;
  return query
    select o.seq, o.op_id, o.kind, o.v, o.actor, o.sid, o.occurred_at, o.status, o.violations, o.detail, o.payload
      from public.register_ops o
     where o.store_id = v_store and o.seq >= coalesce(p_from_seq, 1)
     order by o.seq
     limit least(greatest(coalesce(p_limit, 500), 1), 500);
end $$;

-- Ops the PC can no longer send (design 4.4): 'lost' noop rows close the gap
-- from the next seq.
create or replace function public.register_fill_gap(p_store uuid, p_from bigint, p_to bigint, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.store_registers;
begin
  if not public.is_platform_admin() then
    raise exception 'only the vendor can fill a gap in the register log' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'give a reason for filling the gap' using errcode = '22023';
  end if;
  select * into r from public.store_registers where store_id = p_store for update;
  if not found then
    raise exception 'this shop has no register' using errcode = 'P0002';
  end if;
  if p_from is distinct from r.last_seq + 1 or p_to is null or p_to < p_from or p_to - p_from >= 100000 then
    raise exception 'a gap starts at the next seq (%) and ends at or after it', r.last_seq + 1 using errcode = '55000';
  end if;
  insert into public.register_ops (store_id, seq, op_id, kind, v, actor, sid, occurred_at, status, violations,
                                   detail, payload)
  select p_store, g, null, 'noop', null, null, null, null, 'lost', '{}',
         jsonb_build_object('reason', p_reason, 'filled_by', auth.uid()), null
    from generate_series(p_from, p_to) g;
  update public.store_registers
     set last_seq = p_to,
         held_seq = case when held_seq <= p_to then null else held_seq end,
         held_code = case when held_seq <= p_to then null else held_code end,
         held_error = case when held_seq <= p_to then null else held_error end,
         held_at = case when held_seq <= p_to then null else held_at end,
         held_op = case when held_seq <= p_to then null else held_op end
   where store_id = p_store;
  insert into public.audit_log (actor, store_id, table_name, row_id, action, before_row, after_row)
  values (auth.uid(), p_store, 'register_ops', p_from::text, 'fill_gap',
          jsonb_build_object('last_seq', r.last_seq),
          jsonb_build_object('last_seq', p_to, 'lost', p_to - p_from + 1, 'reason', p_reason));
  return jsonb_build_object('store_id', p_store, 'from', p_from, 'to', p_to, 'last_seq', p_to);
end $$;

-- Retention (design 4.4, 5): payloads 400 days after they reached the
-- cloud (the row skeleton stays: seq, op id, kind, actor, times, status,
-- violations, detail), and undo rows 60 days after INGEST, both never later
-- than p_before.
-- WHY INGEST TIME FOR THE UNDO LOG: design 4.4 set "60 days, longer than the
-- 45-day contact limit". Revision 3 removed that limit (design 2.5: no
-- offline time limit), so the 60 days are counted from when the ops reached
-- the cloud (register_ops.received_at), not from when they were made
-- offline: a forgery is detected when its ops arrive (the genuine PC's next
-- op collides, design 6.3), however old their t, so the vendor has 60 days
-- from arrival to revert them.
create or replace function public.prune_register_ops(p_before timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pay_cut  timestamptz := least(coalesce(p_before, now()), now() - interval '400 days');
  v_undo_cut timestamptz := least(coalesce(p_before, now()), now() - interval '60 days');
  r          record;
  v_through  bigint;
  v_n        integer;
  v_payloads integer := 0;
  v_undo     integer := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'only the vendor can prune the register log' using errcode = '42501';
  end if;
  for r in select x.store_id, x.payload_pruned_seq, x.undo_pruned_seq from public.store_registers x
            order by x.store_id for update loop
    -- payloads: the prefix of seqs received before the cut
    select max(o.seq) into v_through
      from public.register_ops o where o.store_id = r.store_id and o.received_at < v_pay_cut;
    if v_through is not null then
      update public.register_ops o set payload = null
       where o.store_id = r.store_id and o.seq <= v_through and o.payload is not null;
      get diagnostics v_n = row_count;
      v_payloads := v_payloads + v_n;
      update public.store_registers set payload_pruned_seq = greatest(payload_pruned_seq, v_through)
       where store_id = r.store_id;
    end if;
    -- undo rows: 60 days after ingest (see above)
    select max(o.seq) into v_through
      from public.register_ops o where o.store_id = r.store_id and o.received_at < v_undo_cut;
    if v_through is not null then
      delete from public.register_undo u where u.store_id = r.store_id and u.seq <= v_through;
      get diagnostics v_n = row_count;
      v_undo := v_undo + v_n;
      update public.store_registers set undo_pruned_seq = greatest(undo_pruned_seq, v_through)
       where store_id = r.store_id;
    end if;
  end loop;
  update public.register_ops_foreign f set payload = null
   where f.reverted_at < v_pay_cut and f.payload is not null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('payloads', v_payloads, 'undo_rows', v_undo, 'foreign_payloads', v_n,
                            'payload_cut', v_pay_cut, 'undo_cut', v_undo_cut);
end $$;

-- ============================================================
-- 8) grants
-- ============================================================
-- Internal: no client role.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public._license_state(uuid)', 'public._license_feature_for(uuid, text)',
    'public._store_day_range(uuid, date)',
    'public._ingest_uuid(text)', 'public._ingest_ts(text)', 'public._ingest_id(jsonb, text)',
    'public._ingest_ref(text, uuid, uuid)', 'public._ingest_can(uuid, uuid, text)',
    'public._ingest_detail(jsonb)',
    'public._register_guard(uuid, text, uuid, uuid, jsonb)',
    'public._register_flags(uuid, text, uuid, uuid, timestamptz, jsonb, timestamptz)',
    'public._register_envelope(uuid)',
    -- step 2's helpers
    'public._ingest_arr(jsonb, text)', 'public._ingest_num(jsonb, text, boolean)',
    'public._ingest_rows(jsonb, text, text, text, uuid)', 'public._ingest_opt_ref(jsonb, text, text, uuid)',
    'public._ingest_items_check(uuid, jsonb, boolean)', 'public._ingest_pay_check(uuid, jsonb, text, integer)',
    'public._ingest_sale(jsonb, uuid, boolean)', 'public._ingest_tender_ok(text)',
    'public._ingest_expect(uuid, jsonb)', 'public._ingest_header_rule(jsonb, numeric, numeric, numeric)',
    'public._ingest_price_changed(uuid, jsonb)', 'public._ingest_neg_stock(uuid, uuid[])',
    'public._ingest_photo(uuid, uuid, public.sales, jsonb)',
    'public._ingest_items(uuid, uuid, timestamptz, jsonb)',
    'public._ingest_exams(uuid, uuid, timestamptz, jsonb, text)',
    'public._ingest_ledger(uuid, uuid, timestamptz, uuid, jsonb, text)',
    -- step 3's helpers
    'public._ingest_protected(uuid, uuid)', 'public._ingest_admin_role(uuid)',
    'public._ingest_seats_full(uuid)', 'public._ingest_code(jsonb)',
    'public._register_undo_capture()', 'public._register_undo_keep(text, text)',
    'public._register_export_cols()', 'public._register_export_store()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f);
  end loop;
  -- every writer the kind table names
  for f in select distinct k.writer from public._register_kind_perms k loop
    execute format('revoke execute on function public.%I(uuid, uuid, timestamptz, jsonb, text) from public, anon, authenticated, service_role', f);
  end loop;
end $$;

-- The register's login, the owner's phone and the vendor (authenticated
-- sessions; each function checks who it is).
revoke execute on function
  public.register_ingest(integer, integer, integer, timestamptz, jsonb),
  public.register_ping(integer, integer, timestamptz),
  public.register_resolve_held(uuid, bigint, text),
  public.register_revert_ops(uuid, bigint, text),
  public.register_export(text, text, integer),
  public.register_export_heads(),
  public.register_snapshot_done(),
  public.register_export_ops(bigint, integer),
  public.register_fill_gap(uuid, bigint, bigint, text),
  public.prune_register_ops(timestamptz)
  from public, anon, service_role;
grant execute on function
  public.register_ingest(integer, integer, integer, timestamptz, jsonb),
  public.register_ping(integer, integer, timestamptz),
  public.register_resolve_held(uuid, bigint, text),
  public.register_revert_ops(uuid, bigint, text),
  public.register_export(text, text, integer),
  public.register_export_heads(),
  public.register_snapshot_done(),
  public.register_export_ops(bigint, integer),
  public.register_fill_gap(uuid, bigint, bigint, text),
  public.prune_register_ops(timestamptz)
  to authenticated;

-- ============================================================
-- 9) stamp THIS migration (working number, see the header)
-- ============================================================
select public.record_schema_version(34, 'register ingest: register_ingest/register_ping/register_resolve_held, _register_kind_perms, _register_guard/_register_flags, the 23 _ingest_<kind> writers, _license_state/_license_feature_for/_store_day_range (my_license_state and license_feature re-pointed, same answers), undo log (register_undo, zz_register_undo) and register_revert_ops/register_ops_foreign, register_export/_heads/_snapshot_done, register_export_ops, register_fill_gap, prune_register_ops');
commit;
