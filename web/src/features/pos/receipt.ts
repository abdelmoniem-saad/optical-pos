import type { CompletedOrder } from './POSContext'

export type Shop = { name: string; address: string; phone: string; currency: string }

// The receipt body is ALWAYS printed in Arabic, regardless of the app language.
// Optical abbreviations (SPH/CYL/AXIS/OD/OS/IPD) stay as universal notation.

const W = 44

const repeat = (ch: string) => ch.repeat(W)

function center(text: string): string {
  const t = text.length > W ? text.slice(0, W) : text
  const pad = W - t.length
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + t + ' '.repeat(pad - left)
}

/** "value  ...........القيمة" — label padded with a dot-leader to labelWidth. */
function labelRow(label: string, value: string, labelWidth = 30): string {
  const l = (label + ' ').padEnd(labelWidth, '.')
  return `${l} ${value.padStart(10)}`
}

function now(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
}

function header(title: string, shop: Shop): string[] {
  return [
    repeat('='),
    center(title),
    repeat('='),
    center(shop.name),
    shop.address ? center(shop.address) : '',
    shop.phone ? center(shop.phone) : '',
    repeat('='),
  ]
}

function totalsBlock(o: CompletedOrder, shop: Shop): string[] {
  const c = shop.currency
  const t = o.totals
  return [
    repeat('-'),
    labelRow('الإجمالي', `${t.gross.toFixed(2)} ${c}`),
    labelRow('الخصم', `${t.discount.toFixed(2)} ${c}`),
    labelRow('الصافي', `${t.net.toFixed(2)} ${c}`),
    labelRow('المدفوع', `${t.amountPaid.toFixed(2)} ${c}`),
    labelRow('المتبقي', `${t.balance.toFixed(2)} ${c}`),
    repeat('='),
  ]
}

function customerName(o: CompletedOrder): string {
  return o.customer?.name ?? 'عميل عابر'
}

export function buildShopCopy(o: CompletedOrder, shop: Shop): string {
  const lines = [
    ...header('نسخة المحل', shop),
    `فاتورة: #${o.invoiceNo}`,
    `التاريخ: ${now()}`,
    `تاريخ التسليم: ${fmtDate(o.deliveryDate)}`,
    repeat('-'),
    `العميل: ${customerName(o)}`,
    o.customer?.phone ? `الهاتف: ${o.customer.phone}` : '',
    o.doctorName ? `الطبيب: ${o.doctorName}` : '',
    repeat('-'),
  ]
  if (o.cartItems.length) {
    lines.push('الأصناف:')
    for (const i of o.cartItems) {
      lines.push(`  ${i.name.slice(0, 28).padEnd(28)} x${i.qty} ${i.total_price.toFixed(2).padStart(8)}`)
    }
  }
  if (o.examinations.length) {
    lines.push(repeat('-'), 'الفحوصات:')
    o.examinations.forEach((e, idx) => {
      lines.push(`  [${idx + 1}] ${e.exam_type ?? '—'}`)
      lines.push(`      OD: ${e.sphere_od || '-'}/${e.cylinder_od || '-'}x${e.axis_od || '-'}`)
      lines.push(`      OS: ${e.sphere_os || '-'}/${e.cylinder_os || '-'}x${e.axis_os || '-'}`)
      lines.push(`      IPD: ${e.ipd || '-'}`)
      lines.push(`      العدسة: ${e.lens_info || '-'}`)
      lines.push(`      الإطار: ${e.frame_info || '-'} (${e.frame_color || '-'})`)
    })
  }
  lines.push(...totalsBlock(o, shop))
  return lines.filter(Boolean).join('\n')
}

export function buildCustomerCopy(o: CompletedOrder, shop: Shop): string {
  const lines = [
    ...header('نسخة العميل', shop),
    `فاتورة: #${o.invoiceNo}`,
    `التاريخ: ${now()}`,
    `تاريخ التسليم: ${fmtDate(o.deliveryDate)}`,
    repeat('-'),
    `العميل: ${customerName(o)}`,
    o.customer?.phone ? `الهاتف: ${o.customer.phone}` : '',
    repeat('-'),
  ]
  if (o.cartItems.length) {
    lines.push('الأصناف:')
    for (const i of o.cartItems) {
      lines.push(`  ${i.name.slice(0, 28).padEnd(28)} x${i.qty} ${i.total_price.toFixed(2).padStart(8)}`)
    }
  }
  lines.push(...totalsBlock(o, shop), center('شكراً لتسوقكم معنا'), repeat('='))
  return lines.filter(Boolean).join('\n')
}

export function buildLabCopy(o: CompletedOrder, shop: Shop): string {
  const lines = [
    ...header('نسخة المعمل', shop),
    `فاتورة: #${o.invoiceNo}`,
    `التاريخ: ${fmtDate(new Date().toISOString())}`,
    `تاريخ التسليم: ${fmtDate(o.deliveryDate)}`,
    o.doctorName ? `الطبيب: ${o.doctorName}` : '',
    repeat('='),
  ]
  if (o.examinations.length) {
    o.examinations.forEach((e, idx) => {
      lines.push(repeat('-'), `فحص #${idx + 1}: ${e.exam_type ?? '—'}`, repeat('='))
      lines.push('  العين اليمنى (OD)')
      lines.push(`    SPH: ${String(e.sphere_od || '-').padStart(8)}`)
      lines.push(`    CYL: ${String(e.cylinder_od || '-').padStart(8)}`)
      lines.push(`    AXIS: ${String(e.axis_od || '-').padStart(7)}`)
      lines.push('  العين اليسرى (OS)')
      lines.push(`    SPH: ${String(e.sphere_os || '-').padStart(8)}`)
      lines.push(`    CYL: ${String(e.cylinder_os || '-').padStart(8)}`)
      lines.push(`    AXIS: ${String(e.axis_os || '-').padStart(7)}`)
      lines.push(`  IPD: ${e.ipd || '-'}`)
      lines.push(repeat('-'))
      lines.push(`  نوع العدسة: ${e.lens_info || '-'}`)
      lines.push(`  الإطار: ${e.frame_info || '-'}`)
      lines.push(`  اللون: ${e.frame_color || '-'}`)
      lines.push(`  حالة الإطار: ${e.frame_status || '-'}`)
    })
  } else {
    lines.push('لا توجد بيانات فحص')
  }
  lines.push(repeat('='))
  return lines.filter(Boolean).join('\n')
}

/** Open a print window with one or more monospace receipts and trigger print.
 *  This is the browser equivalent of (and an upgrade over) the Flet app's
 *  console print() — it routes to any installed/thermal printer via the OS. */
export function printReceipts(copies: string[]) {
  const win = window.open('', '_blank', 'width=380,height=640')
  if (!win) return
  const body = copies
    .map((c) => `<pre>${c.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)}</pre>`)
    .join('<div style="page-break-after:always"></div>')
  win.document.write(`<!doctype html><html><head><title>Receipt</title>
    <style>
      @page { margin: 6mm; }
      body { margin: 0; }
      pre { font-family: "Courier New", monospace; font-size: 11px; line-height: 1.25;
            white-space: pre; margin: 0 0 8mm; }
    </style></head><body>${body}</body></html>`)
  win.document.close()
  win.focus()
  win.print()
}
