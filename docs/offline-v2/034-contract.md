# Migration 034 (register ingest): contracts for Phases 2-4

`web/supabase/034_register_ingest.sql` is the cloud side of the offline register:
the shop PC sends its ordered operation log and `register_ingest` applies each
operation through one writer per kind. It was built and reviewed in Phase 1b
(2026-11-28) and is **not applied to production**: it is applied in Phase 4,
under the next free migration number, after the end-to-end parity test is
green (design section 4.4). This file lists what the PC code (Phases 2-4) and
the `create-register` Edge Function must honour. The migration's header
(parts 1-7) is the authoritative, line-level version; design sections 3 and
4.4 are the spec.

## State
- Gates: `tests/034_register_ingest_test.sql` (268), `tests/034_ingest_twin_test.sql`
  (12: the same money scenarios through the online RPCs in one store and through
  ingest in another; equal ledgers, stock, headers, Z). Full suite 1009, green
  in a Cairo session and in UTC. Bench (outside the gate):
  `web/supabase/bench/register_backlog.sql` - 2,000 ops in 5.4 s, ~4 undo rows per op.
- Reviewed independently for security and for money parity; the five confirmed
  findings are fixed and listed in design Appendix A.6 (R34-1 to R34-5).
- Kept on branch `offline-v2-phase1b` (draft PR). Do not merge before Phase 4.

## Calling ingest
- Writer signature: `(p_store, p_actor, p_at, p jsonb, p_kind text)`; 23 writers
  cover 39 kinds (`_register_kind_perms` lists kind, permission codes, money,
  writer, log, feature, fields, min_v, max_v).
- Outcomes: a returned flag applies the op and records the code; `refused: <code>`
  records the op unapplied and the queue continues (alert set); `malformed:`
  (22023) = MAL hold, `state:` = STATE hold, SQLSTATE class 22/23 = INT hold,
  40001/40P01 = retry, anything else = FAULT hold. A hold stops the batch;
  `held_*` describes it; `register_resolve_held` (reason >= 3 chars) parks it.
- `store_registers` is written once per call; writers must use `lensy.seq`, never
  read `last_seq`/`max_t` mid-batch.
- Envelope extras: optional `f` (text array; only `tz_mismatch` honoured); a
  `noop` may have no sid; resend of a `dup_import` op is a dup.
- Response extras: results may hold `{s, st:'gap'}`, `{s, st:'dup_import', dup_of}`,
  `{s, st:'server_upgrade_required'}` (+ top-level `server_upgrade_required:true`).
- Early answers: store no longer register-only -> `revoked`; non-register caller
  -> `replaced`; resend at a seq whose row is missing or whose id differs ->
  seq conflict (quarantine).

## Payload shapes the PC must send (header parts 6 and 7)
- Money keys use column names (`total_amount`, `net_amount`, ...); the
  re-checkout header is flat. `sale.refund` row amount > 0; `sale.void` refunds
  are the stored signed rows (amount < 0). `expect.tenders` is an array of
  `{method, amount}` or a `{method: amount}` map.
- Ledger and stock-movement notes must be derived exactly as the online RPCs
  write them (`applyOp` and the server must agree).
- `sale.create` sends `lab_status` explicitly (null when absent); a sale line
  must have a `product_id` (else flagged `unknown_product`).
- `staff.create {id, username, full_name?, role_id?, is_active?}`: username
  `^[^@\s]{2,32}$`, never superadmin/register, id never an auth login; the PC
  refuses a name equal under `lower(btrim())` to any user of the store.
- `staff.set_access {user_id, role_id?, active, via_command?}`,
  `staff.update_profile {user_id, full_name}`, `role.create {id, name}` (server
  trims the name; trim locally too), `role.set_permission {role_id, code,
  granted, id?}`, `user.set_permission {user_id, code, allow: true|false|null, id?}`
  (send `id` so grant rows match the mirror).
- Empty sku -> NULL; unknown `time_zone` -> MAL; `metadata.reorder` positions are
  1-based; `frame_types` has no sort_order.
- A local `customer.delete` / `note.delete` also removes that customer's
  prescriptions / that note's `note_seen` rows.

## Rules the PC's own code must mirror
- `zreport.ts`: a shift-close window ends at the next midnight **in the store's
  zone** after `to_at`'s UTC date: `((to_at at time zone 'UTC')::date + 1)` at
  `store_time_zone`. Never the browser's zone. The server recompute does exactly
  this and flags `z_mismatch` otherwise.
- Event times (`t`) are stored verbatim; the server never re-dates them.

## Owner commands
- Switching a cashier off from the phone queues `register_commands`; the PC
  applies it as `staff.set_access {user_id, active:false, via_command:<id>}` with
  actor = `owner_uid`, sid = null; this sets `applied_seq`.

## Setup and re-hydrate (Phase 4, create-register)
- Setup: read the 25 exported tables with `register_export` during the snapshot
  window (`{table, rows, after, more}`, `p_after` = last key as text),
  `register_export_heads` for sizes, `protected` marks the PC's protected
  targets, then `register_snapshot_done()`.
- Re-hydrate: `register_export_ops` (owner session only, <= 500 rows); error
  `retention` (55000) means set up again. dup_import rows have `op_id` null and
  the original id in `detail.op_id`; lost rows have no payload.

## Recovery after a stolen register token (design 6.3, rewritten by R34-5)
1. create-register `reclaim` calls `_register_attest(store, pc.acked_seq,
   pc.outbox_op_ids)` (service role) while the register is quarantined or
   revoked, BEFORE `_register_install`. Send the FULL outbox op ids.
2. If the returned `from_seq` is not null, reclaim refuses with
   `foreign_ops{from_seq}`. The vendor checks `register_revert_preview(store)`
   and runs `register_revert_ops(store, from_seq, reason)` with exactly that
   seq (anything else is refused). The revert uses up the attestation.
3. Reclaim calls `_register_attest` again; `from_seq` must now be null; then it
   installs. A re-install changes the epoch, which makes an old attestation stale.
- `prune_register_ops` has no scheduler: a platform-admin session runs it
  (payloads after 400 days keep the row skeleton; undo rows 60 days after
  ingest).
