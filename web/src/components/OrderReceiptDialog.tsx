import { useState } from 'react'
import type { Sale } from '../lib/database.types'
import { useI18n } from '../i18n/LanguageContext'
import { useSettings } from '../data/settings'
import { useCustomer } from '../data/customers'
import { useOrderExaminations } from '../data/examinations'
import type { CompletedOrder } from '../features/pos/POSContext'
import {
  buildCustomerCopy,
  buildLabCopy,
  buildShopCopy,
  printReceipts,
  type Shop,
} from '../features/pos/receipt'

type CopyKey = 'shop' | 'customer' | 'lab'

/** Reprint a saved order's receipt (shop / customer / lab copies) — the same
 *  output produced at checkout. Used from Lab, History and the customer page. */
export function OrderReceiptDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const { t } = useI18n()
  const settings = useSettings()
  const customer = useCustomer(sale.customer_id ?? null)
  const examsQuery = useOrderExaminations(sale.id)
  const [copy, setCopy] = useState<CopyKey>('shop')

  const shop: Shop = {
    name: settings.data?.shop_name ?? 'Optical Shop',
    address: settings.data?.store_address ?? '',
    phone: settings.data?.store_phone ?? '',
    currency: settings.data?.currency ?? 'EGP',
  }

  // Prefer exams embedded on the sale (customer page), else fetch them.
  const exams = sale.order_examinations ?? examsQuery.data ?? []
  const net = Number(sale.net_amount ?? 0)
  const paid = Number(sale.amount_paid ?? 0)

  const order: CompletedOrder = {
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 text-center">
          <div className="text-lg font-bold text-brand-dark">{t('Print')} — #{sale.invoice_no}</div>
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
          <button onClick={() => printReceipts([builders[copy]])} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-surface">
            {t('Print')}
          </button>
          <button onClick={() => printReceipts([builders.shop, builders.customer, builders.lab])} className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white">
            {t('Print all 3')}
          </button>
        </div>

        <button onClick={onClose} className="mt-2 w-full rounded-lg border border-line py-2.5 font-semibold text-muted hover:bg-surface">
          {t('Close')}
        </button>
      </div>
    </div>
  )
}
