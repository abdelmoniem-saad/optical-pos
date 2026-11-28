-- ===========================================================================
-- 033 - the register: a shop may record on ONE register PC while the cloud
--       keeps a read-only copy; the owner's phone levers; the QR photo drop
--       (offline-v2 Phase 1, docs/offline-v2/design.md section 4.3)
--
-- !! APPLY RULE - READ BEFORE PASTING !!
--    Paste 033 only AFTER 032 (it calls 032's _is_store_admin_for), at
--    closing time: it re-creates one BEFORE trigger on 25 tables and builds
--    three indexes, which briefly lock those tables against writes. Then
--    deploy the web build with EXPECTED_SCHEMA_VERSION = 33 - not before:
--    that build shows every shop the red "database update" bar until the
--    database reads 33.
--
-- 033 SHIPS DARK. stores.register_only defaults to false and no register row
-- exists, so for every store today nothing changes, except that
-- my_permissions() gains two fields: read_only (false) and is_owner. A store
-- is switched to its register by the create-register Edge Function (Phase 4,
-- not deployed yet), never by this file.
--
-- WHAT AN OPERATOR SEES WHEN PASTING
--   * Success: `select public.schema_version()` reads 33, and NOTICE lines
--     say how many stores got an owner (part 10) and list the stores left
--     without one.
--   * The paste can STOP (and change nothing) for one reason: two logins of
--     the same store whose usernames differ only in capitals or surrounding
--     spaces ('Ahmed' and 'ahmed '). The error lists them; rename one of each
--     pair (Staff page, or SQL) and paste again (part 9).
--   * Stores listed without an owner need the vendor to run
--       select public.set_store_owner('<store id>', '<auth uid>');
--     as the vendor's own login (SQL Editor: Run as "authenticated" and pick
--     that user; the function checks is_platform_admin()). It is the only
--     way to name an owner: a direct UPDATE of stores.owner_uid is refused
--     (part 4). Needed before that shop's register is set up (Phase 4);
--     until then nothing depends on it.
--
-- RULE FOR EVERY LATER MIGRATION (also in SETUP.md and each RELEASE_03N.md):
--   the guard of part 4 fires for migrations too (they run as postgres), so a
--   data fix must never touch a register_only store: give its data
--   statements `where not public.store_is_register_only(store_id)` (stores:
--   `where not register_only`). A correction for such a store ships as a PC
--   op or a register command, so the PC and the cloud stay equal. Naming a
--   store's owner, on any store, is set_store_owner's alone (part 4).
--
-- 1) THE STORE'S TWO NEW FACTS.
--    stores.register_only (boolean, default false): the shop records on its
--    register PC; the cloud copy of its rows changes only through the
--    register's ingest (034) and the named functions below.
--    stores.owner_uid (-> auth.users, ON DELETE SET NULL): the one cloud login
--    that may install, revoke or release the register and switch staff off
--    from the phone (owner decision 2: the store's existing admin login; set
--    as part 10 says). Only set_store_owner (and the backfill) names an
--    owner, on EVERY store: the guard refuses any other write that sets
--    owner_uid to a login (part 4). Deleting a login that owns an ordinary
--    store clears the owner; for a register_only store the guard refuses
--    that (change the owner with set_store_owner first).
--    audit_log gains via_register and event_at (part 5).
--
-- 2) THE REGISTER TABLES. store_registers (one per store, decision 23: one
--    shop, one register device; design 3.2-3.3 columns), register_ops (the
--    applied op log, pk (store_id, seq), unique (store_id, op_id), with a
--    partial index on what needs attention), register_commands (the owner's
--    'staff.deactivate' queue), register_photo_tickets (part 11) and
--    register_bypass (part 4's tokens). RLS on and FORCED, no policies, every
--    grant revoked: they are reached only through the SECURITY DEFINER
--    functions below. All empty after 033.
--
-- 3) WHO IS WHAT.
--    register_store_id(): the store of the signed-in REGISTER login (its
--      store_registers row, not revoked, not quarantined, store register_only);
--      NULL for everybody else - staff, platform admins, and a public sign-up
--      login, which also gets auth_store_id() NULL (the 033 gate pins both).
--    store_is_register_only(store): the flag, for any store id (one bit). Used
--      by create-user (409 "Add staff at the shop PC"), by the guard, and by
--      later migrations' WHERE clauses. NULL or unknown -> false.
--    is_cloud_principal(user): internal; the predicate of part 1.
--
-- 4) THE GUARD. Trigger zz_register_only -> guard_register_only(), BEFORE
--    INSERT/UPDATE/DELETE FOR EACH ROW on the 25 tables a shop's data lives
--    in: customers, inventory, stock_movements, sales, sale_items,
--    order_examinations, sale_payments, shift_closes, invoice_counter,
--    suppliers, purchases, purchase_items, purchase_payments, notes, settings,
--    lens_types, frame_colors, frame_types, prescriptions, warehouses, users,
--    roles, role_permissions, user_permissions, stores. NOT on note_seen,
--    store_licenses, platform_admins, permissions, audit_log or the register
--    tables. Named zz_ so it fires after tenant_fill_store_id and every other
--    BEFORE trigger (they fire in name order).
--    The row's store is NEW.store_id (else auth_store_id()) on insert, OLD and
--    NEW on update, OLD on delete; role_store()/user_store() for the two
--    permission tables; for stores the row itself, its OLD and NEW flag.
--    A row of a register_only store raises 42501
--      'read-only: this shop records on its register PC'
--    (the text the web client recognises) unless
--      a) lensy.register_admin = that store id AND the transaction holds
--         that store's 'admin' bypass token; or
--      b) the ingest gate _register_ingest_store() = that store:
--         lensy.ingest = '1', lensy.store = that store = register_store_id()
--         (so the register's own JWT) AND the store's 'ingest' token.
--    A TOKEN is a row (transaction id, store, kind) in register_bypass, which
--    no client role can read or write; only definer code can call
--    _register_bypass(store, kind, open) that adds and removes it. So a GUC
--    alone bypasses nothing - not in a client session, not inside a definer
--    RPC called with it (where current_user is the owner), and not if a
--    client ever could set GUCs. (a) - token and GUC - is opened and closed
--    inside the definer functions that must write such a store outside
--    ingest: _register_install, _register_convert_staff,
--    _register_mark_local, set_store_owner, end_register_mode (and 034's
--    register_revert_ops), and by the paste's _backfill_store_owners to name
--    owners (below); (b)'s token by 034's register_ingest around its batch.
--    Either is ALSO honoured only when current_user is the owner of these
--    functions (a migration runs as that owner too). Switching
--    register_only, or changing the owner of a register_only store, is
--    honoured only through (a), never through ingest.
--    OWNERS, ON EVERY STORE: an insert or update that sets stores.owner_uid
--    to a login needs (a) too, register_only or not, so only
--    set_store_owner (which checks the login) names an owner; refused with
--    42501 'a store''s owner is set only with set_store_owner'. Clearing the
--    owner of an ordinary store stays free (deleting the owner's login does
--    that through the foreign key).
--    034 CONTRACT: register_ingest calls _register_bypass(store, 'ingest',
--    true) next to its lensy.ingest/lensy.store set_config calls, outside
--    any per-op savepoint, and closes it before returning;
--    register_revert_ops opens and closes the 'admin' token with
--    lensy.register_admin. Without its token each is refused like a client.
--    The guard fires for definer RPCs, PostgREST, platform admins and the
--    service role alike, so no RPC body changes; that is why it is a trigger
--    and not a change to license_write_ok (which misses the service role and
--    the platform-admin branches).
--
-- 5) TRIGGERS ON THE INGEST PATH. Under the ingest gate (part 4 (b):
--    lensy.ingest = '1', lensy.store = register_store_id() and the ingest
--    token, so never for a staff session that sets the GUCs itself, nor for
--    any RPC called with them):
--      audit_row: actor = lensy.actor, store falls back to lensy.store, and
--        the new audit_log columns via_register (true) and event_at
--        (lensy.event_at); elsewhere actor = auth.uid() as before,
--        via_register false, event_at NULL;
--      lab_status_stamp: the lab timestamps take lensy.event_at instead of
--        now(). It becomes SECURITY DEFINER like audit_row, to read the
--        token; it still only sets NEW's lab columns.
--    Outside the gate both behave exactly as before. No effective_* helper
--    is exposed.
--
-- 6) THE PHONE: my_permissions() adds read_only (= the caller's store is
--    register_only) and is_owner (= the caller is its owner_uid). When
--    read_only, is_admin is false and codes keeps only the '.view' codes the
--    caller already had, so every `isAdmin || can(x)` write gate on the phone
--    is false with no call-site change. Otherwise the first four fields are
--    byte-for-byte 029's answer.
--
-- 7) THE LEVERS (all SECURITY DEFINER, authenticated only):
--    revoke_register(store) - the store's owner or a platform admin; sets
--      revoked_at (the register login stops syncing; the till keeps selling
--      and re-claims with create-register). It writes no guarded table.
--    owner_deactivate_staff(user) - the owner of that user's store, while the
--      store is register_only; queues ONE open 'staff.deactivate' command the
--      PC applies when it next connects (design 2.7) and changes no staff row
--      here. Protected targets (the owner, cloud logins, platform admins) are
--      refused. Returns the command id; repeating it returns the same id.
--    register_status() - store members: the register's freshness
--      (last_ingest_at, last_contact_at, acked_seq, pending_reported,
--      oldest_pending_at), held op, alert, flag/refused/skip/park totals,
--      convert_pending; NULL when the store has no register.
--    register_flags(limit) - store members: the latest ops that were not
--      plain ok (kind, actor, time, status, violation codes, a short
--      summary), never the payload.
--    set_store_owner(store, uid) - platform admins (part 1).
--    end_register_mode(store, force) - the owner or a platform admin; force
--      (a lost PC) only by a platform admin. Refuses while the PC reports
--      unsent changes unless forced. Clears register_only, revokes the
--      register, raises invoice_counter to the highest numeric invoice + 1,
--      and switches off AND renames every register-local login to
--      username || '~local-' || first 8 of its id (ids kept, so history stays
--      attributed; the plain names are free again for create-user).
--    release_register(store) - INTERPRETATION (4.3 names it with only its
--      caller rule): retires the register COMPUTER while the shop stays in
--      register mode: the owner (an active admin) or a platform admin; refused
--      while the PC reports unsent changes; clears register_uid and sets
--      revoked_at, so the old PC is answered 'replaced' and stops (design
--      3.3/3.9) until a new PC is set up. It returns the released login id to
--      ban. It writes no guarded table, so it sets no bypass.
--
-- 8) SETUP PRIMITIVES (service role only; called by create-register, Phase 4):
--    _register_install(store, register uid, claimed by) - claimed by must be
--      the owner, still an active admin there, and the licence readable; the
--      login must be a fresh auth account (no staff row, not a platform
--      admin, no other register); a first claim is epoch 1, a later
--      one epoch + 1 keeping last_seq and clearing revoked/quarantined;
--      snapshot window 24 h; sets register_only. Returns epoch, last_seq, the
--      previous register uid (to ban) and the highest numeric invoice.
--    _register_convert_staff(store) - marks every cloud principal of the
--      store except the owner and platform admins 'register-convert' and
--      returns all ids in that state (the Edge Function bans each login);
--    _register_mark_local(store, ids) - those ids, and staff rows with no
--      auth login at all, become 'register-local'. A partial run is resumed
--      by calling both again; register_status().convert_pending is what is
--      left.
--
-- 9) USERNAMES ARE UNIQUE PER STORE. A precheck stops the paste, listing
--    same-store usernames equal under lower(btrim()); then
--    users_store_username_key unique (store_id, lower(btrim(username))) and
--    users_cloud_username_key unique (username) where password_hash is
--    distinct from 'register-local'; then the global users_username_key goes.
--    The cloud key stays on the EXACT text like the key it replaces, so it
--    holds for every existing row ('Ahmed' in one store and 'ahmed' in
--    another stay legal), and register-local staff may share a name across
--    stores. Inside _register_username_keys() so the gate can replay it.
--
-- 10) OWNERS. _backfill_store_owners() (internal; the paste runs it once, and
--    it touches only stores with no owner yet and not register_only) sets
--    owner_uid, store by store under part 4's (a), where the store has
--    exactly ONE active admin/owner-role login that is a cloud principal (an
--    auth login whose staff row is not 'register-local') and is not a
--    platform admin. With none or several it
--    stays NULL and the vendor sets it with set_store_owner(store, uid)
--    (platform admins only; the owner must be an active admin cloud login of
--    that store). On a register_only store a new owner also revokes the
--    register, so a fresh setup refreshes the PC's protected flags.
--
-- 11) THE QR PHOTO DROP (rev 3, design 2.9). register_photo_tickets.
--    register_photo_ticket(invoice, slot) - the register login only: a
--      single-use ticket for 15 minutes;
--    register_photo_ticket_use(ticket) - service role only (the
--      register-photo-drop Edge Function): marks an unused, unexpired ticket
--      used and returns drop/<store>/<ticket>.jpg; a second use is refused;
--    register_photo_tickets_open() / register_photo_fetched(ticket) - the
--      register login only, its own store's used, unfetched tickets.
--
-- 12) STORAGE (bucket prescriptions). lensy_storage_all (008) is left
--    unchanged: it is one FOR ALL policy whose USING also serves SELECT, so
--    narrowing it would hide the owner's own photos from his phone. Added:
--      PERMISSIVE  the register may INSERT store/<its store>/orders/<file>;
--                  it may SELECT its store folder only while its setup
--                  window is open (snapshot_until in the future, setup not
--                  done), and its drop/<its store>/ folder; it may DELETE
--                  only drop/<its store>/<file>.
--      RESTRICTIVE INSERT/UPDATE/DELETE of an object whose store is
--                  register_only is refused for every signed-in user,
--                  platform admins included, except those register rights.
--                  The store of store/<id>/... is <id>. Every other path is
--                  a legacy root path to 008, whose staff may write it, so
--                  it is the OLDEST store's; drop/<id>/... is store <id>'s
--                  as well. Refused if either store is register_only.
--      RESTRICTIVE SELECT of drop/... only for that store's register or a
--                  platform admin (008's legacy-root branch would otherwise
--                  show the new top-level folder to the oldest store's staff).
--    The service role (Edge Functions) bypasses RLS as before.
--
-- 13) INDEX sale_payments (store_id, paid_at), for the store's ledger by time.
--
-- Idempotent: safe to paste more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 032),
-- then deploy the EXPECTED_SCHEMA_VERSION = 33 web build.
-- ===========================================================================
begin;

-- ============================================================
-- 1) stores: register_only, owner_uid; audit_log: via_register, event_at
-- ============================================================
alter table public.stores
  add column if not exists register_only boolean not null default false;
alter table public.stores
  add column if not exists owner_uid uuid references auth.users(id) on delete set null;

alter table public.audit_log
  add column if not exists via_register boolean not null default false;
alter table public.audit_log
  add column if not exists event_at timestamptz;

-- ============================================================
-- 2) the register tables (RLS forced, no client grants)
-- ============================================================
create table if not exists public.store_registers (
  store_id          uuid primary key references public.stores(id) on delete cascade,
  register_uid      uuid unique references auth.users(id) on delete set null,
  epoch             integer not null default 1 check (epoch >= 1),
  claimed_at        timestamptz not null default now(),
  claimed_by        uuid references auth.users(id) on delete set null,
  revoked_at        timestamptz,
  quarantined_at    timestamptz,
  alert             text,
  alert_at          timestamptz,
  snapshot_until    timestamptz,
  snapshot_done_at  timestamptz,
  last_seq          bigint not null default 0 check (last_seq >= 0),
  max_t             timestamptz,
  last_ingest_at    timestamptz,
  last_contact_at   timestamptz,
  pending_reported  integer check (pending_reported >= 0),
  oldest_pending_at timestamptz,
  held_seq          bigint,
  held_code         text,
  held_error        jsonb,
  held_at           timestamptz,
  held_op           jsonb,
  conflict_seq      bigint,
  skipped_total     integer not null default 0 check (skipped_total >= 0),
  parked_total      integer not null default 0 check (parked_total >= 0),
  min_protocol      integer not null default 1 check (min_protocol >= 1)
);

create table if not exists public.register_ops (
  store_id    uuid not null references public.stores(id) on delete cascade,
  seq         bigint not null check (seq >= 1),
  op_id       uuid,                       -- NULL for dup_import and lost rows
  kind        text not null,
  v           integer,
  actor       uuid,                       -- the op's word; a forged one is kept as sent
  sid         uuid,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  status      text not null
              check (status in ('ok', 'flagged', 'refused', 'skipped', 'parked', 'dup_import', 'lost')),
  violations  text[] not null default '{}',
  detail      jsonb,
  payload     jsonb,
  primary key (store_id, seq),
  constraint register_ops_store_op_key unique (store_id, op_id)
);
create index if not exists register_ops_attention_idx
  on public.register_ops (store_id, status) where status <> 'ok';

create table if not exists public.register_commands (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  kind        text not null default 'staff.deactivate' check (kind = 'staff.deactivate'),
  user_id     uuid not null references public.users(id) on delete cascade,
  issued_by   uuid not null,
  issued_at   timestamptz not null default now(),
  applied_seq bigint
);
create index if not exists register_commands_open_idx
  on public.register_commands (store_id, user_id) where applied_seq is null;

create table if not exists public.register_photo_tickets (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  invoice_no  text not null,
  slot        text not null check (slot in ('rx', 'frame')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  path        text,
  fetched_at  timestamptz
);
create index if not exists register_photo_tickets_open_idx
  on public.register_photo_tickets (store_id) where used_at is not null and fetched_at is null;

-- Part 4's bypass tokens: one row per (transaction, store, kind) while a
-- definer function holds the bypass open. Never left behind: the opener
-- deletes it, and a failed transaction never wrote it.
create table if not exists public.register_bypass (
  txid     bigint not null,
  store_id uuid   not null,
  kind     text   not null check (kind in ('admin', 'ingest')),
  primary key (txid, store_id, kind)
);

do $$
declare t text;
begin
  foreach t in array array['store_registers', 'register_ops', 'register_commands', 'register_photo_tickets',
                           'register_bypass'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ============================================================
-- 3) who is what
-- ============================================================
-- A staff row that signs in to the cloud: an auth login exists for its id and
-- the row is not one of the register's own PIN-only staff.
create or replace function public.is_cloud_principal(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users u
                  where u.id = p_user and u.password_hash is distinct from 'register-local')
     and exists (select 1 from auth.users a where a.id = p_user)
$$;

create or replace function public.store_is_register_only(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.register_only from public.stores s where s.id = p_store), false)
$$;

create or replace function public.register_store_id() returns uuid
language sql stable security definer set search_path = public as $$
  select r.store_id
    from public.store_registers r
    join public.stores s on s.id = r.store_id and s.register_only
   where r.register_uid = auth.uid()
     and r.revoked_at is null
     and r.quarantined_at is null
$$;

-- The register's setup window (design 4.4 export window): open from the
-- claim for 24 hours, closed early by the setup finishing.
create or replace function public.register_snapshot_open() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.store_registers r
      join public.stores s on s.id = r.store_id and s.register_only
     where r.register_uid = auth.uid()
       and r.revoked_at is null and r.quarantined_at is null
       and r.snapshot_until > now() and r.snapshot_done_at is null)
$$;

-- Is a write to this storage object a write to a register_only store? The
-- store of store/<id>/... is <id>. Any other path in the bucket is a legacy
-- root path to 008 (008:440-443 lets the oldest store's staff write it), so
-- it is the oldest store's write - drop/... included, whatever follows; a
-- drop/<id>/... path is store <id>'s as well.
create or replace function public.storage_write_blocked(p_bucket text, p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  f       text[] := storage.foldername(p_name);
  v_store uuid;     -- the store the path names
  v_root  uuid;     -- the oldest store, for a legacy root path
begin
  if p_bucket is distinct from 'prescriptions' then
    return false;
  end if;
  if f[1] in ('store', 'drop')
     and f[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_store := f[2]::uuid;
  end if;
  if f[1] is distinct from 'store' then
    select s.id into v_root from public.stores s order by s.created_at limit 1;
  end if;
  return public.store_is_register_only(v_store) or public.store_is_register_only(v_root);
end $$;

-- ============================================================
-- 4) the guard
-- ============================================================
-- The bypass token (header, part 4). Opens or closes the token of p_store and
-- p_kind for THIS transaction. Returns true when it changed it, so a nested
-- opener closes only what it opened itself.
create or replace function public._register_bypass(p_store uuid, p_kind text, p_open boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_open then
    insert into public.register_bypass (txid, store_id, kind)
    values (txid_current(), p_store, p_kind)
    on conflict do nothing;
  else
    delete from public.register_bypass b
     where b.txid = txid_current() and b.store_id = p_store and b.kind = p_kind;
  end if;
  return found;
end $$;

-- Does THIS transaction hold that token? (No transaction id yet means it has
-- written nothing, so it cannot hold one.)
create or replace function public._register_bypass_ok(p_store uuid, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.register_bypass b
                  where b.txid = txid_current_if_assigned()
                    and b.store_id = p_store and b.kind = p_kind)
$$;

-- The ingest gate: the store 034's register_ingest is writing for, else NULL.
-- All three: lensy.ingest = '1'; lensy.store = register_store_id(), so the
-- register's own JWT; and that store's ingest token, so a definer caller.
create or replace function public._register_ingest_store() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid;
begin
  if coalesce(current_setting('lensy.ingest', true), '') <> '1' then
    return null;
  end if;
  v_store := public.register_store_id();
  if v_store is null
     or v_store::text <> coalesce(current_setting('lensy.store', true), '')
     or not public._register_bypass_ok(v_store, 'ingest') then
    return null;
  end if;
  return v_store;
end $$;

-- SECURITY INVOKER on purpose: current_user must be the caller (or the owner
-- of a definer function the caller went through) for the bypass rule.
create or replace function public.guard_register_only() returns trigger
language plpgsql set search_path = public as $$
declare
  v_old        uuid;              -- the row's store before (UPDATE, DELETE)
  v_new        uuid;              -- the row's store after (INSERT, UPDATE)
  v_ro_old     boolean := false;
  v_ro_new     boolean := false;
  v_admin_only boolean := false;  -- stores: only lensy.register_admin may do this
  v_owner_set  boolean := false;  -- stores: names an owner, so checked on EVERY store
  v_check      uuid[] := '{}';
  v_owner      boolean;
  v_ok         boolean;
  v_store      uuid;
begin
  if tg_table_name = 'stores' then
    if tg_op = 'INSERT' then
      v_new := new.id;
      v_ro_new := new.register_only;
      v_owner_set := new.owner_uid is not null;
      v_admin_only := new.register_only or v_owner_set;
    elsif tg_op = 'UPDATE' then
      v_old := old.id;
      v_new := new.id;
      v_ro_old := old.register_only;
      v_ro_new := new.register_only;
      v_owner_set := new.owner_uid is not null and new.owner_uid is distinct from old.owner_uid;
      v_admin_only := new.register_only is distinct from old.register_only
                      or v_owner_set
                      or ((old.register_only or new.register_only)
                          and new.owner_uid is distinct from old.owner_uid);
    else
      v_old := old.id;
      v_ro_old := old.register_only;
    end if;
  else
    if tg_table_name = 'role_permissions' then
      if tg_op <> 'INSERT' then v_old := public.role_store(old.role_id); end if;
      if tg_op <> 'DELETE' then v_new := public.role_store(new.role_id); end if;
    elsif tg_table_name = 'user_permissions' then
      if tg_op <> 'INSERT' then v_old := public.user_store(old.user_id); end if;
      if tg_op <> 'DELETE' then v_new := public.user_store(new.user_id); end if;
    else
      if tg_op <> 'INSERT' then v_old := old.store_id; end if;
      if tg_op <> 'DELETE' then v_new := coalesce(new.store_id, public.auth_store_id()); end if;
    end if;
    v_ro_old := v_old is not null and public.store_is_register_only(v_old);
    if v_new is not distinct from v_old then
      v_ro_new := v_ro_old;
    else
      v_ro_new := v_new is not null and public.store_is_register_only(v_new);
    end if;
  end if;

  if coalesce(v_ro_old, false) then
    v_check := array[v_old];
  end if;
  if coalesce(v_ro_new, false) and v_new is distinct from v_old then
    v_check := v_check || v_new;
  elsif coalesce(v_ro_new, false) and not coalesce(v_ro_old, false) then
    v_check := array[v_new];
  end if;
  -- Naming an owner is set_store_owner's (it checks the login), on any store.
  if v_owner_set and cardinality(v_check) = 0 then
    v_check := array[v_new];
  end if;

  if cardinality(v_check) = 0 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- The bypass is the definer functions' (or a migration's), never a client's.
  v_owner := current_user::text = (select pg_get_userbyid(p.proowner)::text
                                     from pg_proc p
                                    where p.oid = 'public.guard_register_only()'::regprocedure);

  foreach v_store in array v_check loop
    v_ok := false;
    -- Nested on purpose: the token lookups run only as the functions' owner.
    if coalesce(v_owner, false) then
      if coalesce(current_setting('lensy.register_admin', true), '') = v_store::text then
        v_ok := public._register_bypass_ok(v_store, 'admin');            -- (a)
      end if;
      if not v_ok and not v_admin_only then
        v_ok := coalesce(public._register_ingest_store() = v_store, false); -- (b)
      end if;
    end if;
    if not v_ok then
      if not (coalesce(v_ro_old, false) or coalesce(v_ro_new, false)) then
        raise exception 'a store''s owner is set only with set_store_owner'
          using errcode = '42501',
                detail  = format('%s on stores refused for store %s', lower(tg_op), v_store),
                hint    = 'The vendor runs select public.set_store_owner(store, login), which checks the login.';
      end if;
      raise exception 'read-only: this shop records on its register PC'
        using errcode = '42501',
              detail  = format('%s on %s refused for store %s', lower(tg_op), tg_table_name, v_store),
              hint    = 'Make this change at the shop PC.';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

revoke execute on function public.guard_register_only() from public, anon, authenticated, service_role;
revoke execute on function
  public._register_bypass(uuid, text, boolean),
  public._register_bypass_ok(uuid, text),
  public._register_ingest_store()
  from public, anon, authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'customers', 'inventory', 'stock_movements', 'sales', 'sale_items',
    'order_examinations', 'sale_payments', 'shift_closes', 'invoice_counter',
    'suppliers', 'purchases', 'purchase_items', 'purchase_payments', 'notes',
    'settings', 'lens_types', 'frame_colors', 'frame_types', 'prescriptions',
    'warehouses', 'users', 'roles', 'role_permissions', 'user_permissions', 'stores'
  ] loop
    execute format('drop trigger if exists zz_register_only on public.%I', t);
    execute format('create trigger zz_register_only before insert or update or delete on public.%I
                    for each row execute function public.guard_register_only()', t);
  end loop;
end $$;

-- ============================================================
-- 5) triggers on the ingest path: audit_row and lab_status_stamp
-- ============================================================
-- 014:88-111 plus the ingest gate. Outside it: the same row as before, with
-- via_register false and event_at NULL.
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_reg   uuid;               -- the register's store, on the ingest path only
  v_actor uuid := auth.uid();
  v_event timestamptz;
begin
  if coalesce(current_setting('lensy.ingest', true), '') = '1' then
    v_reg := public._register_ingest_store();
    if v_reg is not null then
      begin
        v_actor := nullif(current_setting('lensy.actor', true), '')::uuid;
      exception when others then
        v_actor := null;
      end;
      begin
        v_event := nullif(current_setting('lensy.event_at', true), '')::timestamptz;
      exception when others then
        v_event := null;
      end;
    end if;
  end if;

  begin
    v_store := coalesce(nullif(to_jsonb(new) ->> 'store_id', '')::uuid,
                        nullif(to_jsonb(old) ->> 'store_id', '')::uuid,
                        v_reg,
                        public.auth_store_id());
  exception when others then
    v_store := coalesce(v_reg, public.auth_store_id());
  end;

  insert into public.audit_log
    (actor, store_id, table_name, row_id, action, before_row, after_row, via_register, event_at)
  values (
    v_actor, v_store, tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    v_reg is not null,
    v_event
  );
  return coalesce(new, old);
end $$;

revoke execute on function public.audit_row() from public, anon, authenticated;

-- 019:76-104 with the stamp time taken from the op on the ingest path.
-- SECURITY DEFINER (it was invoker) only so it may read the ingest token; it
-- reads no table itself and writes nothing but NEW's lab columns.
create or replace function public.lab_status_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz := now();
begin
  if new.lab_status is distinct from old.lab_status then
    if coalesce(current_setting('lensy.ingest', true), '') = '1'
       and coalesce(public._register_ingest_store() = new.store_id, false) then
      begin
        v_at := coalesce(nullif(current_setting('lensy.event_at', true), '')::timestamptz, now());
      exception when others then
        v_at := now();
      end;
    end if;

    new.lab_status_changed_at := v_at;

    if new.lab_status is not null and new.lab_status <> 'Not Started' then
      new.lab_started_at := coalesce(old.lab_started_at, v_at);
    end if;

    if new.lab_status in ('Ready', 'Received') then
      new.lab_ready_at := coalesce(old.lab_ready_at, v_at);
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.lab_status_stamp() from public, anon, authenticated, service_role;

-- ============================================================
-- 6) my_permissions: read_only and is_owner
-- ============================================================
-- 029:81-89 for the four existing fields; read_only narrows them.
create or replace function public.my_permissions() returns jsonb
language sql stable security definer set search_path = public as $$
  with st as (
    select s.register_only, s.owner_uid
      from public.stores s
     where s.id = public.auth_store_id()
  ), f as (
    select coalesce((select st.register_only from st), false) as read_only,
           coalesce((select st.owner_uid = auth.uid() from st), false) as is_owner
  )
  select jsonb_build_object(
    'is_admin', coalesce(public.is_store_admin(), false) and not f.read_only,
    'active', public.is_platform_admin() or exists(select 1 from public.users where id=auth.uid() and is_active is true),
    'assigned', public.is_platform_admin() or public.auth_store_id() is not null,
    'codes', coalesce((select jsonb_agg(c) from unnest(public.supported_permissions()) c
                        where public.resolve_can(c) and (not f.read_only or c like '%.view')), '[]'::jsonb),
    'read_only', f.read_only,
    'is_owner', f.is_owner
  )
  from f
$$;

-- ============================================================
-- 7) the levers: owner's phone and vendor
-- ============================================================
create or replace function public.set_store_owner(p_store uuid, p_uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_store public.stores;
  v_prev  text := coalesce(current_setting('lensy.register_admin', true), '');
  v_tok   boolean;
begin
  if not public.is_platform_admin() then
    raise exception 'only the vendor sets a store''s owner' using errcode = '42501';
  end if;
  select * into v_store from public.stores where id = p_store for update;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if p_uid is not null and not (
       public._is_store_admin_for(p_uid, p_store)
       and public.is_cloud_principal(p_uid)
       and not exists (select 1 from public.platform_admins pa where pa.auth_uid = p_uid)) then
    raise exception 'the owner must be an active admin cloud login of this store, not a vendor account'
      using errcode = '22023';
  end if;

  v_tok := public._register_bypass(p_store, 'admin', true);
  perform set_config('lensy.register_admin', p_store::text, true);
  update public.stores set owner_uid = p_uid where id = p_store;
  -- The PC's snapshot marks the owner as protected; a new owner makes that
  -- stale, so the register must be set up again.
  if v_store.register_only and v_store.owner_uid is distinct from p_uid then
    update public.store_registers set revoked_at = coalesce(revoked_at, now())
     where store_id = p_store;
  end if;
  perform set_config('lensy.register_admin', v_prev, true);
  if v_tok then perform public._register_bypass(p_store, 'admin', false); end if;
end $$;

create or replace function public.revoke_register(p_store uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  select s.owner_uid into v_owner from public.stores s where s.id = p_store;
  if not (public.is_platform_admin() or (auth.uid() is not null and auth.uid() = v_owner)) then
    raise exception 'only the store owner or the vendor can revoke the register' using errcode = '42501';
  end if;
  update public.store_registers set revoked_at = coalesce(revoked_at, now())
   where store_id = p_store;
  if not found then
    raise exception 'this shop has no register' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.release_register(p_store uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  r       public.store_registers;
begin
  select s.owner_uid into v_owner from public.stores s where s.id = p_store;
  if not (public.is_platform_admin()
          or (auth.uid() is not null and auth.uid() = v_owner
              and public._is_store_admin_for(auth.uid(), p_store))) then
    raise exception 'only the store owner (an active admin) or the vendor can release the register'
      using errcode = '42501';
  end if;
  select * into r from public.store_registers where store_id = p_store for update;
  if not found or r.register_uid is null then
    raise exception 'this shop has no register computer to release' using errcode = '55000';
  end if;
  if coalesce(r.pending_reported, 0) > 0 then
    raise exception 'the shop PC reports % change(s) not yet sent: sync the PC first, or replace it with a forced takeover',
      r.pending_reported using errcode = '55000';
  end if;
  update public.store_registers
     set register_uid = null, revoked_at = coalesce(revoked_at, now())
   where store_id = p_store;
  return r.register_uid;
end $$;

create or replace function public.end_register_mode(p_store uuid, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner   uuid;
  v_ro      boolean;
  v_pending integer;
  v_max     bigint;
  v_next    bigint;
  v_n       integer;
  v_prev    text := coalesce(current_setting('lensy.register_admin', true), '');
  v_tok     boolean;
begin
  select s.owner_uid, s.register_only into v_owner, v_ro
    from public.stores s where s.id = p_store for update;
  if not (public.is_platform_admin() or (auth.uid() is not null and auth.uid() = v_owner)) then
    raise exception 'only the store owner or the vendor can end register mode' using errcode = '42501';
  end if;
  if coalesce(p_force, false) and not public.is_platform_admin() then
    raise exception 'only the vendor can force the end of register mode (a lost PC)' using errcode = '42501';
  end if;
  if not coalesce(v_ro, false) then
    raise exception 'this shop is not in register mode' using errcode = '55000';
  end if;
  select r.pending_reported into v_pending
    from public.store_registers r where r.store_id = p_store for update;
  if coalesce(v_pending, 0) > 0 and not coalesce(p_force, false) then
    raise exception 'the shop PC reports % change(s) not yet sent: press Sync now on the PC until nothing is waiting, then try again',
      v_pending using errcode = '55000';
  end if;

  v_tok := public._register_bypass(p_store, 'admin', true);
  perform set_config('lensy.register_admin', p_store::text, true);

  update public.stores set register_only = false where id = p_store;
  update public.store_registers set revoked_at = coalesce(revoked_at, now()) where store_id = p_store;

  -- The PC numbered its sales itself; the online counter continues above them.
  select max(case when s.invoice_no ~ '^[0-9]{1,18}$' then s.invoice_no::bigint end)
    into v_max from public.sales s where s.store_id = p_store;
  insert into public.invoice_counter (store_id, prefix, next_val)
  values (p_store, '', coalesce(v_max, 0) + 1)
  on conflict (store_id, prefix)
  do update set next_val = greatest(public.invoice_counter.next_val, excluded.next_val)
  returning next_val into v_next;

  -- Every register-local login, active or not: off, and renamed so its plain
  -- name is free for create-user. Ids are kept, so history stays attributed.
  update public.users u
     set is_active = false,
         username  = case when right(u.username, 15) = '~local-' || left(u.id::text, 8)
                          then u.username
                          else u.username || '~local-' || left(u.id::text, 8) end
   where u.store_id = p_store and u.password_hash = 'register-local';
  get diagnostics v_n = row_count;

  perform set_config('lensy.register_admin', v_prev, true);
  if v_tok then perform public._register_bypass(p_store, 'admin', false); end if;
  return jsonb_build_object('next_invoice', v_next, 'register_local_users', v_n);
end $$;

create or replace function public.owner_deactivate_staff(p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_owner uuid;
  v_ro    boolean;
  v_id    uuid;
begin
  select u.store_id into v_store from public.users u where u.id = p_user;
  select s.owner_uid, s.register_only into v_owner, v_ro
    from public.stores s where s.id = v_store for update;
  if v_store is null or auth.uid() is null or v_owner is distinct from auth.uid() then
    raise exception 'only the owner of this employee''s shop can switch them off from the phone'
      using errcode = '42501';
  end if;
  if not coalesce(v_ro, false) then
    raise exception 'this shop has no register: switch staff off on the Staff page' using errcode = '55000';
  end if;
  if p_user = v_owner
     or exists (select 1 from public.platform_admins pa where pa.auth_uid = p_user)
     or public.is_cloud_principal(p_user) then
    raise exception 'the owner, vendor accounts and cloud logins cannot be switched off from the phone'
      using errcode = '42501';
  end if;

  select c.id into v_id from public.register_commands c
   where c.store_id = v_store and c.user_id = p_user
     and c.kind = 'staff.deactivate' and c.applied_seq is null
   order by c.issued_at
   limit 1;
  if v_id is null then
    insert into public.register_commands (store_id, kind, user_id, issued_by)
    values (v_store, 'staff.deactivate', p_user, auth.uid())
    returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.register_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.auth_store_id();
  v_owner uuid;
  r       public.store_registers;
begin
  if v_store is null then
    return null;
  end if;
  select * into r from public.store_registers where store_id = v_store;
  if not found then
    return null;
  end if;
  select s.owner_uid into v_owner from public.stores s where s.id = v_store;
  return jsonb_build_object(
    'state', case when r.register_uid is null then 'released'
                  when r.quarantined_at is not null then 'quarantined'
                  when r.revoked_at is not null then 'revoked'
                  else 'active' end,
    'epoch', r.epoch,
    'claimed_at', r.claimed_at,
    'last_ingest_at', r.last_ingest_at,
    'last_contact_at', r.last_contact_at,
    'acked_seq', r.last_seq,
    'pending_reported', r.pending_reported,
    'oldest_pending_at', r.oldest_pending_at,
    'held', case when r.held_seq is null then null
                 else jsonb_build_object('seq', r.held_seq, 'code', r.held_code, 'at', r.held_at) end,
    'alert', r.alert,
    'alert_at', r.alert_at,
    'revoked_at', r.revoked_at,
    'quarantined_at', r.quarantined_at,
    'conflict_seq', r.conflict_seq,
    'flags_total', (select count(*) from public.register_ops o where o.store_id = v_store and o.status = 'flagged'),
    'refused_total', (select count(*) from public.register_ops o where o.store_id = v_store and o.status = 'refused'),
    'skipped_total', r.skipped_total,
    'parked_total', r.parked_total,
    'convert_pending', (select count(*) from public.users u
                         where u.store_id = v_store
                           and u.id is distinct from v_owner
                           and u.password_hash is distinct from 'register-local'
                           and not exists (select 1 from public.platform_admins pa where pa.auth_uid = u.id))
  );
end $$;

create or replace function public.register_flags(p_limit integer default 50)
returns table (
  seq         bigint,
  kind        text,
  actor       uuid,
  actor_name  text,
  occurred_at timestamptz,
  received_at timestamptz,
  status      text,
  violations  text[],
  summary     text
)
language sql stable security definer set search_path = public as $$
  select o.seq, o.kind, o.actor, coalesce(u.full_name, u.username),
         o.occurred_at, o.received_at, o.status, o.violations,
         left(coalesce(nullif(o.detail ->> 'summary', ''), o.kind), 200)
    from public.register_ops o
    left join public.users u on u.id = o.actor and u.store_id = o.store_id
   where o.store_id = public.auth_store_id()
     and o.status <> 'ok'
   order by o.seq desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- ============================================================
-- 8) setup primitives for create-register (service role only)
-- ============================================================
create or replace function public._register_install(p_store uuid, p_register_uid uuid, p_claimed_by uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_prev  uuid;
  v_max   bigint;
  r       public.store_registers;
  v_admin text := coalesce(current_setting('lensy.register_admin', true), '');
  v_tok   boolean;
begin
  select s.owner_uid into v_owner from public.stores s where s.id = p_store for update;
  if not found then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if v_owner is null or p_claimed_by is distinct from v_owner
     or not public._is_store_admin_for(p_claimed_by, p_store) then
    raise exception 'only the store owner, an active admin of the store, can install the register (set the owner first)'
      using errcode = '42501';
  end if;
  if not public.license_read_ok(p_store) then
    raise exception 'store licence does not allow a register' using errcode = '42501';
  end if;
  if p_register_uid is null or not exists (select 1 from auth.users a where a.id = p_register_uid) then
    raise exception 'the register login does not exist' using errcode = '22023';
  end if;
  if p_register_uid = v_owner
     or exists (select 1 from public.users u where u.id = p_register_uid)
     or exists (select 1 from public.platform_admins pa where pa.auth_uid = p_register_uid)
     or exists (select 1 from public.store_registers x
                 where x.register_uid = p_register_uid and x.store_id <> p_store) then
    raise exception 'the register login must be a fresh account of its own' using errcode = '22023';
  end if;

  select * into r from public.store_registers where store_id = p_store for update;
  if not found then
    insert into public.store_registers (store_id, register_uid, epoch, claimed_by, snapshot_until)
    values (p_store, p_register_uid, 1, p_claimed_by, now() + interval '24 hours')
    returning * into r;
  elsif r.register_uid is distinct from p_register_uid then
    v_prev := r.register_uid;
    update public.store_registers
       set register_uid     = p_register_uid,
           epoch            = epoch + 1,
           claimed_at       = now(),
           claimed_by       = p_claimed_by,
           revoked_at       = null,
           quarantined_at   = null,
           alert            = null,
           alert_at         = null,
           conflict_seq     = null,
           snapshot_until   = now() + interval '24 hours',
           snapshot_done_at = null
     where store_id = p_store
    returning * into r;
  end if;
  -- (the same login again is a retried call: nothing moves)

  v_tok := public._register_bypass(p_store, 'admin', true);
  perform set_config('lensy.register_admin', p_store::text, true);
  update public.stores set register_only = true where id = p_store and not register_only;
  perform set_config('lensy.register_admin', v_admin, true);
  if v_tok then perform public._register_bypass(p_store, 'admin', false); end if;

  select max(case when s.invoice_no ~ '^[0-9]{1,18}$' then s.invoice_no::bigint end)
    into v_max from public.sales s where s.store_id = p_store;

  return jsonb_build_object('epoch', r.epoch, 'last_seq', r.last_seq, 'previous_uid', v_prev,
                            'max_invoice', coalesce(v_max, 0), 'snapshot_until', r.snapshot_until);
end $$;

create or replace function public._register_convert_staff(p_store uuid) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_ids   uuid[];
  v_admin text := coalesce(current_setting('lensy.register_admin', true), '');
  v_tok   boolean;
begin
  select s.owner_uid into v_owner from public.stores s
   where s.id = p_store and s.register_only for update;
  if not found then
    raise exception 'install the register before converting staff' using errcode = '55000';
  end if;

  v_tok := public._register_bypass(p_store, 'admin', true);
  perform set_config('lensy.register_admin', p_store::text, true);
  update public.users u
     set password_hash = 'register-convert'
   where u.store_id = p_store
     and u.id is distinct from v_owner
     and u.password_hash is distinct from 'register-local'
     and u.password_hash is distinct from 'register-convert'
     and exists (select 1 from auth.users a where a.id = u.id)
     and not exists (select 1 from public.platform_admins pa where pa.auth_uid = u.id);
  perform set_config('lensy.register_admin', v_admin, true);
  if v_tok then perform public._register_bypass(p_store, 'admin', false); end if;

  select coalesce(array_agg(u.id order by u.id), '{}') into v_ids
    from public.users u
   where u.store_id = p_store and u.password_hash = 'register-convert';
  return v_ids;
end $$;

create or replace function public._register_mark_local(p_store uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_n     integer;
  v_admin text := coalesce(current_setting('lensy.register_admin', true), '');
  v_tok   boolean;
begin
  select s.owner_uid into v_owner from public.stores s
   where s.id = p_store and s.register_only for update;
  if not found then
    raise exception 'install the register before converting staff' using errcode = '55000';
  end if;

  v_tok := public._register_bypass(p_store, 'admin', true);
  perform set_config('lensy.register_admin', p_store::text, true);
  update public.users u
     set password_hash = 'register-local'
   where u.store_id = p_store
     and u.id is distinct from v_owner
     and not exists (select 1 from public.platform_admins pa where pa.auth_uid = u.id)
     and ((u.password_hash = 'register-convert' and u.id = any(coalesce(p_ids, '{}')))
          or (u.password_hash is distinct from 'register-local'
              and not exists (select 1 from auth.users a where a.id = u.id)));
  get diagnostics v_n = row_count;
  perform set_config('lensy.register_admin', v_admin, true);
  if v_tok then perform public._register_bypass(p_store, 'admin', false); end if;
  return v_n;
end $$;

-- ============================================================
-- 9) usernames: unique per store (precheck), cloud logins unique by text
-- ============================================================
-- Not SECURITY DEFINER and no client may run it: the paste calls it once
-- (below); the gate replays it on a rebuilt pre-033 table.
create or replace function public._register_username_keys() returns void
language plpgsql set search_path = public as $$
declare
  v_dups text;
  v_con  text;
begin
  select string_agg(format('store %s: %s', d.store_id, d.names), '; ' order by d.store_id::text)
    into v_dups
    from (select u.store_id,
                 string_agg(quote_literal(u.username), ', ' order by u.username collate "C") as names
            from public.users u
           group by u.store_id, lower(btrim(u.username))
          having count(*) > 1) d;
  if v_dups is not null then
    raise exception '033 stopped: these usernames differ only in capitals or spaces inside one store, and a username must now be unique per store. Rename one of each, then paste 033 again: %', v_dups;
  end if;

  create unique index if not exists users_store_username_key
    on public.users (store_id, lower(btrim(username)));
  create unique index if not exists users_cloud_username_key
    on public.users (username) where password_hash is distinct from 'register-local';

  -- Declared inline in 000 (`username TEXT NOT NULL UNIQUE`); found by column.
  for v_con in
    select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.users'::regclass
       and c.contype = 'u'
       and array_length(c.conkey, 1) = 1
       and a.attname = 'username'
  loop
    execute format('alter table public.users drop constraint %I', v_con);
    raise notice '033: dropped global unique % on users.username', v_con;
  end loop;
end $$;

revoke execute on function public._register_username_keys() from public, anon, authenticated, service_role;

select public._register_username_keys();

-- ============================================================
-- 10) owners: backfill where exactly one admin cloud login exists
-- ============================================================
-- Internal and repeatable: only stores with no owner yet and not in register
-- mode are touched (the data-migration rule). Naming an owner needs part 4's
-- (a) on every store, so each store's update runs under its own bypass.
create or replace function public._backfill_store_owners() returns integer
language plpgsql set search_path = public as $$
declare
  c     record;
  v_n   integer := 0;
  v_one integer;
  v_tok boolean;
begin
  for c in
    select u.store_id, (array_agg(u.id))[1] as uid
      from public.users u
      join public.stores s on s.id = u.store_id
     where s.owner_uid is null
       and not s.register_only
       and public._is_store_admin_for(u.id, u.store_id)
       and public.is_cloud_principal(u.id)
       and not exists (select 1 from public.platform_admins pa where pa.auth_uid = u.id)
     group by u.store_id
    having count(*) = 1
  loop
    v_tok := public._register_bypass(c.store_id, 'admin', true);
    perform set_config('lensy.register_admin', c.store_id::text, true);
    update public.stores s
       set owner_uid = c.uid
     where s.id = c.store_id and s.owner_uid is null and not s.register_only;
    get diagnostics v_one = row_count;
    v_n := v_n + v_one;
    perform set_config('lensy.register_admin', '', true);
    if v_tok then perform public._register_bypass(c.store_id, 'admin', false); end if;
  end loop;
  return v_n;
end $$;

revoke execute on function public._backfill_store_owners() from public, anon, authenticated, service_role;

do $$
declare
  v_set     integer;
  v_missing text;
begin
  v_set := public._backfill_store_owners();
  select string_agg(format('%s (%s)', s.name, s.id), ', ' order by s.created_at)
    into v_missing
    from public.stores s where s.owner_uid is null;
  raise notice '033: % store(s) got an owner from their single admin login', v_set;
  if v_missing is not null then
    raise notice '033: no owner yet (none or several admin logins; the vendor runs set_store_owner before a register is set up): %', v_missing;
  end if;
end $$;

-- ============================================================
-- 11) the QR photo drop
-- ============================================================
create or replace function public.register_photo_ticket(p_invoice text, p_slot text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.register_store_id();
  v       public.register_photo_tickets;
begin
  if v_store is null then
    raise exception 'only the shop''s register computer can ask for a photo ticket' using errcode = '42501';
  end if;
  if p_slot is null or p_slot not in ('rx', 'frame') then
    raise exception 'photo slot must be rx or frame' using errcode = '22023';
  end if;
  if p_invoice is null or btrim(p_invoice) !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid invoice number for a photo ticket' using errcode = '22023';
  end if;
  insert into public.register_photo_tickets (store_id, invoice_no, slot, expires_at)
  values (v_store, btrim(p_invoice), p_slot, now() + interval '15 minutes')
  returning * into v;
  return jsonb_build_object('ticket', v.id, 'expires_at', v.expires_at);
end $$;

create or replace function public.register_photo_ticket_use(p_ticket uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.register_photo_tickets;
begin
  update public.register_photo_tickets t
     set used_at = now(),
         path    = 'drop/' || t.store_id::text || '/' || t.id::text || '.jpg'
   where t.id = p_ticket
     and t.used_at is null
     and t.expires_at > now()
     and public.store_is_register_only(t.store_id)
  returning * into v;
  if not found then
    raise exception 'photo ticket is unknown, already used or expired' using errcode = '22023';
  end if;
  return jsonb_build_object('store_id', v.store_id, 'invoice_no', v.invoice_no,
                            'slot', v.slot, 'path', v.path);
end $$;

create or replace function public.register_photo_tickets_open()
returns table (id uuid, invoice_no text, slot text, path text, used_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.register_store_id();
begin
  if v_store is null then
    raise exception 'only the shop''s register computer can list its photo tickets' using errcode = '42501';
  end if;
  return query
    select t.id, t.invoice_no, t.slot, t.path, t.used_at
      from public.register_photo_tickets t
     where t.store_id = v_store and t.used_at is not null and t.fetched_at is null
     order by t.used_at, t.id;
end $$;

create or replace function public.register_photo_fetched(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.register_store_id();
begin
  if v_store is null then
    raise exception 'only the shop''s register computer can mark a photo fetched' using errcode = '42501';
  end if;
  update public.register_photo_tickets t
     set fetched_at = coalesce(t.fetched_at, now())
   where t.id = p_id and t.store_id = v_store and t.used_at is not null;
  if not found then
    raise exception 'no used photo ticket % for this register', p_id using errcode = 'P0002';
  end if;
end $$;

-- ============================================================
-- 12) storage: register insert-only, writes to register_only stores refused
-- ============================================================
drop policy if exists lensy_register_storage_insert on storage.objects;
create policy lensy_register_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'prescriptions'
    and (storage.foldername(name))[1] = 'store'
    and (storage.foldername(name))[2] = (select public.register_store_id())::text
    and (storage.foldername(name))[3] = 'orders'
    and array_length(storage.foldername(name), 1) = 3
  );

drop policy if exists lensy_register_storage_read on storage.objects;
create policy lensy_register_storage_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'prescriptions'
    and (storage.foldername(name))[2] = (select public.register_store_id())::text
    and ((storage.foldername(name))[1] = 'drop'
         or ((storage.foldername(name))[1] = 'store' and (select public.register_snapshot_open())))
  );

drop policy if exists lensy_register_storage_drop_delete on storage.objects;
create policy lensy_register_storage_drop_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'prescriptions'
    and (storage.foldername(name))[1] = 'drop'
    and (storage.foldername(name))[2] = (select public.register_store_id())::text
    and array_length(storage.foldername(name), 1) = 2
  );

drop policy if exists lensy_register_only_storage_insert on storage.objects;
create policy lensy_register_only_storage_insert on storage.objects
  as restrictive for insert to authenticated
  with check (
    not public.storage_write_blocked(bucket_id, name)
    or ((storage.foldername(name))[1] = 'store'
        and (storage.foldername(name))[2] = (select public.register_store_id())::text
        and (storage.foldername(name))[3] = 'orders'
        and array_length(storage.foldername(name), 1) = 3)
  );

drop policy if exists lensy_register_only_storage_update on storage.objects;
create policy lensy_register_only_storage_update on storage.objects
  as restrictive for update to authenticated
  using (not public.storage_write_blocked(bucket_id, name))
  with check (not public.storage_write_blocked(bucket_id, name));

drop policy if exists lensy_register_only_storage_delete on storage.objects;
create policy lensy_register_only_storage_delete on storage.objects
  as restrictive for delete to authenticated
  using (
    not public.storage_write_blocked(bucket_id, name)
    or ((storage.foldername(name))[1] = 'drop'
        and (storage.foldername(name))[2] = (select public.register_store_id())::text
        and array_length(storage.foldername(name), 1) = 2)
  );

drop policy if exists lensy_register_drop_read on storage.objects;
create policy lensy_register_drop_read on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id is distinct from 'prescriptions'
    or (storage.foldername(name))[1] is distinct from 'drop'
    or (storage.foldername(name))[2] = (select public.register_store_id())::text
    or (select public.is_platform_admin())
  );

-- ============================================================
-- 13) index: the store's ledger by time
-- ============================================================
create index if not exists sale_payments_store_paid_idx
  on public.sale_payments (store_id, paid_at);

-- ============================================================
-- 14) grants
-- ============================================================
-- Internal: no client role.
revoke execute on function public.is_cloud_principal(uuid) from public, anon, authenticated, service_role;

-- The service role only (create-register, register-photo-drop).
revoke execute on function
  public._register_install(uuid, uuid, uuid),
  public._register_convert_staff(uuid),
  public._register_mark_local(uuid, uuid[]),
  public.register_photo_ticket_use(uuid)
  from public, anon, authenticated;
grant execute on function
  public._register_install(uuid, uuid, uuid),
  public._register_convert_staff(uuid),
  public._register_mark_local(uuid, uuid[]),
  public.register_photo_ticket_use(uuid)
  to service_role;

-- Signed-in users (each checks who is asking itself). The service role also
-- needs the two the guard calls when it writes.
revoke execute on function
  public.my_permissions(),
  public.store_is_register_only(uuid),
  public.register_store_id(),
  public.register_snapshot_open(),
  public.storage_write_blocked(text, text),
  public.set_store_owner(uuid, uuid),
  public.revoke_register(uuid),
  public.release_register(uuid),
  public.end_register_mode(uuid, boolean),
  public.owner_deactivate_staff(uuid),
  public.register_status(),
  public.register_flags(integer),
  public.register_photo_ticket(text, text),
  public.register_photo_tickets_open(),
  public.register_photo_fetched(uuid)
  from public, anon;
grant execute on function
  public.my_permissions(),
  public.store_is_register_only(uuid),
  public.register_store_id(),
  public.register_snapshot_open(),
  public.storage_write_blocked(text, text),
  public.set_store_owner(uuid, uuid),
  public.revoke_register(uuid),
  public.release_register(uuid),
  public.end_register_mode(uuid, boolean),
  public.owner_deactivate_staff(uuid),
  public.register_status(),
  public.register_flags(integer),
  public.register_photo_ticket(text, text),
  public.register_photo_tickets_open(),
  public.register_photo_fetched(uuid)
  to authenticated;
grant execute on function
  public.store_is_register_only(uuid),
  public.register_store_id()
  to service_role;

-- ============================================================
-- 15) stamp THIS migration (020 makes an unstamped file a red build)
-- ============================================================
select public.record_schema_version(33, 'register (dark): stores.register_only and owner_uid (owner backfill, set_store_owner), store_registers/register_ops/register_commands/register_photo_tickets, register_store_id, store_is_register_only, guard trigger zz_register_only on 25 tables with definer/ingest bypass, audit_row and lab stamp on the ingest path, my_permissions read_only/is_owner, revoke/release/end register, owner_deactivate_staff, register_status/flags, service-role setup primitives, per-store usernames, register storage policies, QR photo tickets, sale_payments (store_id, paid_at) index');
commit;
