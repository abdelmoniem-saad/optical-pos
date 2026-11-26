import type { QueryClient } from '@tanstack/react-query'

/** Offline replay for CHECKOUT only.
 *
 *  ## Why this exists, and why it is scoped so narrowly
 *
 *  `OfflineBanner` used to promise "Changes will sync when you reconnect", and
 *  nothing implemented that promise: there was no write queue at all, so a
 *  sale rung up on flaky wifi was silently lost while the banner reassured the
 *  cashier it was safe. That is a lie about money, which is the worst category
 *  of defect in this repository.
 *
 *  Replay is only safe because of a decision made in Phase 1: every checkout
 *  carries an `idempotency_key`, minted once per attempt and mirrored into the
 *  sessionStorage draft (`POSContext.tsx:68`). Re-sending the same body is
 *  therefore a no-op at the database — `create_sale_order` returns the existing
 *  sale instead of writing a second one. Without that key, replaying a request
 *  whose response was lost would double-book the invoice, and the honest
 *  options would be only "fail" or "duplicate".
 *
 *  ## Why ONLY checkout
 *
 *  Checkout is the one mutation where (a) it is safe to replay, (b) losing it
 *  costs real money, and (c) it is already wrapped in a single RPC. Queuing
 *  everything would be actively dangerous: voiding a sale, deleting a
 *  purchase, or creating a user are all decisions the user made against the
 *  state they could SEE, and replaying them minutes later applies them to a
 *  world that has moved on. Those keep failing loudly, and the offline banner
 *  now says so. Extending the queue is a per-mutation decision, not a default.
 */

/** The one mutation key eligible for offline replay. `useCreateSale` must use
 *  exactly this key for the defaults in `queryClient.ts` to apply. */
export const CHECKOUT_MUTATION_KEY = ['sale-checkout'] as const

/** Why a checkout did not produce a saved sale.
 *
 *  The distinction is load-bearing. TanStack PAUSES a checkout made while
 *  offline (`networkMode: 'online'`) and `mutateAsync` then never settles — it
 *  returns a promise that stays pending, so the wizard would sit on "saving"
 *  forever with no indication the sale was being held. Reporting that as a
 *  failure is wrong too: nothing failed, and the sale WILL be saved on
 *  reconnect. So the caller distinguishes the two and says the true thing -
 *  and "queued" is claimed only when the queue really holds the sale
 *  (isCheckoutQueued below). */
export type CheckoutOutcome =
  /** The database has the sale. Show the receipt. */
  | { kind: 'saved'; invoiceNo: string }
  /** Held in the queue, not yet written. The cashier is told plainly, because
   *  a sale that is not yet a sale is a sale that can still be lost. */
  | { kind: 'queued' }
  /** Not saved. Show the reason; nothing is pending. */
  | { kind: 'failed'; message: string }

/** True when THIS checkout attempt (its idempotency key) is held in the queue.
 *
 *  Read from the mutation cache, not from the network state. "We are offline"
 *  is not the same as "the sale is queued": a checkout that failed BEFORE it
 *  reached the mutation (resolving the staff id, syncing settings) while the
 *  device was offline used to be reported as "Saved on this device" with
 *  nothing queued at all - the exact silent loss this module exists to prevent.
 *  A mutation with `networkMode: 'online'` marks itself paused synchronously
 *  when it is started offline, and again later if the connection drops between
 *  retries, so this is the true signal in both cases. */
export function isCheckoutQueued(qc: QueryClient, idempotencyKey: string): boolean {
  return qc.getMutationCache()
    .findAll({ mutationKey: CHECKOUT_MUTATION_KEY })
    .some((m) => m.state.isPaused && m.state.status === 'pending' &&
      (m.state.variables as { idempotencyKey?: string | null } | undefined)?.idempotencyKey === idempotencyKey)
}

/** The newest checkout mutation for this attempt (its idempotency key), in any
 *  state. A wizard that was unmounted while its sale sat in the queue (a tab
 *  switch) reads the outcome from here when it comes back: the promise it was
 *  waiting on belonged to the old mount. */
export function findCheckout(qc: QueryClient, idempotencyKey: string) {
  return qc.getMutationCache()
    .findAll({ mutationKey: CHECKOUT_MUTATION_KEY })
    .filter((m) => checkoutKeyOf(m.state.variables) === idempotencyKey)
    .sort((a, b) => (a.state.submittedAt ?? 0) - (b.state.submittedAt ?? 0))
    .at(-1)
}

/** The idempotency key a checkout mutation's variables carry, if any. */
export function checkoutKeyOf(variables: unknown): string | null {
  const k = (variables as { idempotencyKey?: unknown } | null | undefined)?.idempotencyKey
  return typeof k === 'string' ? k : null
}

/** The outcome to report when a checkout call has not produced a sale: queued
 *  only if THIS attempt is actually held in the queue, otherwise failed. */
export function checkoutOutcomeAfterCall(
  qc: QueryClient,
  idempotencyKey: string,
  message = 'Error saving order',
): CheckoutOutcome {
  return isCheckoutQueued(qc, idempotencyKey) ? { kind: 'queued' } : { kind: 'failed', message }
}

/** Resolves once this attempt is paused in the queue (immediately if it
 *  already is). `cancel` unsubscribes; call it once the race is decided. */
export function whenCheckoutQueued(
  qc: QueryClient,
  idempotencyKey: string,
): { promise: Promise<void>; cancel: () => void } {
  let unsubscribe = () => {}
  const promise = new Promise<void>((resolve) => {
    if (isCheckoutQueued(qc, idempotencyKey)) return resolve()
    unsubscribe = qc.getMutationCache().subscribe(() => {
      if (isCheckoutQueued(qc, idempotencyKey)) {
        unsubscribe()
        resolve()
      }
    })
  })
  return { promise, cancel: () => unsubscribe() }
}
