import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  getNextInvoiceNo,
  useCreateSale,
  useUpdateSaleFull,
  type CartLine,
} from '../../data/sales'
import { useAddCustomer, useUpdateCustomer } from '../../data/customers'
import { getRepo } from '../../lib/repository'
import { useAuth } from '../../lib/auth'
import { findOrderImages } from '../../lib/storage'
import { loadWizard, saveWizard } from './wizardStore'
import { useStoreId } from '../../lib/licensing'
import type { Customer, CustomerInsert, Product, Sale } from '../../lib/database.types'
import { addLine, computeTotals, removeLine, setQty, type Totals } from './pricing'
import {
  emptyExam,
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
  amountPaid: number
  grossOverride: number | null
  doctorName: string
  deliveryDate: string
  // Order photo slots (migration 007).
  rxImagePath: string | null
  frameImagePath: string | null
  invoiceNo: string
  /** When invoiceNo was handed out (ms): older phone photos under the same
   *  number belong to an abandoned order and are never attached. */
  invoiceAssignedAt: number | null
  /** Sale created by the FIRST Finish Checkout; later checkouts update it. */
  savedSale: Sale | null
  savedHadExams: boolean
  /** Invoice of a first checkout that was sent but not yet confirmed (a
   *  reload in that moment must not create the same sale twice). */
  pendingInvoice: string | null
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
    amountPaid: 0,
    grossOverride: null,
    doctorName: '',
    deliveryDate: plusDays(3),
    rxImagePath: null,
    frameImagePath: null,
    invoiceNo: '',
    invoiceAssignedAt: null,
    savedSale: null,
    savedHadExams: false,
    pendingInvoice: null,
    completed: null,
    busy: false,
    error: null,
  }
}

type Action = { type: 'PATCH'; patch: Partial<State> } | { type: 'RESET' }

function reducer(state: State, action: Action): State {
  if (action.type === 'RESET') return initialState()
  return { ...state, ...action.patch }
}

// The New Sale wizard intentionally SURVIVES tab switches AND page reloads
// (a crash/power cut mid-sale must not lose the order being typed): the latest
// state is mirrored into a module-level snapshot plus localStorage (see
// wizardStore.ts - tagged with the signed-in staff member, cleared on sign-out)
// and re-hydrated when the tab is opened again. Every other screen reloads
// fresh by design; only this wizard continues where it left off.
// "startNewSale" (receipt dialog) is the explicit way to reset.
function restore(owner: string | null): State | null {
  const saved = loadWizard<Partial<State>>(owner)
  if (!saved) return null
  // Transient UI flags never survive a reload or a tab switch.
  return { ...initialState(), ...saved, busy: false, error: null, completed: null }
}

function persist(owner: string | null, state: State): void {
  const empty =
    state.step === 'category' && !state.customer && !state.cartItems.length && !state.examinations.length
  const { busy: _b, error: _e, completed: _c, ...rest } = state
  void _b
  void _e
  void _c
  saveWizard(owner, state, rest, empty)
}

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
  removeFromCart: (productId: string) => void
  // pricing
  setDiscount: (n: number) => void
  setAmountPaid: (n: number) => void
  setGross: (n: number) => void
  // checkout
  finishOrder: () => Promise<void>
  /** Close the receipt dialog but KEEP the order open for further edits. */
  closeReceipt: () => void
  /** Throw the whole wizard away and start a brand-new sale. */
  startNewSale: () => void
}

const Ctx = createContext<POSApi | undefined>(undefined)

export function POSProvider({ children }: { children: ReactNode }) {
  const owner = useAuth().user?.id ?? null
  const [state, dispatch] = useReducer(reducer, undefined, () => restore(owner) ?? initialState())
  const ref = useRef(state)
  ref.current = state
  const qc = useQueryClient()

  // Mirror every change into the snapshot (tab switches) and storage (reloads).
  useEffect(() => {
    persist(owner, state)
  }, [owner, state])

  // A reload while a first checkout was in flight: if that sale was saved,
  // continue editing IT instead of creating a duplicate under a new number.
  useEffect(() => {
    if (ref.current.pendingInvoice && !ref.current.savedSale) void recoverPendingCheckout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createSale = useCreateSale()
  const updateSale = useUpdateSaleFull()
  const addCustomer = useAddCustomer()
  const updateCustomer = useUpdateCustomer()
  const { data: myStoreId } = useStoreId()

  const patch = (p: Partial<State>) => dispatch({ type: 'PATCH', patch: p })
  const totals = computeTotals(state.cartItems, {
    discount: state.discount,
    amountPaid: state.amountPaid,
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
    if (!c) return
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
        const existing = await getRepo().getSaleByInvoiceNo(invoiceNo)
        if (existing) {
          invoiceNo = ''
        }
      } catch {
        // ignore check error
      }
    }
    if (!invoiceNo) {
      invoiceNo = await getNextInvoiceNo()
      patch({ invoiceAssignedAt: Date.now() })
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
        if (Object.keys(changes).length) {
          await updateCustomer.mutateAsync({ id: customer.id, patch: changes })
          customer = { ...customer, ...form } as Customer
        }
      } else {
        // Different/edited name → treat as a new customer (existing behaviour).
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
    return getRepo().ensureFrameProduct(name)
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
    const product = await getRepo().findProductBySkuOrName(t)
    if (!product) {
      patch({ error: `Product not found: ${t}` })
      return
    }
    patch({ cartItems: addLine(ref.current.cartItems, product), error: null })
  }

  const addProduct = (p: Product) =>
    patch({ cartItems: addLine(ref.current.cartItems, p) })
  const changeQty = (productId: string, qty: number) =>
    patch({ cartItems: setQty(ref.current.cartItems, productId, qty) })
  const removeFromCart = (productId: string) =>
    patch({ cartItems: removeLine(ref.current.cartItems, productId) })

  // ---- pricing ----
  const setDiscount = (n: number) => patch({ discount: Math.max(0, n || 0) })
  const setAmountPaid = (n: number) => patch({ amountPaid: Math.max(0, n || 0) })
  // The gross total is always editable; null means "track the items total".
  const setGross = (n: number) => patch({ grossOverride: Math.max(0, n || 0) })

  // ---- checkout ----

  /** Returns false when checkout must not continue (the cashier is told why). */
  async function recoverPendingCheckout(): Promise<boolean> {
    const s = ref.current
    if (!s.pendingInvoice || s.savedSale) return true
    let existing: Sale | null = null
    try {
      existing = await getRepo().getSaleByInvoiceNo(s.pendingInvoice)
    } catch {
      patch({ error: `Could not check whether invoice ${s.pendingInvoice} was already saved. Check History before finishing again.` })
      return false
    }
    if (!existing) {
      patch({ pendingInvoice: null })
      return true
    }
    if ((existing.customer_id ?? null) === (s.customer?.id ?? null)) {
      patch({
        savedSale: existing,
        savedHadExams: s.examinations.length > 0,
        invoiceNo: existing.invoice_no,
        pendingInvoice: null,
        rxImagePath: s.rxImagePath ?? existing.rx_image_path ?? null,
        frameImagePath: s.frameImagePath ?? existing.frame_image_path ?? null,
      })
      return true
    }
    patch({ pendingInvoice: null })
    return true
  }

  async function finishOrder() {
    if (!(await recoverPendingCheckout())) return
    const s = ref.current
    if (!s.cartItems.length && !s.examinations.length) {
      patch({ error: 'Cart is empty and no examinations. Cannot checkout.' })
      return
    }
    patch({ busy: true, error: null, pendingInvoice: s.savedSale ? null : s.invoiceNo || null })
    try {
      const cartItems = await addNewFramesFromExams(s.cartItems, s.examinations)
      // Settings sync (lens types / frame colors used by this order) happens
      // HERE at confirmation - typing during the wizard never touches them.
      // Missing frame products are created by addNewFramesFromExams above.
      await getRepo().addMissingOrderMetadata(s.examinations)
      qc.invalidateQueries({ queryKey: ['lens_types'] })
      qc.invalidateQueries({ queryKey: ['frame_colors'] })
      const t = computeTotals(cartItems, {
        discount: s.discount,
        amountPaid: s.amountPaid,
        grossOverride: s.grossOverride,
      })
      // Allow overselling: stock movements will make inventory go negative,
      // which is intentional per the workflow (record the sale even when
      // qty-on-hand is zero or below).
      // Order photos: an explicit PC attach wins; otherwise adopt the photos
      // taken on the phone BEFORE checkout (stored under the invoice number),
      // and finally promote a legacy per-exam prescription upload if one exists.
      const legacyRxImage =
        s.examinations.find((e) => (e.image_path ?? '').trim())?.image_path ?? null
      let rxImagePath = s.rxImagePath ?? legacyRxImage
      let frameImagePath = s.frameImagePath
      if (!rxImagePath || !frameImagePath) {
        // Photo names carry the phone's clock: allow 30 minutes of drift.
        const since = s.invoiceAssignedAt ? s.invoiceAssignedAt - 30 * 60_000 : 0
        const found = await findOrderImages(myStoreId ?? '', s.invoiceNo, since)
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
        doctorName: s.doctorName,
        deliveryDate: s.deliveryDate,
        rxImagePath,
        frameImagePath,
      }
      const isUpdate = !!s.savedSale
      let sale: Sale
      if (s.savedSale) {
        // Re-checkout: overwrite the SAME invoice (items, exams, totals and
        // stock movements) instead of creating a duplicate one.
        sale = await updateSale.mutateAsync({
          saleId: s.savedSale.id,
          invoiceNo: s.savedSale.invoice_no || s.invoiceNo,
          previousHadExams: s.savedHadExams,
          customerId: s.customer?.id ?? null,
          userId: null,
          ...payload,
        })
      } else {
        // First checkout: attribute the invoice to the signed-in staff member.
        // Resolution understands BOTH auth-keyed users rows and legacy rows
        // linked by username (databases migrated from the desktop version).
        const staffId = await getRepo().resolveStaffUserId()
        sale = await createSale.mutateAsync({
          customerId: s.customer?.id ?? null,
          userId: staffId,
          invoiceNo: s.invoiceNo || undefined,
          ...payload,
        })
      }
      patch({
        busy: false,
        pendingInvoice: null,
        invoiceNo: sale.invoice_no || s.invoiceNo,
        savedSale: sale,
        savedHadExams: s.examinations.length > 0,
        // Show (and lock) the photos the sale actually carries now.
        rxImagePath: sale.rx_image_path ?? rxImagePath ?? null,
        frameImagePath: sale.frame_image_path ?? frameImagePath ?? null,
        completed: {
          sale,
          customer: s.customer,
          cartItems,
          examinations: s.examinations,
          totals: t,
          invoiceNo: sale.invoice_no || s.invoiceNo,
          doctorName: s.doctorName,
          deliveryDate: s.deliveryDate,
          isUpdate,
        },
      })
    } catch (e: any) {
      console.error('finishOrder failed:', e)
      const msg =
        e?.message ||
        e?.error_description ||
        e?.details ||
        (typeof e === 'string' ? e : 'Error saving order')
      // The request failed, so nothing was saved under the pending number -
      // unless the response was lost; recoverPendingCheckout() checks that.
      patch({ busy: false, error: msg })
    }
  }

  // Done closes the receipt but leaves the finished order OPEN on the order
  // tab: every field stays editable and Finish Checkout can be pressed again
  // to update the SAME invoice.
  const closeReceipt = () => patch({ completed: null })
  const startNewSale = () => dispatch({ type: 'RESET' })

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
    removeFromCart,
    setDiscount,
    setAmountPaid,
    setGross,
    finishOrder,
    closeReceipt,
    startNewSale,
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
