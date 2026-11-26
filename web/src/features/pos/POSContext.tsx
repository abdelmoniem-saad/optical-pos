import { usePermissions } from '../../data/permissions'
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { findCheckout, isCheckoutQueued, whenCheckoutQueued } from '../../lib/offlineMutations'
import { wasQueued } from '../../lib/checkoutJournal'
import {
  nextInvoiceNo,
  useCreateSale,
  useUpdateSaleFull,
  type CartLine,
  type CreateSaleInput,
} from '../../data/sales'
import { checkoutErrorMessage as describeCheckoutError, recheckoutProblem } from './checkoutErrors'
import { useAddCustomer, useUpdateCustomer } from '../../data/customers'
import { resolveStaffUserId } from '../../data/staff'
import { isMissingPaymentLedger } from '../../data/salesPayments'
import { addMissingOrderMetadata } from '../../data/metadata'
import { findOrderImages } from '../../lib/storage'
import { useStoreId } from '../../lib/licensing'
import { useAuth } from '../../lib/auth'
import { useI18n } from '../../i18n/LanguageContext'
import { clearPosDraft, readPosDraft, writePosDraft } from '../../lib/posDraft'
import type { Customer, CustomerInsert, Product, Sale } from '../../lib/database.types'
import {
  addLine,
  computeTotals,
  receiptTotals,
  removeLine,
  setLineDiscount as setLineDiscountValue,
  setQty,
  type Totals,
} from './pricing'
import {
  clampPaymentLines,
  legacyMethodKey,
  paymentsTotal,
  removeLine as removePayLine,
  tendersFromLedger,
  upsertLine,
  type PaymentLine,
} from '../../lib/payments'
import {
  emptyExam,
  inferLoadedCategory,
  type Category,
  type Exam,
  type POSStep,
} from './types'

// Co-locating this helper with the wizard state is intentional; see the note
// by usePOS below. The fast-refresh rule only matters during HMR edits.
// eslint-disable-next-line react-refresh/only-export-components
export function localDateISO(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function plusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDateISO(d)
}

/** Idempotency key for ONE checkout attempt (migration 012). Uses
 *  crypto.randomUUID when available; POS tablets often run over plain-http
 *  LAN where randomUUID is withheld (insecure context), so fall back to
 *  getRandomValues and pack the hex into uuid form (any valid uuid shape
 *  satisfies the column - only uniqueness matters). */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** Editable customer info, shared by the customer step and the order step. */
export type CustomerDraft = {
  name: string
  phone: string
  city: string
  email: string
  address: string
}

const emptyDraft: CustomerDraft = { name: '', phone: '', city: '', email: '', address: '' }

export type CompletedOrder = {
  sale: Sale
  customer: Customer | null
  cartItems: CartLine[]
  examinations: Exam[]
  totals: Totals
  invoiceNo: string
  doctorName: string
  deliveryDate: string
  /** True when this checkout OVERWROTE an existing invoice (re-checkout). */
  isUpdate: boolean
}

type State = {
  step: POSStep
  category: Category | null
  customer: Customer | null
  customerDraft: CustomerDraft
  cartItems: CartLine[]
  examinations: Exam[]
  discount: number
  // Split tenders for this order (cash/wallet/instapay, one row per method).
  // Sum of the rows = Amount Paid; checkout clamps them to the net amount.
  payments: PaymentLine[]
  grossOverride: number | null
  doctorName: string
  deliveryDate: string
  // Order photo slots (migration 007).
  rxImagePath: string | null
  frameImagePath: string | null
  invoiceNo: string
  /** Idempotency key of the current checkout attempt (migration 012).
   *  Mirrored into the draft so a reload-resume replays the SAME attempt. */
  idempotencyKey: string | null
  /** When Finish was clicked for this attempt (ISO), sent as order_date /
   *  paid_at so a queued checkout replayed later keeps the real sale time.
   *  Mirrored into the draft with the key; cleared when the attempt fails. */
  orderDate: string | null
  /** Sale created by the FIRST Finish Checkout; later checkouts update it. */
  savedSale: Sale | null
  savedHadExams: boolean
  /** The per-method tenders savedSale's ledger held when this wizard last saw
   *  it (loaded from the ledger, or what the last checkout wrote). Sent with a
   *  re-checkout so the server refuses it if History changed the split since
   *  (030), and compared before sending so a refund is never asked of the
   *  server. null = unknown (a draft from before this field). */
  savedTenders: PaymentLine[] | null
  completed: CompletedOrder | null
  busy: boolean
  error: string | null
}

function initialState(): State {
  return {
    step: 'category',
    category: null,
    customer: null,
    customerDraft: { ...emptyDraft },
    cartItems: [],
    examinations: [],
    discount: 0,
    payments: [],
    grossOverride: null,
    doctorName: '',
    deliveryDate: plusDays(3),
    rxImagePath: null,
    frameImagePath: null,
    invoiceNo: '',
    idempotencyKey: null,
    orderDate: null,
    savedSale: null,
    savedHadExams: false,
    savedTenders: null,
    completed: null,
    busy: false,
    error: null,
  }
}

/** The persisted copy never keeps transient flags (in-flight request, error).
 *  Older drafts (pre split-payments) stored a single `amountPaid` number -
 *  they load as ONE cash line so nobody's in-progress order breaks. */
function draftSafe(s: State): State {
  const legacy = s as State & { amountPaid?: number }
  const payments = Array.isArray(s.payments)
    ? s.payments
    : (legacy.amountPaid ?? 0) > 0
      ? [{ method: 'cash', amount: legacy.amountPaid as number }]
      : []
  const copy = { ...s } as State & { amountPaid?: number }
  delete copy.amountPaid
  return { ...copy, payments, savedTenders: s.savedTenders ?? null, busy: false, error: null }
}

type Action = { type: 'PATCH'; patch: Partial<State> } | { type: 'RESET' }

function reducer(state: State, action: Action): State {
  if (action.type === 'RESET') return initialState()
  return { ...state, ...action.patch }
}

// The New Sale wizard intentionally SURVIVES tab switches: navigating to
// another tab unmounts this route, so the latest state is mirrored into a
// module-level snapshot and re-hydrated when the tab is opened again. Every
// other screen reloads fresh by design; only this wizard continues where it
// left off. "startNewSale" (receipt dialog) is the explicit way to reset.
let memoryState: State | null = null

type POSApi = {
  state: State
  totals: Totals
  // navigation
  selectCategory: (c: Category) => void
  back: () => void
  goToAdditional: () => void
  // customer (draft is shared with the order-step editors)
  setCustomerDraft: (patch: Partial<CustomerDraft>) => void
  saveCustomerEdits: (patch: Partial<CustomerDraft>) => Promise<void>
  continueWithCustomer: (
    form: Partial<Customer> & { name: string },
    selected: Customer | null,
  ) => Promise<void>
  // examination
  addExam: (data?: Exam) => void
  updateExam: (index: number, patch: Partial<Exam>) => void
  removeExam: (index: number) => void
  setDoctorName: (v: string) => void
  setDeliveryDate: (v: string) => void
  /** Attach/replace/clear one of the two order photo slots. */
  setOrderImage: (slot: 'rx' | 'frame', path: string | null) => void
  // cart
  quickAdd: (term: string) => Promise<void>
  addProduct: (p: Product) => void
  changeQty: (productId: string, qty: number) => void
  /** Line-level discount (migration 013), clamped to the line's gross value. */
  setLineDiscount: (productId: string, amount: number, reason?: string | null) => void
  removeFromCart: (productId: string) => void
  // pricing
  setDiscount: (n: number) => void
  /** Upsert one tender row (a 0 amount keeps the row for mid-edit inputs). */
  setPaymentLine: (method: string, amount: number) => void
  removePaymentLine: (method: string) => void
  setGross: (n: number) => void
  // checkout
  finishOrder: () => Promise<void>
  /** Close the receipt dialog but KEEP the order open for further edits. */
  closeReceipt: () => void
  /** Throw the whole wizard away and start a brand-new sale. */
  startNewSale: () => void
  /** Open an EXISTING invoice in the wizard (day navigation): hydrates every
   *  field from the saved sale so Finish Checkout re-checkouts it in place.
   *  Throws on failure - callers surface the error. */
  loadSale: (saleId: string) => Promise<void>
}

const Ctx = createContext<POSApi | undefined>(undefined)

export function POSProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => memoryState ?? initialState())
  const ref = useRef(state)
  ref.current = state
  // One idempotency key per checkout attempt: a REF so a double-click on
  // Finish reuses the key before React re-renders, mirrored into state so the
  // sessionStorage draft survives a reload mid-attempt (migration 012).
  const idemRef = useRef<string | null>(state.idempotencyKey)

  // Tab switches keep the wizard in memoryState (module scope). A RELOAD loses
  // that, so the draft is also mirrored into sessionStorage and restored below,
  // as soon as we know which user + store it belongs to.
  const hadMemory = useRef(memoryState !== null)
  const hydrated = useRef(false)
  const { user } = useAuth()
  const { t } = useI18n()
  const perms = usePermissions()

  // Mirror every change into the module-level snapshot (tab-switch survival).
  useEffect(() => {
    memoryState = state
  }, [state])

  const qc = useQueryClient()
  const createSale = useCreateSale()
  const updateSale = useUpdateSaleFull()
  const addCustomer = useAddCustomer()
  const updateCustomer = useUpdateCustomer()
  const { data: myStoreId, isLoading: storeLoading } = useStoreId()

  // Restore a sessionStorage draft once auth + the store key are known (a draft
  // from another account or store is ignored).
  useEffect(() => {
    if (hydrated.current || hadMemory.current) {
      hydrated.current = true
      return
    }
    if (!user || storeLoading) return
    hydrated.current = true
    const draft = readPosDraft<State>(user.id, myStoreId ?? null)
    if (draft) {
      dispatch({ type: 'PATCH', patch: draftSafe(draft) })
      idemRef.current = draft.idempotencyKey ?? null
    }
  }, [user, storeLoading, myStoreId])

  // Persist every change: sessionStorage survives a reload (not closing the tab).
  useEffect(() => {
    if (!hydrated.current) return
    writePosDraft(user?.id ?? null, myStoreId ?? null, draftSafe(state))
  }, [state, user, myStoreId])

  const patch = (p: Partial<State>) => dispatch({ type: 'PATCH', patch: p })
  const totals = computeTotals(state.cartItems, {
    discount: state.discount,
    amountPaid: paymentsTotal(state.payments),
    grossOverride: state.grossOverride,
  })

  // ---- navigation ----
  const selectCategory = (c: Category) => patch({ category: c, step: 'customer' })

  const back = () => {
    const s = ref.current
    const map: Record<POSStep, POSStep> = {
      category: 'category',
      customer: 'category',
      additional: 'cart',
      cart: 'customer',
    }
    patch({ step: map[s.step] })
  }

  const goToAdditional = () => patch({ step: 'additional' })

  // ---- customer ----
  /** Keystroke-level draft updates (shared with the order-step editors). */
  const setCustomerDraft = (p: Partial<CustomerDraft>) =>
    patch({ customerDraft: { ...ref.current.customerDraft, ...p } })

  /**
   * Persist customer-field edits (order-step editors / customer step).
   * Edits ALWAYS update the SAME customer record - renaming here never
   * spawns a duplicate customer.
   */
  async function saveCustomerEdits(p: Partial<CustomerDraft>) {
    const draft = { ...ref.current.customerDraft, ...p }
    patch({ customerDraft: draft })
    const c = ref.current.customer
    if (!c || !perms.can('customers.edit')) return
    const changes: Partial<CustomerInsert> = {}
    const name = p.name?.trim()
    if (name && name !== c.name) changes.name = name
    for (const k of ['phone', 'city', 'email', 'address'] as const) {
      const v = p[k]
      if (v !== undefined && (c[k] ?? '') !== v) changes[k] = v
    }
    if (!Object.keys(changes).length) return
    try {
      await updateCustomer.mutateAsync({ id: c.id, patch: changes })
      patch({ customer: { ...c, ...changes } as Customer, error: null })
    } catch (e: any) {
      console.error('saveCustomerEdits failed:', e)
      const msg = e?.message || (e instanceof Error ? e.message : 'Could not save customer')
      patch({ error: msg })
    }
  }

  /** Entering the cart keeps the SAME invoice number - never burn a new one. */
  async function enterAfterCustomer(customer: Customer) {
    let invoiceNo = ref.current.invoiceNo
    if (invoiceNo && !ref.current.savedSale) {
      try {
        const { data: existing } = await supabase
          .from('sales')
          .select('id')
          .eq('invoice_no', invoiceNo)
          .limit(1)
        if (existing && existing.length > 0) {
          invoiceNo = ''
        }
      } catch {
        // ignore check error
      }
    }
    if (!invoiceNo) {
      invoiceNo = await nextInvoiceNo()
    }
    patch({ customer, invoiceNo, step: 'cart' })
  }

  async function continueWithCustomer(
    form: Partial<Customer> & { name: string },
    selected: Customer | null,
  ) {
    const name = form.name.trim()
    if (!name) {
      patch({ error: 'Please enter customer name.' })
      return
    }
    patch({ busy: true, error: null })
    try {
      let customer = selected
      if (customer && customer.name === name) {
        // Picking the same customer again (e.g. Back from the order step):
        // push changed contact fields to the DB instead of dropping them.
        const changes: Partial<CustomerInsert> = {}
        if ((customer.phone ?? '') !== form.phone) changes.phone = form.phone
        if ((customer.city ?? '') !== form.city) changes.city = form.city
        if ((customer.email ?? '') !== form.email) changes.email = form.email
        if ((customer.address ?? '') !== form.address) changes.address = form.address
        if (Object.keys(changes).length && perms.can('customers.edit')) {
          await updateCustomer.mutateAsync({ id: customer.id, patch: changes })
          customer = { ...customer, ...form } as Customer
        }
      } else {
        // Different/edited name → treat as a new customer (existing behaviour).
        if (!perms.can('customers.create')) throw new Error('You do not have permission to create customers.')
        customer = await addCustomer.mutateAsync({
          name,
          phone: form.phone ?? '',
          city: form.city ?? '',
          email: form.email ?? '',
          address: form.address ?? '',
        })
      }
      await enterAfterCustomer(customer)
    } catch (e: any) {
      console.error('continueWithCustomer failed:', e)
      const msg = e?.message || (e instanceof Error ? e.message : 'Could not save customer')
      patch({ error: msg })
    } finally {
      patch({ busy: false })
    }
  }

  // ---- examination ----
  const addExam = (data?: Exam) =>
    patch({ examinations: [...ref.current.examinations, data ?? emptyExam()] })

  const updateExam = (index: number, p: Partial<Exam>) =>
    patch({
      examinations: ref.current.examinations.map((e, i) =>
        i === index ? { ...e, ...p } : e,
      ),
    })

  const removeExam = (index: number) =>
    patch({ examinations: ref.current.examinations.filter((_, i) => i !== index) })

  const setDoctorName = (v: string) => patch({ doctorName: v })
  const setDeliveryDate = (v: string) => patch({ deliveryDate: v })
  const setOrderImage = (slot: 'rx' | 'frame', path: string | null) =>
    patch(slot === 'rx' ? { rxImagePath: path } : { frameImagePath: path })

  /** Find an existing Frame product by name, or create a zero-priced one. */
  async function findOrCreateFrame(name: string): Promise<Product | null> {
    const raw = name.trim()
    if (!raw) return null
    // Strip trailing parenthetical details (e.g. "RayBan RB2140 (Black)" -> "RayBan RB2140")
    const clean = raw.split(' (')[0].trim() || raw
    try {
      const { data: existing } = await supabase
        .from('inventory')
        .select('*')
        .eq('category', 'Frame')
        .ilike('name', clean)
        .limit(1)
        .returns<Product[]>()
      if (existing && existing.length) return existing[0]

      // Check across any category before attempting creation
      const { data: anyExisting } = await supabase
        .from('inventory')
        .select('*')
        .ilike('name', clean)
        .limit(1)
        .returns<Product[]>()
      if (anyExisting && anyExisting.length) return anyExisting[0]

      if (!perms.can('inventory.create')) return null
      const { data: created, error } = await supabase
        .from('inventory')
        .insert({ name: clean, category: 'Frame', sale_price: 0, cost_price: 0 })
        .select()
        .maybeSingle<Product>()
      if (error) {
        console.warn('Could not auto-create frame product in inventory:', error)
        return null
      }
      return created
    } catch (e) {
      console.warn('findOrCreateFrame error:', e)
      return null
    }
  }

  /** Add New-frame lines from examinations into the cart (runs at checkout). */
  async function addNewFramesFromExams(
    cart: CartLine[],
    examinations: Exam[],
  ): Promise<CartLine[]> {
    let next = [...cart]
    for (const exam of examinations) {
      if (exam.frame_status === 'New' && exam.frame_info) {
        try {
          const frame = await findOrCreateFrame(String(exam.frame_info))
          if (frame && !next.some((i) => i.product_id === frame.id)) {
            next = addLine(next, frame)
          }
        } catch (e) {
          console.warn('addNewFramesFromExams error:', e)
        }
      }
    }
    return next
  }

  // ---- cart ----
  async function quickAdd(term: string) {
    const t = term.trim()
    if (!t) return
    // Exact SKU first, then name contains. Mirrors find_product_by_name_or_sku.
    let { data } = await supabase
      .from('inventory')
      .select('*')
      .ilike('sku', t)
      .limit(1)
      .returns<Product[]>()
    if (!data || !data.length) {
      const res = await supabase
        .from('inventory')
        .select('*')
        .ilike('name', `%${t}%`)
        .limit(1)
        .returns<Product[]>()
      data = res.data ?? []
    }
    if (!data.length) {
      patch({ error: `Product not found: ${t}` })
      return
    }
    patch({ cartItems: addLine(ref.current.cartItems, data[0]), error: null })
  }

  const addProduct = (p: Product) =>
    patch({ cartItems: addLine(ref.current.cartItems, p) })
  const changeQty = (productId: string, qty: number) =>
    patch({ cartItems: setQty(ref.current.cartItems, productId, qty) })
  const removeFromCart = (productId: string) =>
    patch({ cartItems: removeLine(ref.current.cartItems, productId) })

  // Line-level discount (migration 013). The database is the authority: it
  // refuses a discount larger than the line and folds the sum into the
  // header discount, so this is a request, not a stored truth. Clamped here
  // too so the cashier never sees a value the server would reject.
  const setLineDiscount = (productId: string, amount: number, reason?: string | null) =>
    patch({
      cartItems: setLineDiscountValue(ref.current.cartItems, productId, amount, reason),
    })

  // ---- pricing ----
  const setDiscount = (n: number) => patch({ discount: Math.max(0, n || 0) })
  const setPaymentLine = (method: string, amount: number) =>
    patch({ payments: upsertLine(state.payments, method, amount) })
  const removePaymentLine = (method: string) =>
    patch({ payments: removePayLine(state.payments, method) })
  // The gross total is always editable; null means "track the items total".
  const setGross = (n: number) => patch({ grossOverride: Math.max(0, n || 0) })

  // ---- checkout ----
  /** A failed checkout in the shop's language instead of a raw Postgres message. */
  const checkoutErrorMessage = (e: unknown) => describeCheckoutError(e, t)
  const queuedMessage = t('Saved on this device. It will sync to the shop when you reconnect.')

  /** The wizard's own sale after a FIRST checkout: the server has `sale`, made
   *  from `input` (what was sent). Shared by Finish and by the queue watcher
   *  below, which applies a sale the queue saved while this wizard was away. */
  function savedPatch(sale: Sale, input: CreateSaleInput, s: State, totals: Totals, isUpdate: boolean): Partial<State> {
    const invoiceNo = sale.invoice_no || s.invoiceNo
    return {
      busy: false,
      invoiceNo,
      savedSale: sale,
      savedHadExams: (input.examinations?.length ?? 0) > 0,
      // The ledger now holds exactly these (create writes them; a re-checkout
      // reconciles to them - 030).
      savedTenders: input.payments ?? [],
      completed: {
        sale,
        customer: s.customer,
        cartItems: input.items,
        examinations: s.examinations,
        // As the database stored them, so this print and a reprint agree (M6).
        totals: receiptTotals(input.items, totals),
        invoiceNo,
        doctorName: s.doctorName,
        deliveryDate: s.deliveryDate,
        isUpdate,
      },
    }
  }

  // The offline queue outlives this wizard: a tab switch unmounts it while its
  // sale is still held, and the promise finishOrder was waiting on belongs to
  // that old mount. So the outcome of THIS attempt (its idempotency key) is
  // read from the mutation cache whenever it changes, and once on mount.
  const settledRef = useRef<number | null>(null)
  useEffect(() => {
    const settle = () => {
      const s = ref.current
      const key = s.idempotencyKey
      // busy: finishOrder is in flight and reports its own outcome.
      if (!key || s.savedSale || s.busy) return
      const m = findCheckout(qc, key)
      if (!m || settledRef.current === m.mutationId) return
      const input = m.state.variables as CreateSaleInput | undefined
      if (m.state.status === 'success' && m.state.data && input) {
        settledRef.current = m.mutationId
        const totals = computeTotals(input.items, {
          discount: s.discount,
          amountPaid: input.totals.amount_paid,
          grossOverride: s.grossOverride,
        })
        dispatch({ type: 'PATCH', patch: { error: null, ...savedPatch(m.state.data as Sale, input, s, totals, false) } })
      } else if (m.state.status === 'error' && wasQueued(key)) {
        // Only a QUEUED attempt: an online failure was already reported by
        // finishOrder on the spot.
        settledRef.current = m.mutationId
        dispatch({ type: 'PATCH', patch: { error: checkoutErrorMessage(m.state.error), orderDate: null } })
      }
    }
    settle()
    return qc.getMutationCache().subscribe(settle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc])

  async function finishOrder() {
    const s = ref.current
    if (s.busy) return
    if (!(s.savedSale ? perms.can('pos.edit') || perms.can('history.edit') : perms.can('pos.create'))) { patch({error: t('You do not have access to this action.')}); return }
    if (!s.cartItems.length && !s.examinations.length) {
      patch({ error: 'Cart is empty and no examinations. Cannot checkout.' })
      return
    }
    // When Finish was clicked. A checkout held in the offline queue and
    // replayed later keeps THIS as order_date / paid_at, so it lands in the
    // store day the money was taken, not the day it reached the server. Kept
    // in the draft next to the key so a reload-resume replays the same time.
    const orderDate = s.orderDate ?? new Date().toISOString()
    patch({ busy: true, error: null, orderDate })
    // Idempotency (migration 012): mint this attempt's key once. The ref makes
    // a double-click reuse it before re-render, the draft makes a reload-resume
    // reuse it, and it is cleared only once the sale is safely saved - so a
    // replay returns the SAME sale instead of creating a second one.
    if (!idemRef.current) {
      idemRef.current = newIdempotencyKey()
      patch({ idempotencyKey: idemRef.current })
    }
    const idempotencyKey = idemRef.current
    // `t` is shadowed by the totals inside the try block below.
    const tr = t
    // Already held in the offline queue: pressing Finish again must not queue
    // the same sale a second time.
    if (!s.savedSale && isCheckoutQueued(qc, idempotencyKey)) {
      patch({ busy: false, error: queuedMessage })
      return
    }
    try {
      const cartItems = await addNewFramesFromExams(s.cartItems, s.examinations)
      // Settings sync (lens types / frame colors used by this order) happens
      // HERE at confirmation - typing during the wizard never touches them.
      // Missing frame products are created by addNewFramesFromExams above.
      // It is a convenience, never a reason to refuse (or, offline, to lose)
      // the sale, so a failure is logged and the checkout goes on.
      if (perms.can('inventory.edit')) {
        try {
          await addMissingOrderMetadata(s.examinations)
        } catch (err) {
          console.warn('order metadata sync skipped:', err)
        }
      }
      const t = computeTotals(cartItems, {
        discount: s.discount,
        amountPaid: paymentsTotal(s.payments),
        grossOverride: s.grossOverride,
      })
      // The ledger rows about to be written: clamped so their sum can never
      // exceed the paid amount pricing just computed (sum == amount_paid).
      const payLines = clampPaymentLines(s.payments, t.amountPaid)
      // Re-checkout (030): money going back is recorded from History first, a
      // legacy tender takes no new money, and moving money off a tender needs
      // history.refund. Caught here, before the server refuses it - and
      // offline, where a re-checkout is not queued, this is the only answer.
      if (s.savedSale) {
        const problem = recheckoutProblem({
          saved: s.savedTenders ?? payLines,
          savedAmountPaid: Number(s.savedSale.amount_paid ?? 0),
          next: payLines,
          canRefund: perms.can('history.refund'),
        }, tr)
        if (problem) {
          patch({ busy: false, error: problem, orderDate: null })
          return
        }
      }
      // Stock is guarded INSIDE create_sale_order (migration 012): stores with
      // stores.allow_negative_stock = false get 'insufficient stock: <name>'
      // and no sale. The default keeps this workflow's documented behaviour -
      // record the sale even when qty-on-hand is zero or below, letting
      // inventory go negative on purpose.
      // Order photos: an explicit PC attach wins; otherwise adopt the photos
      // taken on the phone BEFORE checkout (stored under the invoice number),
      // and finally promote a legacy per-exam prescription upload if one exists.
      const legacyRxImage =
        s.examinations.find((e) => (e.image_path ?? '').trim())?.image_path ?? null
      let rxImagePath = s.rxImagePath ?? legacyRxImage
      let frameImagePath = s.frameImagePath
      if (!rxImagePath || !frameImagePath) {
        const found = await findOrderImages(myStoreId ?? '', s.invoiceNo)
        rxImagePath = rxImagePath ?? found.rx ?? null
        frameImagePath = frameImagePath ?? found.frame ?? null
      }
      const payload = {
        items: cartItems,
        examinations: s.examinations.length ? s.examinations : undefined,
        totals: {
          total_amount: t.gross,
          discount: t.discount,
          net_amount: t.net,
          amount_paid: t.amountPaid,
        },
        payments: payLines,
        doctorName: s.doctorName,
        deliveryDate: s.deliveryDate,
        rxImagePath,
        frameImagePath,
      }
      const isUpdate = !!s.savedSale
      if (s.savedSale) {
        // Re-checkout: the SAME invoice is reconciled (items, exams, totals,
        // and stock/ledger deltas - migration 030) instead of duplicated. The
        // amount paid and per-tender split this wizard last saw let the server
        // refuse a stale tender list rather than undo a payment or refund made
        // meanwhile in History.
        const input = {
          saleId: s.savedSale.id,
          invoiceNo: s.savedSale.invoice_no || s.invoiceNo,
          previousHadExams: s.savedHadExams,
          customerId: s.customer?.id ?? null,
          userId: null,
          expectedAmountPaid: Number(s.savedSale.amount_paid ?? 0),
          expectedTenders: s.savedTenders ?? undefined,
          ...payload,
        }
        patch(savedPatch(await updateSale.mutateAsync(input), input, s, t, isUpdate))
        return
      }
      // First checkout: attribute the invoice to the signed-in staff member.
      // Resolution reads the local session, so it works offline too.
      const staffId = await resolveStaffUserId()
      const input: CreateSaleInput = {
        customerId: s.customer?.id ?? null,
        userId: staffId,
        invoiceNo: s.invoiceNo || undefined,
        idempotencyKey,
        orderDate,
        ...payload,
      }
      const applySaved = (sale: Sale) => patch(savedPatch(sale, input, s, t, isUpdate))
      const pending = createSale.mutateAsync(input)
      // Offline queue: a checkout made (or retried) while offline is PAUSED,
      // not rejected, so `pending` does not settle. Race it against the pause
      // and say the true thing - held on this device, not saved yet - but only
      // when the queue really holds THIS sale.
      const queued = whenCheckoutQueued(qc, idempotencyKey)
      let saved: Sale | null
      try {
        saved = await Promise.race([pending, queued.promise.then(() => null)])
      } finally {
        queued.cancel()
      }
      if (saved) {
        applySaved(saved)
        return
      }
      patch({ busy: false, error: queuedMessage })
      // When the queue drains, the watcher above (mutation cache, keyed by
      // this attempt's idempotency key) shows the receipt or the refusal - on
      // this mount or a later one, and never on a wizard that moved on to a
      // newer sale. The checkout journal records it either way.
      pending.catch((err) => console.error('queued checkout failed:', err))
    } catch (e: any) {
      console.error('finishOrder failed:', e)
      // Not queued (a queued checkout never rejects here), so this is a real
      // failure even while offline: nothing is held, and the cashier must know.
      // A rejected attempt wrote nothing (a lost response is answered by the
      // key, whatever the date), so the next Finish takes a fresh time.
      patch({ busy: false, error: checkoutErrorMessage(e), orderDate: null })
    }
  }

  /**
   * Open an EXISTING invoice in the wizard - what the day-navigation buttons
   * (first / previous / next / last customer of the day) call. Everything is
   * fetched BEFORE the wizard is wiped, so a failed load leaves the current
   * order untouched; on success the wizard sits on the order step with
   * savedSale set, so Finish Checkout re-checkouts THIS invoice in place.
   */
  const loadSale = async (saleId: string) => {
    patch({ busy: true, error: null })
    try {
      const { data: sale, error } = await supabase
        .from('sales')
        .select('*')
        .eq('id', saleId)
        .single<Sale>()
      if (error) throw error

      const [
        { data: itemRows, error: itemsErr },
        { data: examRows },
        { data: payRows, error: payErr },
      ] = await Promise.all([
        supabase.from('sale_items').select('*').eq('sale_id', saleId),
        supabase.from('order_examinations').select('*').eq('sale_id', saleId),
        supabase.from('sale_payments').select('method, amount').eq('sale_id', saleId),
      ])
      if (itemsErr) throw itemsErr
      // The tenders are the re-checkout's DESIRED state (030), so a ledger we
      // could not read must not be guessed at (a pre-011 database has no
      // table and falls back below).
      if (payErr && !isMissingPaymentLedger(payErr)) throw payErr

      let cust: Customer | null = null
      if (sale.customer_id) {
        const { data } = await supabase
          .from('customers')
          .select('*')
          .eq('id', sale.customer_id)
          .maybeSingle<Customer>()
        cust = data
      }

      // Line discounts are NOT restored into the cart: sales.discount is the
      // whole discount (line + header, price_cart since 030) and loads as the
      // header discount below. If they are ever restored here, subtract them
      // from sale.discount or they will be counted twice.
      const cartItems: CartLine[] = (itemRows ?? []).map((i) => ({
        product_id: i.product_id,
        name: i.name ?? '',
        qty: i.qty,
        unit_price: Number(i.unit_price ?? 0),
        total_price: Number(i.total_price ?? 0),
      }))
      const itemsTotal = cartItems.reduce((s, i) => s + i.total_price, 0)
      const gross = Number(sale.total_amount ?? 0)

      // Category drives whether the ExamSection is visible. Infer it from the
      // first line's product, but an invoice WITH examinations ALWAYS lands on
      // an exam category (inferLoadedCategory) - prescriptions must never be
      // hidden just because a legacy product row has an odd/unknown category.
      const hasExams = (examRows?.length ?? 0) > 0
      let productCat: string | null = null
      const firstPid = cartItems[0]?.product_id
      if (firstPid) {
        const { data: p } = await supabase
          .from('inventory')
          .select('category')
          .eq('id', firstPid)
          .maybeSingle()
        productCat = p?.category ?? null
      }
      const category = inferLoadedCategory(productCat, hasExams)

      const amountPaid = Number(sale.amount_paid ?? 0)
      const examList: Exam[] = (examRows ?? []).map(
        ({ id: _id, sale_id: _saleId, ...rest }) => rest as Exam,
      )
      // From the ledger, per method, net of refunds - never from
      // payment_method, a display summary like 'Cash + InstaPay' that is not
      // a tender. The single-line fallback is for a ledger-less (pre-011)
      // database only.
      const tenders: PaymentLine[] = payRows?.length
        ? tendersFromLedger(payRows)
        : amountPaid > 0
          ? [{ method: legacyMethodKey(sale.payment_method), amount: amountPaid }]
          : []

      // Saved safely: the next checkout is a NEW attempt (new key).
      idemRef.current = null
      dispatch({ type: 'RESET' })
      patch({
        step: 'cart',
        category,
        customer: cust,
        customerDraft: cust
          ? {
              name: cust.name ?? '',
              phone: cust.phone ?? '',
              city: cust.city ?? '',
              email: cust.email ?? '',
              address: cust.address ?? '',
            }
          : { ...emptyDraft },
        cartItems,
        examinations: examList,
        discount: Number(sale.discount ?? 0),
        grossOverride: gross !== itemsTotal ? gross : null,
        payments: tenders,
        savedTenders: payRows?.length ? tenders : null,
        doctorName: sale.doctor_name ?? '',
        deliveryDate: (sale.delivery_date ?? '').slice(0, 10) || plusDays(3),
        rxImagePath: sale.rx_image_path,
        frameImagePath: sale.frame_image_path,
        invoiceNo: sale.invoice_no,
        savedSale: sale,
        savedHadExams: (examRows?.length ?? 0) > 0,
        completed: null,
        busy: false,
        error: null,
      })
    } catch (e) {
      patch({ busy: false })
      throw e
    }
  }

  // Done closes the receipt but leaves the finished order OPEN on the order
  // tab: every field stays editable and Finish Checkout can be pressed again
  // to update the SAME invoice.
  const closeReceipt = () => patch({ completed: null })
  const startNewSale = () => {
    clearPosDraft()
    idemRef.current = null
    dispatch({ type: 'RESET' })
  }

  const api: POSApi = {
    state,
    totals,
    selectCategory,
    back,
    goToAdditional,
    setCustomerDraft,
    saveCustomerEdits,
    continueWithCustomer,
    addExam,
    updateExam,
    removeExam,
    setDoctorName,
    setDeliveryDate,
    setOrderImage,
    quickAdd,
    addProduct,
    changeQty,
  setLineDiscount,
    removeFromCart,
    setDiscount,
    setPaymentLine,
    removePaymentLine,
    setGross,
    finishOrder,
    closeReceipt,
    startNewSale,
    loadSale,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

// Co-locating the hook with its provider is intentional; the fast-refresh
// rule only matters for files edited during HMR, and this one rarely changes.
// eslint-disable-next-line react-refresh/only-export-components
export function usePOS(): POSApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePOS must be used within <POSProvider>')
  return ctx
}
