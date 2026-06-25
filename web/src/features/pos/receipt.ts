import type { CompletedOrder } from './POSContext'

export type Shop = { name: string; address: string; phone: string; currency: string }

const W = 44

const repeat = (ch: string) => ch.repeat(W)

function center(text: string): string {
  const t = text.length > W ? text.slice(0, W) : text
  const pad = W - t.length
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + t + ' '.repeat(pad - left)
}

/** "Label...........  value" with a label dot-leader of `labelWidth`. */
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
  if (!iso) return 'N/A'
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
    labelRow('Gross Total', `${t.gross.toFixed(2)} ${c}`),
    labelRow('Discount', `${t.discount.toFixed(2)} ${c}`),
    labelRow('Net Amount', `${t.net.toFixed(2)} ${c}`),
    labelRow('Amount Paid', `${t.amountPaid.toFixed(2)} ${c}`),
    labelRow('Balance', `${t.balance.toFixed(2)} ${c}`),
    repeat('='),
  ]
}

function customerName(o: CompletedOrder): string {
  return o.customer?.name ?? 'Walk-in'
}

export function buildShopCopy(o: CompletedOrder, shop: Shop): string {
  const lines = [
    ...header('SHOP COPY', shop),
    `Invoice: #${o.invoiceNo}`,
    `Date: ${now()}`,
    `Delivery Date: ${fmtDate(o.deliveryDate)}`,
    repeat('-'),
    `Customer: ${customerName(o)}`,
    o.customer?.phone ? `Phone: ${o.customer.phone}` : '',
    o.doctorName ? `Doctor: ${o.doctorName}` : '',
    repeat('-'),
  ]
  if (o.cartItems.length) {
    lines.push('Items:')
    for (const i of o.cartItems) {
      lines.push(`  ${i.name.slice(0, 28).padEnd(28)} x${i.qty} ${i.total_price.toFixed(2).padStart(8)}`)
    }
  }
  if (o.examinations.length) {
    lines.push(repeat('-'), 'Examinations:')
    o.examinations.forEach((e, idx) => {
      lines.push(`  [${idx + 1}] ${e.exam_type ?? 'N/A'}`)
      lines.push(`      OD: ${e.sphere_od || '-'}/${e.cylinder_od || '-'}x${e.axis_od || '-'}`)
      lines.push(`      OS: ${e.sphere_os || '-'}/${e.cylinder_os || '-'}x${e.axis_os || '-'}`)
      lines.push(`      IPD: ${e.ipd || '-'}`)
      lines.push(`      Lens: ${e.lens_info || '-'}`)
      lines.push(`      Frame: ${e.frame_info || '-'} (${e.frame_color || '-'})`)
    })
  }
  lines.push(...totalsBlock(o, shop))
  return lines.filter(Boolean).join('\n')
}

export function buildCustomerCopy(o: CompletedOrder, shop: Shop): string {
  const lines = [
    ...header('CUSTOMER COPY', shop),
    `Invoice: #${o.invoiceNo}`,
    `Date: ${now()}`,
    `Delivery Date: ${fmtDate(o.deliveryDate)}`,
    repeat('-'),
    `Customer: ${customerName(o)}`,
    o.customer?.phone ? `Phone: ${o.customer.phone}` : '',
    repeat('-'),
  ]
  if (o.cartItems.length) {
    lines.push('Items:')
    for (const i of o.cartItems) {
      lines.push(`  ${i.name.slice(0, 28).padEnd(28)} x${i.qty} ${i.total_price.toFixed(2).padStart(8)}`)
    }
  }
  lines.push(...totalsBlock(o, shop), center('Thank you for your purchase!'), repeat('='))
  return lines.filter(Boolean).join('\n')
}

export function buildLabCopy(o: CompletedOrder, shop: Shop): string {
  const lines = [
    ...header('LAB COPY', shop),
    `Invoice: #${o.invoiceNo}`,
    `Date: ${fmtDate(new Date().toISOString())}`,
    `Delivery Date: ${fmtDate(o.deliveryDate)}`,
    o.doctorName ? `Doctor: ${o.doctorName}` : '',
    repeat('='),
  ]
  if (o.examinations.length) {
    o.examinations.forEach((e, idx) => {
      lines.push(repeat('-'), `Exam #${idx + 1}: ${e.exam_type ?? 'N/A'}`, repeat('='))
      lines.push('  OD (Right Eye)')
      lines.push(`    SPH: ${String(e.sphere_od || '-').padStart(8)}`)
      lines.push(`    CYL: ${String(e.cylinder_od || '-').padStart(8)}`)
      lines.push(`    AXIS: ${String(e.axis_od || '-').padStart(7)}`)
      lines.push('  OS (Left Eye)')
      lines.push(`    SPH: ${String(e.sphere_os || '-').padStart(8)}`)
      lines.push(`    CYL: ${String(e.cylinder_os || '-').padStart(8)}`)
      lines.push(`    AXIS: ${String(e.axis_os || '-').padStart(7)}`)
      lines.push(`  IPD: ${e.ipd || '-'}`)
      lines.push(repeat('-'))
      lines.push(`  Lens Type: ${e.lens_info || '-'}`)
      lines.push(`  Frame: ${e.frame_info || '-'}`)
      lines.push(`  Color: ${e.frame_color || '-'}`)
      lines.push(`  Frame Status: ${e.frame_status || '-'}`)
    })
  } else {
    lines.push('No examination data')
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
