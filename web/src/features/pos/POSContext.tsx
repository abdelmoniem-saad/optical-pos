import {
  createContext,
  useContext,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { supabase } from '../../lib/supabase'
import { getNextInvoiceNo, useCreateSale, type CartLine } from '../../data/sales'
import { useAddCustomer } from '../../data/customers'
import type { Customer, Product, Sale } from '../../lib/database.types'
import { addLine, computeTotals, removeLine, setQty, type Totals } from './pricing'
import {
  emptyExam,
  needsExamination,
  type Category,
  type Exam,
  type POSStep,
} from './types'

function plusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export type CompletedOrder = {
  sale: Sale
  customer: Customer | null
  cartItems: CartLine[]
  examinations: Exam[]
  totals: Totals
  invoiceNo: string
  doctorName: string
  deliveryDate: string
}

type State = {
  step: POSStep
  category: Category | null
  customer: Customer | null
  cartItems: CartLine[]
  examinations: Exam[]
  discount: number
  amountPaid: number
  grossOverride: number | null
  doctorName: string
  deliveryDate: string
  invoiceNo: string
  completed: CompletedOrder | null
  busy: boolean
  error: string | null
}

function initialState(): State {
  return {
    step: 'category',
    category: null,
    customer: null,
    cartItems: [],
    examinations: [],
    discount: 0,
    amountPaid: 0,
    grossOverride: null,
    doctorName: '',
    deliveryDate: plusDays(3),
    invoiceNo: '',
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

type POSApi = {
  state: State
  totals: Totals
  // navigation
  selectCategory: (c: Category) => void
  back: () => void
  goToAdditional: () => void
  // customer
  chooseWalkIn: () => Promise<void>
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
  saveExamsAndProceed: () => Promise<void>
  // cart
  quickAdd: (term: string) => Promise<void>
  addProduct: (p: Product) => void
  changeQty: (productId: string, qty: number) => void
  removeFromCart: (productId: string) => void
  clearCart: () => void
  // pricing
  setDiscount: (n: number) => void
  setAmountPaid: (n: number) => void
  setGross: (n: number) => void
  // checkout
  finishOrder: () => Promise<void>
  closeReceiptAndReset: () => void
}

const Ctx = createContext<POSApi | undefined>(undefined)

export function POSProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const ref = useRef(state)
  ref.current = state

  const createSale = useCreateSale()
  const addCustomer = useAddCustomer()

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
      examination: 'customer',
      additional: 'examination',
      cart: needsExamination(s.category) ? 'examination' : 'customer',
    }
    patch({ step: map[s.step] })
  }

  const goToAdditional = () => patch({ step: 'additional' })

  // ---- customer ----
  async function enterAfterCustomer(customer: Customer | null) {
    const invoiceNo = await getNextInvoiceNo()
    patch({
      customer,
      invoiceNo,
      step: needsExamination(ref.current.category) ? 'examination' : 'cart',
    })
  }

  const chooseWalkIn = () => enterAfterCustomer(null)

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
      if (!customer || customer.name !== name) {
        customer = await addCustomer.mutateAsync({
          name,
          phone: form.phone ?? '',
          city: form.city ?? '',
          email: form.email ?? '',
          address: form.address ?? '',
        })
      }
      await enterAfterCustomer(customer)
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : 'Could not save customer' })
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

  /** Find an existing Frame product by name, or create a zero-priced one. */
  async function findOrCreateFrame(name: string): Promise<Product | null> {
    const clean = name.trim()
    if (!clean) return null
    const { data: existing } = await supabase
      .from('inventory')
      .select('*')
      .eq('category', 'Frame')
      .ilike('name', clean)
      .limit(1)
      .returns<Product[]>()
    if (existing && existing.length) return existing[0]
    const { data: created, error } = await supabase
      .from('inventory')
      .insert({ name: clean, category: 'Frame', sale_price: 0, cost_price: 0 })
      .select()
      .single<Product>()
    if (error) throw error
    return created
  }

  async function saveExamsAndProceed() {
    patch({ busy: true, error: null })
    try {
      let cart = [...ref.current.cartItems]
      for (const exam of ref.current.examinations) {
        if (exam.frame_status === 'New' && exam.frame_info) {
          const frame = await findOrCreateFrame(String(exam.frame_info))
          if (frame && !cart.some((i) => i.product_id === frame.id)) {
            cart = addLine(cart, frame)
          }
        }
      }
      patch({ cartItems: cart, step: 'cart' })
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : 'Could not prepare order' })
    } finally {
      patch({ busy: false })
    }
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
  const clearCart = () => patch({ cartItems: [] })

  // ---- pricing ----
  const setDiscount = (n: number) => patch({ discount: Math.max(0, n || 0) })
  const setAmountPaid = (n: number) => patch({ amountPaid: Math.max(0, n || 0) })
  // The gross total is always editable; null means "track the items total".
  const setGross = (n: number) => patch({ grossOverride: Math.max(0, n || 0) })

  /** Sum stock movements for the cart's products; returns shortfall messages. */
  async function checkStock(items: CartLine[]): Promise<string[]> {
    if (!items.length) return []
    const ids = items.map((i) => i.product_id)
    const { data } = await supabase
      .from('stock_movements')
      .select('product_id, qty')
      .in('product_id', ids)
      .returns<{ product_id: string; qty: number }[]>()
    const stock = new Map<string, number>()
    for (const m of data ?? [])
      stock.set(m.product_id, (stock.get(m.product_id) ?? 0) + (m.qty ?? 0))
    const short: string[] = []
    for (const i of items) {
      const have = stock.get(i.product_id) ?? 0
      if (have < i.qty) short.push(`${i.name} (need ${i.qty}, have ${have})`)
    }
    return short
  }

  // ---- checkout ----
  async function finishOrder() {
    const s = ref.current
    const t = computeTotals(s.cartItems, {
      discount: s.discount,
      amountPaid: s.amountPaid,
      grossOverride: s.grossOverride,
    })
    if (!s.cartItems.length && !s.examinations.length) {
      patch({ error: 'Cart is empty and no examinations. Cannot checkout.' })
      return
    }
    patch({ busy: true, error: null })
    try {
      const short = await checkStock(s.cartItems)
      if (short.length) {
        patch({ busy: false, error: 'Insufficient stock for:\n' + short.join('\n') })
        return
      }
      const sale = await createSale.mutateAsync({
        // sales.user_id has a FK to the legacy public.users table, which does
        // NOT contain Supabase Auth UUIDs — passing one fails the insert. Leave
        // it null until cashier identity is migrated to auth (see follow-up).
        customerId: s.customer?.id ?? null,
        userId: null,
        invoiceNo: s.invoiceNo || undefined,
        items: s.cartItems,
        examinations: s.examinations.length ? s.examinations : undefined,
        totals: {
          total_amount: t.gross,
          discount: t.discount,
          net_amount: t.net,
          amount_paid: t.amountPaid,
        },
        doctorName: s.doctorName,
      })
      patch({
        busy: false,
        completed: {
          sale,
          customer: s.customer,
          cartItems: s.cartItems,
          examinations: s.examinations,
          totals: t,
          invoiceNo: sale.invoice_no || s.invoiceNo,
          doctorName: s.doctorName,
          deliveryDate: s.deliveryDate,
        },
      })
    } catch (e) {
      patch({ busy: false, error: e instanceof Error ? e.message : 'Error saving order' })
    }
  }

  const closeReceiptAndReset = () => dispatch({ type: 'RESET' })

  const api: POSApi = {
    state,
    totals,
    selectCategory,
    back,
    goToAdditional,
    chooseWalkIn,
    continueWithCustomer,
    addExam,
    updateExam,
    removeExam,
    setDoctorName,
    setDeliveryDate,
    saveExamsAndProceed,
    quickAdd,
    addProduct,
    changeQty,
    removeFromCart,
    clearCart,
    setDiscount,
    setAmountPaid,
    setGross,
    finishOrder,
    closeReceiptAndReset,
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
