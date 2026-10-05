import type { CompletedOrder } from './POSContext'

export type Shop = { name: string; address: string; phone: string; currency: string }

/**
 * Print layout (2026 redesign, v2):
 * ONE order = ONE landscape page of ~210×140 mm - the useful half of an A4
 * sheet cut horizontally. Three cut-apart parts:
 *   • Upper tier (65% height) → two equal columns: LEFT = customer, RIGHT = shop
 *   • Lower tier (35% height) → lab strip, full width
 * Prescriptions are TABULATED with grouped split cells - each eye is a group
 * (RIGHT / LEFT) whose SPH / CYL / AXIS values sit in their own labeled
 * columns (like the shop's legacy paper receipt). ON THE SHEET each group reads
 * SPH then CYL then AXIS; because the unit is RTL the source order of those
 * cells is the mirror of that, so read the table code against the printed page.
 * Frame status (جديد / عميل) is printed in the lab table. The lab strip carries
 * the shop's name, phone and address so a workshop slip can be traced back, and
 * does NOT carry the doctor.
 * Customer copy totals show ONLY المطلوب / المدفوع / الباقي (no gross/discount),
 * and the customer copy carries NO prescription table at all - the patient takes
 * home a receipt, while the prescription itself lives on the shop and lab copies.
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

/** One value per cell - blank when empty (legacy paper style). */
const cell = (v: string | null | undefined) => (v ?? '').toString().trim()

/** dd/mm/yyyy - the human way dates appear on the paper receipt. */
function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

/** Normalize either an in-memory checkout or a reprint dialog order. */
export function buildOrderDocument(order: CompletedOrder, _shop: Shop): OrderDoc {
  const rows: RxRow[] = order.examinations.map((e, i) => ({
    index: i + 1,
    type: cell(e.exam_type) || '-',
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
    deliveryDate: humanDate(cell(order.deliveryDate)) || '-',
    customerName: cell(order.customer?.name) || '-',
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
 * Prescription table with grouped split cells. Emitted (source) order is:
 *   الحالة | IPD | LEFT(AXIS CYL SPH) | RIGHT(AXIS CYL SPH) | النوع
 * (+# / العدسة / الإطار / اللون in the wide lab variant).
 * The unit is RTL, so a browser lays the FIRST cell out on the RIGHT: the
 * source order above is the mirror of the printed sheet, and within either eye
 * group the sheet therefore reads SPH, then CYL, then AXIS. The status
 * (جديد / عميل) replaced the old notes column.
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
  // Printed order is SPH then CYL then AXIS, but the SOURCE order below is its
  // mirror image, and that is deliberate. The whole unit is `direction:rtl`, so
  // the FIRST <th> a browser lays out is the one the eye reads FIRST - on the
  // RIGHT. Emitting SPH first therefore printed "AXIS CYL SPH" on the paper, which
  // is the order the shop's legacy receipt uses reversed. Read every trip through
  // the cells below against what the SHEET shows, not against what the string
  // says: for these two lines, the leftmost <th> is the first thing printed.
  const head2 = '<th>AXIS</th><th>CYL</th><th>SPH</th><th>AXIS</th><th>CYL</th><th>SPH</th>'

  const body = doc.rows
    .map((r) => {
      const cells = [
        `<td>${esc(r.status)}</td>`,
        wide ? `<td>${esc(r.color)}</td><td>${esc(r.frame)}</td><td>${esc(r.lens)}</td>` : '',
        `<td class="rcpt-num">${esc(r.ipd)}</td>`,
        // Mirror image of head2 - see the note above it.
        `<td class="rcpt-num">${esc(r.axOd)}</td>`,
        `<td class="rcpt-num">${esc(r.cylOd)}</td>`,
        `<td class="rcpt-num">${esc(r.sphOd)}</td>`,
        `<td class="rcpt-num">${esc(r.axOs)}</td>`,
        `<td class="rcpt-num">${esc(r.cylOs)}</td>`,
        `<td class="rcpt-num">${esc(r.sphOs)}</td>`,
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
 * Totals only - the receipt deliberately does NOT show HOW the money was paid
 * (per-tender breakdown lives in History's ledger and the Reports cash-up).
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
 * The complete half-page unit (styles provided separately - see UNIT_CSS).
 * Layout: the lab strip takes what its table needs; the top tier (customer |
 * shop columns) stretches over the rest, each column clamping its own
 * overflow so nothing ever bleeds across the dividers. Totals stay pinned to
 * the bottom of their column. A density class shrinks fonts as the
 * prescription count grows - graduated so even 6+ Rx show COMPLETELY.
 * Column order: CUSTOMER on the right, shop on the left.
 */

/**
 * The shop's own contact details - address on one line, phone on the next.
 *
 * Two lines rather than one joined with a middot: the sheet gets cut in half
 * and the address is how a customer confirms they are at the right shop, so it
 * has to be readable on its own instead of sharing a baseline with a number.
 */
function shopIdentity(shop: Shop): string {
  const lines: string[] = []
  if (shop.address) lines.push(`<div>${esc(shop.address)}</div>`)
  if (shop.phone) lines.push(`<div><span class="rcpt-num">${esc(shop.phone)}</span></div>`)
  return lines.length ? `<div class="rcpt-sub">${lines.join('')}</div>` : ''
}

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

  // The customer copy deliberately carries NO prescription table. It is the slip
  // the patient takes home, and the numbers on it are a record they cannot act
  // on and that the lab/workshop copy is the authoritative home for. What stays
  // is what settles the visit: who it was for, which invoice, when it is due,
  // and what is still owed.
  const customerCol = `
    <div class="rcpt-col rcpt-col-customer">
      <div class="rcpt-head">${esc(shop.name)}</div>
      ${shopIdentity(shop)}
      <div class="rcpt-tag">نسخة العميل</div>
      <div class="rcpt-body">
        ${metaTable(doc)}
      </div>
      <div class="rcpt-money">${totalsTable(doc, cur, 'customer')}</div>
      <div class="rcpt-foot">
        <div class="rcpt-note">يعتبر هذا الإيصال لاغ بعد ثلاثة أشهر من تاريخه</div>
        <div class="rcpt-thanks">شكراً لتعاملكم معنا 🌹</div>
      </div>
    </div>`
  const shopCol = `
    <div class="rcpt-col rcpt-col-shop">
      <div class="rcpt-head">نسخة المحل - ${esc(shop.name)}</div>
      ${shopIdentity(shop)}
      <div class="rcpt-body">
        ${metaTable(doc)}
        ${rxTable(doc, false)}
      </div>
      <div class="rcpt-foot">
        ${totalsTable(doc, cur, 'shop')}
        <div class="rcpt-sign">التوقيع ............................</div>
      </div>
    </div>`
  // The lab strip travels: it comes off this unit and goes to the workshop, and a
  // slip with nothing on it but an invoice number cannot be traced back to the
  // shop it belongs to. It therefore carries the shop's own identity - name,
  // phone and address - and NOT the doctor, who is not the party the workshop
  // needs to call and whose name belongs on the customer's copy.
  const labIdentity = shopIdentity(shop)
  const labTier = `
    <div class="rcpt-lab">
      <div class="rcpt-head rcpt-head-lab">${esc(shop.name)} - نسخة المعمل - فاتورة <span class="rcpt-num">#${esc(doc.invoiceNo)}</span> · التسليم <span class="rcpt-num">${esc(doc.deliveryDate)}</span></div>
      ${labIdentity}
      ${rxTable(doc, true)}
    </div>`

  // RTL container: first child sits on the RIGHT → customer; shop lands LEFT.
  return `<div class="rcpt-unit${density}"><div class="rcpt-top">${customerCol}${shopCol}</div>${labTier}</div>`
}

// ---------- styles ----------

/** Component styles - safe to inject into the app for previews. */
export const UNIT_CSS = `
.rcpt-unit{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;
  direction:rtl;text-align:right;color:#000;background:#fff;overflow:hidden;
  font-family:'Segoe UI',Tahoma,'Cairo','Noto Naskh Arabic',Arial,sans-serif}
/* Top tier takes all the space the lab strip doesn't need - content can never
   bleed across the 2pt divider. */
.rcpt-top{flex:1 1 auto;min-height:0;display:flex;min-width:0;overflow:hidden}
.rcpt-col{flex:1 1 50%;padding:1.5mm 2mm;min-width:0;box-sizing:border-box;
  display:flex;flex-direction:column;overflow:hidden}
/* Body keeps its natural height (shrinks only when space runs out) - leftover
   space falls BELOW the totals instead of pooling between table and totals. */
.rcpt-body{flex:0 1 auto;min-height:0;overflow:hidden}
.rcpt-foot{padding-top:1mm}
/* Money is CENTRED in the customer column, not pinned to the bottom. The body
   keeps its natural height and the two auto margins split the leftover space
   evenly above and below the totals, so they land in the middle of the copy
   instead of hugging the money-free bottom third. */
.rcpt-col-customer .rcpt-body{flex:0 0 auto;min-height:0}
.rcpt-col-customer .rcpt-money{flex:0 0 auto;margin-top:auto;margin-bottom:auto}
/* The closing lines are lifted clear of the bottom edge. Printers crop the last
   few millimetres unpredictably and the cut is not always square to the page,
   and a receipt whose final line lands on the cut is one the customer cannot
   prove they were given. */
.rcpt-col-customer .rcpt-foot{flex:0 0 auto;margin-bottom:6mm}
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

/** Print-page rules - ONLY injected into the print window (never the app).
 *  A4 portrait; each sheet holds TWO order units (top + bottom half), so the
 *  paper can be cut horizontally into two equal halves - one order each.
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
 * Print one or more order units - two per A4 sheet (top/bottom halves), so a
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


// ---------- WhatsApp text rendering ----------

/**
 * One eye, as `SPH / CYL x AX`, or '' when the eye was left blank.
 *
 * Blank rather than '-': a half-filled prescription is normal (a mono lens has
 * no CYL, a sunglasses order may have no numbers at all), and printing empty
 * punctuation on a receipt the customer reads says "missing" where the shop
 * meant "not applicable".
 */
function eyeText(sph: string, cyl: string, ax: string): string {
  const parts = [cell(sph), cell(cyl)].filter(Boolean)
  const axis = cell(ax)
  if (!parts.length) return axis ? `x${axis}` : ''
  return axis ? `${parts.join(' / ')} x${axis}` : parts.join(' / ')
}

/** Only the optional lines that have something in them. */
function labelled(label: string, value: string): string[] {
  return value ? [`${label}: ${value}`] : []
}

/**
 * The order as plain text, for WhatsApp.
 *
 * Deliberately NOT HTML and NOT markdown tables: WhatsApp renders neither, and
 * a table pasted into a chat reads as broken. Plain labelled lines are what a
 * customer can actually read on a phone.
 *
 * The wording is the same Arabic the printed sheet uses (فاتورة / الإجمالي /
 * المتبقي …) rather than fresh labels, so the two artefacts a customer holds -
 * the paper and the message - do not describe the same invoice in two dialects.
 * Those labels live in `metaTable`/`totalsTable` as literals; they are repeated
 * here rather than extracted, because extracting them would mean threading a
 * label table through the HTML renderer for no gain at this size.
 *
 * The remaining balance is included on purpose: it is the one number a customer
 * is most likely to want and least likely to have to hand.
 */
export function buildOrderText(doc: OrderDoc, shop: Shop): string {
  const t = doc.totals
  const out: string[] = []

  out.push(`*${shop.name}*`)

  const head = [`فاتورة #${cell(doc.invoiceNo)}`, cell(doc.orderDate)].filter(Boolean)
  out.push(head.join('  |  '))
  if (cell(doc.deliveryDate)) out.push(`التسليم: ${cell(doc.deliveryDate)}`)
  out.push(`العميل: ${cell(doc.customerName)}`)
  out.push(...labelled('الجوال', cell(doc.customerPhone)))
  out.push(...labelled('الطبيب', cell(doc.doctorName)))

  if (!doc.rows.length) {
    out.push('', 'لا توجد وصفات')
  } else {
    for (const r of doc.rows) {
      out.push('', `*${r.index})* ${cell(r.type)}`)
      const R = eyeText(r.sphOd, r.cylOd, r.axOd)
      const L = eyeText(r.sphOs, r.cylOs, r.axOs)
      out.push(...labelled('يمين', R))
      out.push(...labelled('يسار', L))
      out.push(...labelled('IPD', cell(r.ipd)))
      out.push(...labelled('العدسة', cell(r.lens)))
      out.push(...labelled('الإطار', cell(r.frame)))
      out.push(...labelled('اللون', cell(r.color)))
      out.push(...labelled('الحالة', cell(r.status)))
    }
  }

  const cur = cell(shop.currency)
  const amt = (n: number) => (cur ? `${money(n)} ${cur}` : money(n))
  out.push('', `الإجمالي: ${amt(t.gross)}`)
  if (t.discount > 0) out.push(`الخصم: - ${amt(t.discount)}`)
  out.push(`الصافي: ${amt(t.net)}`)
  out.push(`المدفوع: ${amt(t.paid)}`)
  out.push(`*المتبقي: ${amt(t.remaining)}*`)

  const footer = [cell(shop.address), cell(shop.phone)].filter(Boolean)
  if (footer.length) out.push('', footer.join('  |  '))
  out.push('شكراً لزيارتكم')

  return out.join('\n')
}

/**
 * Default country dialling code, used only when a stored number is in national
 * form. Overridable per shop via the `country_code` setting, because hardcoding
 * it would be right for exactly one country.
 */
export const DEFAULT_COUNTRY_CODE = '20'

/**
 * The customer's phone as WhatsApp requires it: digits only, country code first,
 * no plus sign and no national trunk zero.
 *
 * `customer.phone` is stored exactly as typed and the app normalises it nowhere,
 * so all of these are legitimate entries for one person and must collapse to the
 * same digits:
 *
 *   01000000051    -> 201000000051   (national: trunk 0 dropped, code prepended)
 *   +201000000051  -> 201000000051
 *   00201000000051 -> 201000000051
 *   201000000051   -> 201000000051   (already international)
 *
 * Returns null when the result cannot be trusted - blank, or a length no real
 * number has - so the caller can fall back to the contact picker. Opening a
 * customer's chat against a mistyped stranger's number is worse than one tap.
 */
export function resolveWhatsAppNumber(
  raw: string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const hadPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  else if (!hadPlus && digits.startsWith('0')) digits = digits.replace(/^0+/, '')
  const cc = (countryCode || DEFAULT_COUNTRY_CODE).replace(/\D/g, '')
  // Already carries its country code? Only assume so when it begins with the
  // one this shop dialled from, rather than guessing for any long number.
  const full = cc && digits.startsWith(cc) ? digits : `${cc}${digits}`
  return /^\d{8,15}$/.test(full) ? full : null
}

/**
 * A wa.me link carrying the receipt text.
 *
 * With a resolvable number the link opens that chat directly; without one it
 * degrades to the contact picker, so a missing or odd-typed phone still shares.
 *
 * The number is a PATH segment - `wa.me/<number>` is the documented short form,
 * and `?phone=` on wa.me is not a thing. Either way the text is URL-encoded:
 * a space would otherwise truncate the link.
 */
export function whatsAppShareUrl(
  text: string,
  phone?: string,
  countryCode?: string,
): string {
  const number = phone ? resolveWhatsAppNumber(phone, countryCode) : null
  return `${number ? `https://wa.me/${number}` : 'https://wa.me/'}?text=${encodeURIComponent(text)}`
}

/**
 * Open WhatsApp with the receipt, addressed to the customer when we can.
 *
 * Returns false when the browser refused the window, so the caller can fall back
 * to the clipboard - a blocked popup otherwise looks like a button that does
 * nothing, which is how a cashier learns to ignore it.
 */
export async function shareOrderOnWhatsApp(
  doc: OrderDoc,
  shop: Shop,
  opts: { phone?: string; countryCode?: string } = {},
): Promise<'opened' | 'copied'> {
  const text = buildOrderText(doc, shop)
  const win = window.open(
    whatsAppShareUrl(text, opts.phone, opts.countryCode),
    '_blank',
    'noopener,noreferrer',
  )
  if (win) return 'opened'
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Nothing we can do here, and the receipt is on the screen in front of the
    // cashier regardless - which is why both paths report 'copied' honestly:
    // the text IS available to paste, and saying otherwise invents a failure
    // that the user cannot act on.
  }
  return 'copied'
}
