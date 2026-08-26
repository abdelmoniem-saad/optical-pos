import { useState } from 'react'
import { usePOS, type CompletedOrder } from './POSContext'
import { useI18n } from '../../i18n/LanguageContext'
import { useSettings } from '../../data/settings'
import {
  buildCustomerCopy,
  buildLabCopy,
  buildShopCopy,
  printReceipts,
  type Shop,
} from './receipt'

type CopyKey = 'shop' | 'customer' | 'lab'

export function ReceiptDialog({ order }: { order: CompletedOrder }) {
  const { t } = useI18n()
  // "Done" closes the dialog but KEEPS the order open on the order tab: every
  // field stays editable and pressing Finish Checkout again UPDATES the same
  // invoice. Only "+ New Sale" throws the wizard away and starts fresh.
  const { closeReceipt, startNewSale } = usePOS()
  const settings = useSettings()
  const [copy, setCopy] = useState<CopyKey>('shop')

  const shop: Shop = {
    name: settings.data?.shop_name ?? 'Optical Shop',
    address: settings.data?.store_address ?? '',
    phone: settings.data?.store_phone ?? '',
    currency: settings.data?.currency ?? 'EGP',
  }

  const builders: Record<CopyKey, string> = {
    shop: buildShopCopy(order, shop),
    customer: buildCustomerCopy(order, shop),
    lab: buildLabCopy(order, shop),
  }

  const tab = (k: CopyKey, label: string) => (
    <button
      onClick={() => setCopy(k)}
      className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
        copy === k ? 'bg-brand text-white' : 'bg-surface text-muted'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 text-center">
          <div className="text-lg font-bold text-success">
            ✓ {order.isUpdate ? t('Order Updated') : t('Order Saved')}
          </div>
          <div className="text-sm text-muted">{t('Invoice')} #{order.invoiceNo}</div>
        </div>

        <div className="mb-3 flex justify-center gap-2">
          {tab('shop', t('Shop'))}
          {tab('customer', t('Customer'))}
          {tab('lab', t('Lab'))}
        </div>

        <pre dir="ltr" className="mb-3 max-h-72 overflow-auto rounded-lg border border-line bg-surface p-3 text-start font-mono text-[11px] leading-tight">
          {builders[copy]}
        </pre>

        <div className="mb-2 flex justify-center gap-2">
          <button
            onClick={() => printReceipts([builders[copy]])}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-surface"
          >
            {t('Print')}
          </button>
          <button
            onClick={() => printReceipts([builders.shop, builders.customer, builders.lab])}
            className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white"
          >
            {t('Print all 3')}
          </button>
        </div>

        <button
          onClick={closeReceipt}
          className="mt-2 w-full rounded-lg bg-success py-2.5 font-semibold text-white"
        >
          {t('Done')}
        </button>
        <button
          onClick={startNewSale}
          className="mt-2 w-full rounded-lg border border-line py-2.5 font-semibold text-muted hover:bg-surface"
        >
          + {t('New Sale')}
        </button>
      </div>
    </div>
  )
}
