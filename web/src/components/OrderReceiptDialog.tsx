import { useMemo } from 'react'
import type { Sale } from '../lib/database.types'
import { useI18n } from '../i18n/LanguageContext'
import { useSettings } from '../data/settings'
import { useCustomer } from '../data/customers'
import { useOrderExaminations } from '../data/examinations'
import type { CompletedOrder } from '../features/pos/POSContext'
import {
  UNIT_CSS,
  buildOrderDocument,
  printOrderDocument,
  renderOrderUnitHTML,
  type Shop,
} from '../features/pos/receipt'

/** Reprint a saved order's printable half-A4 unit (customer | shop over the
 *  lab strip). Used from Lab, History and the customer page. */
export function OrderReceiptDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const { t } = useI18n()
  const settings = useSettings()
  const customer = useCustomer(sale.customer_id ?? null)
  const examsQuery = useOrderExaminations(sale.id)

  const shop: Shop = useMemo(
    () => ({
      name: settings.data?.shop_name ?? 'Optical Shop',
      address: settings.data?.store_address ?? '',
      phone: settings.data?.store_phone ?? '',
      currency: settings.data?.currency ?? 'EGP',
    }),
    [settings.data],
  )

  // Prefer exams embedded on the sale (customer page), else fetch them.
  const exams = useMemo(
    () => sale.order_examinations ?? examsQuery.data ?? [],
    [sale.order_examinations, examsQuery.data],
  )
  const net = Number(sale.net_amount ?? 0)
  const paid = Number(sale.amount_paid ?? 0)

  const order: CompletedOrder = useMemo(
    () => ({
      sale,
      customer: customer.data ?? null,
      cartItems: (sale.sale_items ?? []).map((it) => ({
        product_id: it.product_id,
        name: it.name ?? '',
        qty: it.qty,
        unit_price: Number(it.unit_price ?? 0),
        total_price: Number(it.total_price ?? 0),
      })),
      examinations: exams.map((e) => ({
        exam_type: e.exam_type,
        sphere_od: e.sphere_od,
        cylinder_od: e.cylinder_od,
        axis_od: e.axis_od,
        sphere_os: e.sphere_os,
        cylinder_os: e.cylinder_os,
        axis_os: e.axis_os,
        ipd: e.ipd,
        lens_info: e.lens_info,
        frame_info: e.frame_info,
        frame_color: e.frame_color,
        frame_status: e.frame_status,
        image_path: e.image_path,
      })),
      totals: {
        itemsTotal: Number(sale.total_amount ?? 0),
        gross: Number(sale.total_amount ?? 0),
        discount: Number(sale.discount ?? 0),
        net,
        amountPaid: paid,
        balance: net - paid,
      },
      invoiceNo: sale.invoice_no,
      doctorName: sale.doctor_name ?? '',
      deliveryDate: sale.delivery_date ?? '',
      // Reprint of an already-saved order — not an in-place re-checkout.
      isUpdate: false,
    }),
    [sale, customer.data, exams, net, paid],
  )

  const doc = useMemo(() => buildOrderDocument(order, shop), [order, shop])
  const unitHTML = useMemo(() => renderOrderUnitHTML(doc, shop), [doc, shop])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-center text-lg font-bold text-brand-dark">
          {t('Print')} — <span className="rcpt-num">#</span>
          {sale.invoice_no}
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

        <button
          onClick={onClose}
          className="mt-2 w-full rounded-lg border border-line py-2.5 font-semibold text-muted hover:bg-surface"
        >
          {t('Close')}
        </button>
      </div>
    </div>
  )
}
