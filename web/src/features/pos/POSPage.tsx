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

function POSInner() {
  const { state } = usePOS()
  return (
    <div className="flex min-h-full flex-col">
      <Stepper />
      <div className="flex-1">
        <CurrentStep />
      </div>
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
