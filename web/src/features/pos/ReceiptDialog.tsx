import { useMemo, useState } from 'react'
import { usePOS, type CompletedOrder } from './POSContext'
import { useI18n } from '../../i18n/LanguageContext'
import { useSettings } from '../../data/settings'
import { QrDialog } from '../../components/QrDialog'
import {
  UNIT_CSS,
  buildOrderDocument,
  printOrderDocument,
  renderOrderUnitHTML,
  type Shop,
} from './receipt'

/**
 * Post-checkout dialog. The preview shows the printable half-A4 unit
 * (customer | shop columns over the lab strip); Print outputs exactly that.
 */
export function ReceiptDialog({ order }: { order: CompletedOrder }) {
  const { t } = useI18n()
  // "Done" closes the dialog but KEEPS the order open on the order tab: every
  // field stays editable and pressing Finish Checkout again UPDATES the same
  // invoice. Only "+ New Sale" throws the wizard away and starts fresh.
  const { closeReceipt, startNewSale } = usePOS()
  const settings = useSettings()
  const [qrOpen, setQrOpen] = useState(false)

  const shop: Shop = useMemo(
    () => ({
      name: settings.data?.shop_name ?? 'Optical Shop',
      address: settings.data?.store_address ?? '',
      phone: settings.data?.store_phone ?? '',
      currency: settings.data?.currency ?? 'EGP',
    }),
    [settings.data],
  )

  const doc = useMemo(() => buildOrderDocument(order, shop), [order, shop])
  const unitHTML = useMemo(() => renderOrderUnitHTML(doc, shop), [doc, shop])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 text-center">
          <div className="text-lg font-bold text-success">
            ✓ {order.isUpdate ? t('Order Updated') : t('Order Saved')}
          </div>
          <div className="text-sm text-muted">
            {t('Invoice')} <span className="rcpt-num">#</span>
            {order.invoiceNo} · {t('Print')} → {t('Shop')} / {t('Customer')} / {t('Lab')}
          </div>
        </div>

        {/* Scaled live preview of the printable half-A4 unit (centered) */}
        <div className="mb-3 flex justify-center overflow-hidden rounded-lg border border-line bg-surface p-2">
          <style>{UNIT_CSS}</style>
          <div
            dir="rtl"
            style={{
              zoom: 0.5,
              width: '202mm',
              height: '140.5mm',
              padding: '3mm',
              background: '#fff',
              boxSizing: 'border-box',
            }}
            dangerouslySetInnerHTML={{ __html: unitHTML }}
          />
        </div>

        <button
          onClick={() => printOrderDocument(doc, shop)}
          className="w-full rounded-lg bg-brand py-2.5 font-semibold text-white hover:opacity-95"
        >
          🖨 {t('Print')}
        </button>

        {/* Photos are taken on the phone: QR opens the mobile upload page for
            this exact invoice. */}
        <button
          onClick={() => setQrOpen(true)}
          className="mt-2 w-full rounded-lg border border-line py-2.5 font-semibold text-brand-dark hover:bg-surface"
        >
          📱 {t('Attach from mobile')}
        </button>

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

        {qrOpen && (
          <QrDialog
            url={`${window.location.origin}/m-upload?inv=${encodeURIComponent(order.invoiceNo)}`}
            title={`${t('Invoice')} #${order.invoiceNo}`}
            onClose={() => setQrOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
