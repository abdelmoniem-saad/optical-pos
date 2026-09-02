import { POSProvider, usePOS } from './POSContext'
import { useI18n } from '../../i18n/LanguageContext'
import { needsExamination, type POSStep } from './types'
import { CategoryStep } from './steps/CategoryStep'
import { CustomerStep } from './steps/CustomerStep'
import { AdditionalItemsStep } from './steps/AdditionalItemsStep'
import { CartStep } from './steps/CartStep'
import { ReceiptDialog } from './ReceiptDialog'

const labelKey: Record<POSStep, string> = {
  category: 'Category',
  customer: 'Customer',
  additional: 'Items',
  cart: 'Order',
}

function Stepper() {
  const { t } = useI18n()
  const { state } = usePOS()
  const flow: POSStep[] = ['category', 'customer', 'cart']
  const currentIdx = flow.indexOf(state.step === 'additional' ? 'cart' : state.step)
  const orderLabel = needsExamination(state.category) ? 'Order' : 'Payment'

  return (
    <div className="flex items-center justify-center gap-2 border-b border-line/40 bg-white px-4 py-3 text-sm">
      {flow.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 font-medium ${
              i === currentIdx
                ? 'bg-brand text-white'
                : i < currentIdx
                  ? 'bg-brand-bg text-brand-dark'
                  : 'bg-surface text-faint'
            }`}
          >
            {t(s === 'cart' ? orderLabel : labelKey[s])}
          </span>
          {i < flow.length - 1 && <span className="text-faint">›</span>}
        </div>
      ))}
    </div>
  )
}

function CurrentStep() {
  const { state } = usePOS()
  switch (state.step) {
    case 'category':
      return <CategoryStep />
    case 'customer':
      return <CustomerStep />
    case 'additional':
      return <AdditionalItemsStep />
    case 'cart':
      return <CartStep />
  }
}

/** Corner escape hatch: abandon the in-progress order and restart the wizard
 *  at the category screen - for when a new customer walks in mid-order.
 *  Hidden while the wizard is pristine; asks before discarding progress. */
function RestartButton() {
  const { t } = useI18n()
  const { state, startNewSale } = usePOS()
  const s = state
  // An auto-added empty exam row doesn't count as progress on its own.
  const dirty =
    s.step !== 'category' ||
    !!s.customer ||
    s.customerDraft.name.trim() !== '' ||
    s.cartItems.length > 0 ||
    s.examinations.some((e) =>
      Boolean(
        e.sphere_od ||
          e.cylinder_od ||
          e.axis_od ||
          e.sphere_os ||
          e.cylinder_os ||
          e.axis_os ||
          e.ipd ||
          e.lens_info ||
          e.frame_info ||
          e.frame_color ||
          e.image_path,
      ),
    ) ||
    s.doctorName.trim() !== '' ||
    s.discount > 0 ||
    s.amountPaid > 0 ||
    s.grossOverride !== null ||
    !!s.savedSale ||
    !!s.completed

  if (!dirty) return null

  return (
    <button
      onClick={() => {
        if (window.confirm(t('Discard the current order and start a new sale?'))) {
          startNewSale()
        }
      }}
      title={t('New Sale')}
      className="fixed bottom-4 end-4 z-40 rounded-full border border-line bg-white px-4 py-2.5 text-sm font-semibold text-danger shadow-lg transition hover:bg-surface"
    >
      ↺ {t('New Sale')}
    </button>
  )
}

function POSInner() {
  const { state } = usePOS()
  return (
    <div className="flex min-h-full flex-col">
      {/* The site-wide 1.25× scale now lives on <html> (index.css), so no local
          zoom here - it would compound into 1.56×. */}
      <Stepper />
      <div className="flex-1">
        <CurrentStep />
      </div>
      <RestartButton />
      {state.completed && <ReceiptDialog order={state.completed} />}
    </div>
  )
}

export function POSPage() {
  return (
    <POSProvider>
      <POSInner />
    </POSProvider>
  )
}
