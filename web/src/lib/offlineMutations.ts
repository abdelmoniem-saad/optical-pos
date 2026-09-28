import { onlineManager } from '@tanstack/react-query'

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
 *  reconnect. So the caller distinguishes the two and says the true thing. */
export type CheckoutOutcome =
  /** The database has the sale. Show the receipt. */
  | { kind: 'saved'; invoiceNo: string }
  /** Held in the queue, not yet written. The cashier is told plainly, because
   *  a sale that is not yet a sale is a sale that can still be lost. */
  | { kind: 'queued' }
  /** Not saved. Show the reason; nothing is pending. */
  | { kind: 'failed'; message: string }

/** True when the error means "paused for offline", not "rejected".
 *
 *  TanStack's own signal for a paused mutation is `mutation.state.isPaused`,
 *  which lives on the core `Mutation` object — the React `UseMutationResult`
 *  returned by a hook does NOT re-export it, so it cannot be read from the
 *  hook's return value (`tsc` rejects that shape; see the note in the commit
 *  message). The reliable caller-side signal is the online manager: a mutation
 *  configured with `networkMode: 'online'` can only be paused because the
 *  device went offline, and a paused mutation is by definition unsettled, so
 *  "we are offline" is exactly the condition under which a checkout must be
 *  reported as queued rather than saved or failed.
 *
 *  Reading the network instead of matching a string in the thrown error is
 *  deliberate: message-matching would mislabel any unrelated failure that
 *  happens to occur while the connection drops, telling the cashier a sale is
 *  safely queued when it was in fact rejected. */
export function isQueuedOffline(): boolean {
  return !onlineManager.isOnline()
}
