import { POSProvider, usePOS } from './POSContext'
import { useI18n } from '../../i18n/LanguageContext'
import { useConfirm, useToast } from '../../components/Feedback'
import { useTodaySales } from '../../data/sales'
import { paymentsTotal } from '../../lib/payments'
import { CategoryStep } from './steps/CategoryStep'
import { CustomerStep } from './steps/CustomerStep'
import { AdditionalItemsStep } from './steps/AdditionalItemsStep'
import { CartStep } from './steps/CartStep'
import { ReceiptDialog } from './ReceiptDialog'

/** True when the wizard holds work that New Sale / invoice switching would
 *  destroy. An auto-added empty exam row doesn't count as progress alone. */
function orderDirty(s: ReturnType<typeof usePOS>['state']) {
  return (
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
    paymentsTotal(s.payments) > 0 ||
    s.grossOverride !== null ||
    !!s.savedSale ||
    !!s.completed
  )
}

/**
 * Top bar - replaces the old "Category -> Customer -> Order" stepper, which
 * only echoed where the wizard already was. Instead: day navigation across
 * today's invoices (first / previous / next / last customer of the day) plus
 * the New Sale escape hatch, all within reach at the top of the screen.
 */
function TopBar() {
  const { t } = useI18n()
  const { state, loadSale } = usePOS()
  const confirm = useConfirm()
  const notify = useToast()
  const list = useTodaySales().data ?? []
  const currentId = state.savedSale?.id ?? null
  const idx = currentId ? list.findIndex((s) => s.id === currentId) : -1

  async function open(id: string) {
    if (state.busy || id === currentId) return
    if (
      orderDirty(state) &&
      !(await confirm(t('Discard the current order and open another invoice?')))
    ) {
      return
    }
    try {
      await loadSale(id)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }

  const btn =
    'rounded-lg border border-line px-2 py-1.5 text-sm text-muted transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40'
  const nav = (icon: string, label: string, disabled: boolean, go: () => void) => (
    <button
      type="button"
      onClick={go}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={btn}
    >
      {icon}
    </button>
  )

  return (
    <div className="flex items-center justify-between gap-2 border-b border-line/40 bg-white px-3 py-2 text-sm">
      <div className="flex items-center gap-1">
        {nav('⏮', t('First customer of the day'), list.length === 0 || idx === 0, () => {
          const s = list[0]
          if (s) void open(s.id)
        })}
        {nav('◀', t('Previous customer'), idx <= 0, () => {
          const s = list[idx - 1]
          if (s) void open(s.id)
        })}
        {list.length > 0 && (
          <span className="px-1 text-xs tabular-nums text-faint">
            {idx >= 0 ? idx + 1 : '–'}/{list.length}
          </span>
        )}
        {nav('▶', t('Next customer'), idx < 0 || idx >= list.length - 1, () => {
          const s = list[idx + 1]
          if (s) void open(s.id)
        })}
        {nav('⏭', t('Last customer of the day'), list.length === 0 || idx === list.length - 1, () => {
          const s = list[list.length - 1]
          if (s) void open(s.id)
        })}
      </div>
      <RestartButton />
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

/** New Sale - parked in the top bar (was the screen corner). Hidden while
 *  the wizard is pristine; asks before discarding progress. */
function RestartButton() {
  const { t } = useI18n()
  const { state, startNewSale } = usePOS()
  const confirm = useConfirm()

  if (!orderDirty(state)) return null

  return (
    <button
      onClick={async () => {
        if (await confirm(t('Discard the current order and start a new sale?'))) {
          startNewSale()
        }
      }}
      title={t('New Sale')}
      className="rounded-lg border border-danger/40 bg-white px-3 py-1.5 text-xs font-semibold text-danger transition hover:bg-surface"
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
      <TopBar />
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
