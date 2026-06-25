import { POSProvider, usePOS } from './POSContext'
import { needsExamination, type POSStep } from './types'
import { CategoryStep } from './steps/CategoryStep'
import { CustomerStep } from './steps/CustomerStep'
import { ExaminationStep } from './steps/ExaminationStep'
import { AdditionalItemsStep } from './steps/AdditionalItemsStep'
import { CartStep } from './steps/CartStep'
import { ReceiptDialog } from './ReceiptDialog'

const labels: Record<POSStep, string> = {
  category: 'Category',
  customer: 'Customer',
  examination: 'Exam',
  additional: 'Items',
  cart: 'Payment',
}

function Stepper() {
  const { state } = usePOS()
  const flow: POSStep[] = needsExamination(state.category)
    ? ['category', 'customer', 'examination', 'cart']
    : ['category', 'customer', 'cart']
  const currentIdx = flow.indexOf(state.step === 'additional' ? 'examination' : state.step)

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
            {labels[s]}
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
    case 'examination':
      return <ExaminationStep />
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
