import type { CompletedOrder } from './POSContext'

export type Shop = { name: string; address: string; phone: string; currency: string }

/**
 * Print layout (2026 redesign, v2):
 * ONE order = ONE landscape page of ~210×140 mm — the useful half of an A4
 * sheet cut horizontally. Three cut-apart parts:
 *   • Upper tier (65% height) → two equal columns: LEFT = customer, RIGHT = shop
 *   • Lower tier (35% height) → lab strip, full width
 * Prescriptions are TABULATED with grouped split cells — each eye is a group
 * (RIGHT / LEFT) whose SPH / CYL / AXIS values sit in their own labeled
 * columns (like the shop's legacy paper receipt). Item lists (الأصناف) are
 * NOT printed. Frame status (جديد / عميل) is printed in the lab table.
 * Customer copy totals show ONLY المطلوب / المدفوع / الباقي (no gross/discount).
 * Receipts are ALWAYS Arabic (RTL) with Latin digits.
 */

export type RxRow = {
  index: number
  type: string
  sphOd: string
  cylOd: string
  axOd: string
  sphOs: string
  cylOs: string
  axOs: string
  ipd: string
  lens: string
  frame: string
  color: string
  status: string
}

export type OrderDoc = {
  invoiceNo: string
  orderDate: string
  deliveryDate: string
  customerName: string
  customerPhone: string
  doctorName: string
  rows: RxRow[]
  totals: { gross: number; discount: number; net: number; paid: number; remaining: number }
}

const money = (n: number) => n.toFixed(2)

function statusAr(s: string | null | undefined): string {
  const v = (s ?? '').trim()
  if (v === 'New') return 'جديد'
  if (v === 'Old') return 'عميل'
  return v || ''
}

/** One value per cell — blank when empty (legacy paper style). */
const cell = (v: string | null | undefined) => (v ?? '').toString().trim()

/** dd/mm/yyyy — the human way dates appear on the paper receipt. */
function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

/** Normalize either an in-memory checkout or a reprint dialog order. */
export function buildOrderDocument(order: CompletedOrder, _shop: Shop): OrderDoc {
  const rows: RxRow[] = order.examinations.map((e, i) => ({
    index: i + 1,
    type: cell(e.exam_type) || '—',
    sphOd: cell(e.sphere_od),
    cylOd: cell(e.cylinder_od),
    axOd: cell(e.axis_od),
    sphOs: cell(e.sphere_os),
    cylOs: cell(e.cylinder_os),
    axOs: cell(e.axis_os),
    ipd: cell(e.ipd),
    lens: cell(e.lens_info),
    frame: cell(e.frame_info),
    color: cell(e.frame_color),
    status: statusAr(e.frame_status),
  }))
  const t = order.totals
  return {
    invoiceNo: order.invoiceNo,
    orderDate: humanDate(cell(order.sale.order_date) || new Date().toISOString()),
    deliveryDate: humanDate(cell(order.deliveryDate)) || '—',
    customerName: cell(order.customer?.name) || '—',
    customerPhone: cell(order.customer?.phone),
    doctorName: cell(order.doctorName),
    rows,
    totals: {
      gross: t.gross,
      discount: t.discount,
      net: t.net,
      paid: t.amountPaid,
      remaining: t.balance,
    },
  }
}

// ---------- HTML rendering ----------

const esc = (s: string) =>
  s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)

const num = (n: number, currency?: string) =>
  `<span class="rcpt-num">${money(n)}${currency ? ' ' + esc(currency) : ''}</span>`

function metaTable(doc: OrderDoc): string {
  const rows: [string, string][] = [
    ['فاتورة #', `<span class="rcpt-num">#${esc(doc.invoiceNo)}</span>`],
    ['التاريخ', `<span class="rcpt-num">${esc(doc.orderDate)}</span>`],
    ['التسليم', `<span class="rcpt-num">${esc(doc.deliveryDate)}</span>`],
    ['العميل', esc(doc.customerName)],
  ]
  if (doc.customerPhone) rows.push(['الجوال', `<span class="rcpt-num">${esc(doc.customerPhone)}</span>`])
  if (doc.doctorName) rows.push(['الطبيب', esc(doc.doctorName)])
  return `<table class="rcpt-meta">${rows
    .map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`)
    .join('')}</table>`
}

/**
 * Prescription table with grouped split cells — columns are laid out
 * right-to-left as: الحالة | IPD | RIGHT(SPH CYL AXIS) | LEFT(SPH CYL AXIS) |
 * النوع (+# / العدسة / الإطار / اللون in the wide lab variant).
 * The status (جديد / عميل) replaced the old notes column.
 */
function rxTable(doc: OrderDoc, wide: boolean): string {
  if (!doc.rows.length) return `<div class="rcpt-empty">لا توجد وصفات</div>`

  const head1 =
    `<th rowspan="2">الحالة</th>` +
    (wide
      ? `<th rowspan="2">اللون</th><th rowspan="2">الإطار</th><th rowspan="2">العدسة</th>`
      : '') +
    `<th rowspan="2">IPD</th>` +
    `<th colspan="3" class="grp">LEFT</th><th colspan="3" class="grp">RIGHT</th>` +
    `<th rowspan="2">النوع</th>` +
    (wide ? `<th rowspan="2">#</th>` : '')
  const head2 = '<th>SPH</th><th>CYL</th><th>AXIS</th><th>SPH</th><th>CYL</th><th>AXIS</th>'

  const body = doc.rows
    .map((r) => {
      const cells = [
        `<td>${esc(r.status)}</td>`,
        wide ? `<td>${esc(r.color)}</td><td>${esc(r.frame)}</td><td>${esc(r.lens)}</td>` : '',
        `<td class="rcpt-num">${esc(r.ipd)}</td>`,
        `<td class="rcpt-num">${esc(r.sphOd)}</td>`,
        `<td class="rcpt-num">${esc(r.cylOd)}</td>`,
        `<td class="rcpt-num">${esc(r.axOd)}</td>`,
        `<td class="rcpt-num">${esc(r.sphOs)}</td>`,
        `<td class="rcpt-num">${esc(r.cylOs)}</td>`,
        `<td class="rcpt-num">${esc(r.axOs)}</td>`,
        `<td>${esc(r.type)}</td>`,
        wide ? `<td class="rcpt-num">${r.index}</td>` : '',
      ]
      return `<tr>${cells.join('')}</tr>`
    })
    .join('')

  return `<table class="rcpt-rx${wide ? ' wide' : ''}"><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * kind 'shop'    → الإجمالي / الخصم / الصافي / المدفوع / المتبقي
 * kind 'customer'→ المطلوب / المدفوع / الباقي (no gross, no discount)
 */
function totalsTable(doc: OrderDoc, currency: string, kind: 'shop' | 'customer'): string {
  const t = doc.totals
  if (kind === 'customer') {
    return `<table class="rcpt-tot">
      <tr class="strong"><td>المطلوب</td><td class="r">${num(t.net, currency)}</td></tr>
      <tr><td>المدفوع</td><td class="r">${num(t.paid)}</td></tr>
      <tr class="strong"><td>الباقي</td><td class="r">${num(t.remaining)}</td></tr>
    </table>`
  }
  return `<table class="rcpt-tot">
    <tr><td>الإجمالي</td><td class="r">${num(t.gross, currency)}</td></tr>
    ${t.discount > 0 ? `<tr><td>الخصم</td><td class="r">− ${num(t.discount)}</td></tr>` : ''}
    <tr class="strong"><td>الصافي</td><td class="r">${num(t.net)}</td></tr>
    <tr><td>المدفوع</td><td class="r">${num(t.paid)}</td></tr>
    <tr class="strong"><td>المتبقي</td><td class="r">${num(t.remaining)}</td></tr>
  </table>`
}

/**
 * The complete half-page unit (styles provided separately — see UNIT_CSS).
 * Layout: the lab strip takes what its table needs; the top tier (customer |
 * shop columns) stretches over the rest, each column clamping its own
 * overflow so nothing ever bleeds across the dividers. Totals stay pinned to
 * the bottom of their column. A density class shrinks fonts as the
 * prescription count grows — graduated so even 6+ Rx show COMPLETELY.
 * Column order: CUSTOMER on the right, shop on the left.
 */
export function renderOrderUnitHTML(doc: OrderDoc, shop: Shop): string {
  const cur = shop.currency
  const density =
    doc.rows.length >= 6
      ? ' rcpt-d6'
      : doc.rows.length === 5
        ? ' rcpt-d5'
        : doc.rows.length === 4
          ? ' rcpt-d4'
          : doc.rows.length === 3
            ? ' rcpt-d3'
            : doc.rows.length === 2
              ? ' rcpt-d2'
              : ''

  const customerCol = `
    <div class="rcpt-col rcpt-col-customer">
      <div class="rcpt-head">${esc(shop.name)}</div>
      ${shop.address || shop.phone ? `<div class="rcpt-sub">${shop.address ? esc(shop.address) : ''}${shop.address && shop.phone ? ' · ' : ''}${shop.phone ? `<span class="rcpt-num">${esc(shop.phone)}</span>` : ''}</div>` : ''}
      <div class="rcpt-tag">نسخة العميل</div>
      <div class="rcpt-body">
        ${metaTable(doc)}
        ${rxTable(doc, false)}
      </div>
      <div class="rcpt-foot">
        ${totalsTable(doc, cur, 'customer')}
        <div class="rcpt-note">يعتبر هذا الإيصال لاغ بعد ثلاثة أشهر من تاريخه</div>
        <div class="rcpt-thanks">شكراً لتعاملكم معنا 🌹</div>
      </div>
    </div>`
  const shopCol = `
    <div class="rcpt-col rcpt-col-shop">
      <div class="rcpt-head">نسخة المحل — ${esc(shop.name)}</div>
      ${shop.address || shop.phone ? `<div class="rcpt-sub">${shop.address ? esc(shop.address) : ''}${shop.address && shop.phone ? ' · ' : ''}${shop.phone ? `<span class="rcpt-num">${esc(shop.phone)}</span>` : ''}</div>` : ''}
      <div class="rcpt-body">
        ${metaTable(doc)}
        ${rxTable(doc, false)}
      </div>
      <div class="rcpt-foot">
        ${totalsTable(doc, cur, 'shop')}
        <div class="rcpt-sign">التوقيع ............................</div>
      </div>
    </div>`
  const labTier = `
    <div class="rcpt-lab">
      <div class="rcpt-head rcpt-head-lab">نسخة المعمل — فاتورة <span class="rcpt-num">#${esc(doc.invoiceNo)}</span> · التسليم <span class="rcpt-num">${esc(doc.deliveryDate)}</span>${doc.doctorName ? ` · الطبيب ${esc(doc.doctorName)}` : ''}</div>
      ${rxTable(doc, true)}
    </div>`

  // RTL container: first child sits on the RIGHT → customer; shop lands LEFT.
  return `<div class="rcpt-unit${density}"><div class="rcpt-top">${customerCol}${shopCol}</div>${labTier}</div>`
}

// ---------- styles ----------

/** Component styles — safe to inject into the app for previews. */
export const UNIT_CSS = `
.rcpt-unit{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;
  direction:rtl;text-align:right;color:#000;background:#fff;overflow:hidden;
  font-family:'Segoe UI',Tahoma,'Cairo','Noto Naskh Arabic',Arial,sans-serif}
/* Top tier takes all the space the lab strip doesn't need — content can never
   bleed across the 2pt divider. */
.rcpt-top{flex:1 1 auto;min-height:0;display:flex;min-width:0;overflow:hidden}
.rcpt-col{flex:1 1 50%;padding:1.5mm 2mm;min-width:0;box-sizing:border-box;
  display:flex;flex-direction:column;overflow:hidden}
/* Body keeps its natural height (shrinks only when space runs out) — leftover
   space falls BELOW the totals instead of pooling between table and totals. */
.rcpt-body{flex:0 1 auto;min-height:0;overflow:hidden}
.rcpt-foot{padding-top:1mm}
.rcpt-col-customer{border-inline-start:1.5pt solid #000}
.rcpt-lab{flex:0 0 auto;border-top:2pt solid #000;padding:1.5mm 2mm;box-sizing:border-box;overflow:hidden}
.rcpt-head{font-size:10.5pt;font-weight:800;border-bottom:0.75pt solid #000;padding-bottom:0.8mm;margin-bottom:1mm}
.rcpt-head-lab{font-size:9.5pt}
.rcpt-sub{font-size:7.5pt;color:#333;line-height:1.3}
.rcpt-tag{display:inline-block;font-size:8pt;font-weight:700;background:#000;color:#fff;
  padding:0.3mm 1.5mm;border-radius:1mm;margin-bottom:0.8mm}
.rcpt-note{margin-top:1mm;font-size:7.5pt;font-weight:600;text-align:center;color:#444;
  border:0.5pt dashed #999;border-radius:1mm;padding:0.8mm 1mm}
.rcpt-meta{width:100%;border-collapse:collapse;font-size:8.5pt}
.rcpt-meta td{padding:0.35mm 0;vertical-align:top}
.rcpt-meta td.k{width:17mm;color:#444;white-space:nowrap}
.rcpt-meta td.v{font-weight:600}
.rcpt-rx{width:100%;border-collapse:collapse;font-size:7.5pt;margin-top:1mm;table-layout:fixed}
.rcpt-rx th,.rcpt-rx td{border:0.5pt solid #000;padding:0.5mm 0.4mm;text-align:center;overflow:hidden}
.rcpt-rx th{background:#e8e8e8;font-weight:700;font-size:7pt}
.rcpt-rx th.grp{background:#d5d5d5;font-size:7.5pt;letter-spacing:0.3pt}
.rcpt-rx.wide{font-size:8.5pt}
.rcpt-rx.wide th,.rcpt-rx.wide td{padding:0.7mm 0.8mm}
.rcpt-rx td.rcpt-num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums}
.rcpt-empty{font-size:8.5pt;color:#555;margin-top:1mm}
.rcpt-tot{width:70%;margin-inline-start:auto;border-collapse:collapse;font-size:8.5pt;margin-top:1mm}
.rcpt-tot td{padding:0.3mm 0}
.rcpt-tot td.r{text-align:left;direction:ltr}
.rcpt-tot tr.strong td{font-weight:800;font-size:9.5pt}
.rcpt-num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums}
.rcpt-thanks{margin-top:1mm;font-size:8.5pt;text-align:center;color:#333}
.rcpt-sign{margin-top:1.5mm;font-size:8pt;color:#333;text-align:left;direction:ltr}
/* Density stages: graduated per prescription count (1 → normal, 2 → d2, …
   6+ → d6) so every unit shows its COMPLETE receipt inside the half-A4 slot. */
.rcpt-d2 .rcpt-rx{font-size:7pt}
.rcpt-d2 .rcpt-rx th{font-size:6.4pt;padding:0.35mm 0.3mm}
.rcpt-d2 .rcpt-rx td{padding:0.3mm 0.3mm}
.rcpt-d3 .rcpt-rx{font-size:6.4pt}
.rcpt-d3 .rcpt-rx th{font-size:5.8pt;padding:0.3mm 0.25mm}
.rcpt-d3 .rcpt-rx td{padding:0.25mm 0.25mm}
.rcpt-d3 .rcpt-meta{font-size:8pt}
.rcpt-d4 .rcpt-rx{font-size:5.8pt}
.rcpt-d4 .rcpt-rx th{font-size:5.2pt;padding:0.2mm 0.2mm}
.rcpt-d4 .rcpt-rx td{padding:0.2mm 0.2mm}
.rcpt-d4 .rcpt-meta{font-size:7.5pt}
.rcpt-d4 .rcpt-tot{font-size:7.5pt}
.rcpt-d4 .rcpt-tot tr.strong td{font-size:8.2pt}
.rcpt-d4 .rcpt-head{font-size:9.5pt;margin-bottom:0.6mm}
.rcpt-d5 .rcpt-rx{font-size:5.2pt}
.rcpt-d5 .rcpt-rx th{font-size:4.8pt;padding:0.15mm 0.15mm}
.rcpt-d5 .rcpt-rx td{padding:0.15mm 0.15mm}
.rcpt-d5 .rcpt-meta{font-size:7pt}
.rcpt-d5 .rcpt-tot{font-size:7pt}
.rcpt-d5 .rcpt-tot tr.strong td{font-size:7.6pt}
.rcpt-d5 .rcpt-head{font-size:9pt;margin-bottom:0.5mm}
.rcpt-d6 .rcpt-rx{font-size:4.8pt}
.rcpt-d6 .rcpt-rx th{font-size:4.4pt;padding:0.1mm 0.1mm}
.rcpt-d6 .rcpt-rx td{padding:0.1mm 0.1mm}
.rcpt-d6 .rcpt-meta{font-size:6.5pt}
.rcpt-d6 .rcpt-tot{font-size:6.5pt}
.rcpt-d6 .rcpt-tot tr.strong td{font-size:7pt}
.rcpt-d6 .rcpt-head{font-size:8.5pt;margin-bottom:0.4mm}
`

/** Print-page rules — ONLY injected into the print window (never the app).
 *  A4 portrait; each sheet holds TWO order units (top + bottom half), so the
 *  paper can be cut horizontally into two equal halves — one order each.
 *  The unit keeps ~4mm inner padding so nothing lands on printer dead zones
 *  or exactly on the cut line. */
const PAGE_CSS = `
@page{size:A4 portrait;margin:0}
html,body{margin:0;padding:0;background:#fff}
.rcpt-sheet{width:210mm;height:297mm;display:flex;flex-direction:column;
  break-after:page;page-break-after:always}
.rcpt-sheet:last-child{break-after:auto;page-break-after:auto}
.rcpt-slot{height:148.5mm;padding:4mm;box-sizing:border-box;display:flex}
.rcpt-sheet .rcpt-slot:first-child{border-bottom:0.3mm dashed #aaa}
.rcpt-unit{flex:1;width:100%;min-width:0}
`

/**
 * Print one or more order units — two per A4 sheet (top/bottom halves), so a
 * sheet is cut horizontally into two orders. A single order fills only the
 * top half; the bottom half stays blank.
 */
export function printOrderDocuments(docs: OrderDoc[], shop: Shop): boolean {
  if (!docs.length) return false
  const win = window.open('', '_blank', 'width=840,height=600')
  if (!win) return false

  const sheets: string[] = []
  for (let i = 0; i < docs.length; i += 2) {
    const a = renderOrderUnitHTML(docs[i], shop)
    const b = docs[i + 1] ? renderOrderUnitHTML(docs[i + 1], shop) : ''
    sheets.push(`<div class="rcpt-sheet"><div class="rcpt-slot">${a}</div><div class="rcpt-slot">${b}</div></div>`)
  }

  const title = docs.length === 1 ? esc('فاتورة ' + docs[0].invoiceNo) : esc('فواتير')
  win.document.write(
    `<!doctype html><html dir="rtl"><head><meta charset="utf-8">
     <title>${title}</title>
     <style>${PAGE_CSS}${UNIT_CSS}</style></head>
     <body>${sheets.join('')}</body></html>`,
  )
  win.document.close()
  win.focus()
  win.print()
  return true
}

/** Convenience wrapper for a single order. */
export function printOrderDocument(doc: OrderDoc, shop: Shop): boolean {
  return printOrderDocuments([doc], shop)
}
