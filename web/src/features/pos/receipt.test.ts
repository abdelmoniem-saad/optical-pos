import { describe, expect, it } from 'vitest'
import type { Customer, Sale } from '../../lib/database.types'
import type { CompletedOrder } from './POSContext'
import {
  UNIT_CSS,
  buildOrderDocument,
  renderOrderUnitHTML,
  buildOrderText,
  whatsAppShareUrl,
  resolveWhatsAppNumber,
} from './receipt'
import type { OrderDoc, Shop } from './receipt'
import { emptyExam } from './types'

const shop = { name: 'Lensy', address: 'شارع 1', phone: '0100', currency: 'ج.م' }

function order(over: Partial<CompletedOrder> = {}): CompletedOrder {
  return {
    sale: { order_date: '2026-09-25T09:30:00' } as unknown as Sale,
    customer: { name: 'أحمد', phone: '0111' } as unknown as Customer,
    cartItems: [],
    examinations: [{ ...emptyExam(), sphere_od: '-1.25', frame_status: 'Old' }],
    totals: { itemsTotal: 120, gross: 120, discount: 20, net: 100, amountPaid: 40, balance: 60 },
    invoiceNo: '000123',
    doctorName: 'د. سامي',
    deliveryDate: '2026-10-01',
    isUpdate: false,
    ...over,
  }
}

describe('buildOrderDocument', () => {
  it('maps the order onto the printable document with human dates', () => {
    const doc = buildOrderDocument(order(), shop)
    expect(doc.invoiceNo).toBe('000123')
    expect(doc.orderDate).toBe('25/09/2026')
    expect(doc.deliveryDate).toBe('01/10/2026')
    expect(doc.customerName).toBe('أحمد')
    expect(doc.doctorName).toBe('د. سامي')
    expect(doc.totals).toEqual({ gross: 120, discount: 20, net: 100, paid: 40, remaining: 60 })
    expect(doc.rows[0]).toMatchObject({ index: 1, sphOd: '-1.25', status: 'عميل' })
  })

  it('translates the frame status (New -> جديد)', () => {
    const doc = buildOrderDocument(
      order({ examinations: [{ ...emptyExam(), frame_status: 'New' }] }),
      shop,
    )
    expect(doc.rows[0].status).toBe('جديد')
  })

  it('uses "-" for a missing customer and a missing delivery date', () => {
    const doc = buildOrderDocument(order({ customer: null, deliveryDate: '' }), shop)
    expect(doc.customerName).toBe('-')
    expect(doc.deliveryDate).toBe('-')
  })
})

describe('renderOrderUnitHTML', () => {
  it('renders the three cut-apart copies with the invoice number', () => {
    const html = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)
    expect(html).toContain('rcpt-unit')
    expect(html).toContain('نسخة العميل')
    expect(html).toContain('نسخة المحل')
    expect(html).toContain('نسخة المعمل')
    expect(html).toContain('#000123')
    expect(html).toContain('ج.م')
  })

  it('escalates the density class with the number of prescriptions', () => {
    const one = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)
    expect(one).not.toMatch(/rcpt-d\d/)

    const two = renderOrderUnitHTML(
      buildOrderDocument(order({ examinations: [emptyExam(), emptyExam()] }), shop),
      shop,
    )
    expect(two).toContain('rcpt-d2')

    const six = renderOrderUnitHTML(
      buildOrderDocument(order({ examinations: Array.from({ length: 6 }, () => emptyExam()) }), shop),
      shop,
    )
    expect(six).toContain('rcpt-d6')
  })

  it('escapes HTML coming from user data', () => {
    const html = renderOrderUnitHTML(
      buildOrderDocument(
        order({ customer: { name: '<b>x</b>', phone: '1' } as unknown as Customer }),
        shop,
      ),
      shop,
    )
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('prints the discount row only when there is a discount', () => {
    const withDiscount = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)
    expect(withDiscount).toContain('الخصم')

    const noDiscount = renderOrderUnitHTML(
      buildOrderDocument(
        order({
          totals: { itemsTotal: 100, gross: 100, discount: 0, net: 100, amountPaid: 0, balance: 100 },
        }),
        shop,
      ),
      shop,
    )
    expect(noDiscount).not.toContain('الخصم')
  })

  it('keeps the receipt styles RTL with Latin-isolated numbers', () => {
    expect(UNIT_CSS).toContain('direction:rtl')
    expect(UNIT_CSS).toContain('.rcpt-num{direction:ltr')
  })

  it('centres the money in the customer column instead of pinning it low', () => {
    // The customer copy has no prescription table, so the column is short. Two
    // auto margins on the totals split the leftover space evenly above and below
    // them, which is what puts the money in the middle rather than leaving one
    // blank band between the details and the totals.
    expect(UNIT_CSS).toMatch(/\.rcpt-col-customer \.rcpt-money\{[^}]*margin-top:auto/)
    expect(UNIT_CSS).toMatch(/\.rcpt-col-customer \.rcpt-money\{[^}]*margin-bottom:auto/)
    // The body must NOT grow, or it would swallow the free space the money's
    // margins are there to divide.
    expect(UNIT_CSS).toMatch(/\.rcpt-col-customer \.rcpt-body\{[^}]*flex:0 0 auto/)
  })

  it('keeps the closing lines off the bottom edge of the sheet', () => {
    // Printers crop the last few millimetres unpredictably and the cut is not
    // always square to the page. A receipt whose final line lands on the cut is
    // one the customer cannot prove they were given.
    const foot = UNIT_CSS.match(/\.rcpt-col-customer \.rcpt-foot\{[^}]*\}/)
    expect(foot).not.toBeNull()
    expect(foot![0]).toMatch(/margin-bottom:\d/)
  })

  it('puts the shop address and phone on separate lines', () => {
    // The sheet is cut in half and the address is how a customer confirms they
    // are at the right shop, so it must not share a baseline with a number.
    const html = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)
    expect(html).toContain(
      '<div class="rcpt-sub"><div>شارع 1</div>' +
        '<div><span class="rcpt-num">0100</span></div></div>',
    )
    // ...and the old joined-on-one-line form is gone. Scoped to the sub header
    // rather than the whole document: the lab header legitimately uses a middot
    // to separate the invoice number from the delivery date.
    expect(html).not.toContain('<div class="rcpt-sub">شارع 1 · ')
  })

  // The unit is direction:rtl, so the FIRST <th> emitted is the one the eye reads
  // first on the sheet. The source order is therefore the mirror of the printed
  // one, and these two assertions are the only thing stopping a well-meaning
  // "tidy up the column order" edit from silently printing AXIS CYL SPH again.
  it('emits the eye columns mirrored so the SHEET prints SPH, CYL, AXIS', () => {
    const html = renderOrderUnitHTML(
      buildOrderDocument(
        order({
          examinations: [
            {
              ...emptyExam(),
              sphere_od: '-1.25', cylinder_od: '-0.50', axis_od: '180',
              sphere_os: '+2.00', cylinder_os: '-1.00', axis_os: '90',
            },
          ],
        }),
        shop,
      ),
      shop,
    )

    // Mirrored headers: the leftmost printed column is the LAST one emitted.
    expect(html).toContain(
      '<tr><th>AXIS</th><th>CYL</th><th>SPH</th><th>AXIS</th><th>CYL</th><th>SPH</th></tr>',
    )
    // And the values follow the same mirrored order, so no value drifts out from
    // under its own label.
    expect(html).toContain(
      '<td class="rcpt-num">180</td>' +
        '<td class="rcpt-num">-0.50</td>' +
        '<td class="rcpt-num">-1.25</td>' +
        '<td class="rcpt-num">90</td>' +
        '<td class="rcpt-num">-1.00</td>' +
        '<td class="rcpt-num">+2.00</td>',
    )
  })

  it('gives the lab strip the shop identity and leaves the doctor off it', () => {
    const html = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)
    // The lab tier is the last element of the unit, so slice to it rather than
    // asserting over the whole unit - the doctor legitimately stays on the
    // customer and shop copies.
    const lab = html.slice(html.indexOf('rcpt-lab'))

    expect(lab).toContain('نسخة المعمل')
    expect(lab).toContain('Lensy')
    expect(lab).toContain('شارع 1')
    expect(lab).toContain('0100')
    expect(lab).not.toContain('الطبيب')
    expect(lab).not.toContain('د. سامي')
  })

  it('keeps the doctor on the customer copy', () => {
    const html = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)
    expect(html).toContain('الطبيب')
  })

  it('keeps the prescription table OFF the customer copy but on the other two', () => {
    const html = renderOrderUnitHTML(buildOrderDocument(order(), shop), shop)

    // Slice by the structural markers rather than asserting over the whole unit,
    // so this can only pass if the table is missing from the customer column
    // SPECIFICALLY and not merely absent everywhere.
    const customer = html.slice(
      html.indexOf('rcpt-col-customer'),
      html.indexOf('rcpt-col-shop'),
    )
    const shopCol = html.slice(html.indexOf('rcpt-col-shop'), html.indexOf('rcpt-lab'))
    const lab = html.slice(html.indexOf('rcpt-lab'))

    expect(customer).not.toContain('rcpt-rx')
    expect(customer).not.toContain('AXIS')
    // …but the copy is still a real receipt: who, which invoice, what is owed.
    expect(customer).toContain('المطلوب')
    expect(customer).toContain('المدفوع')
    expect(customer).toContain('الباقي')
    expect(customer).toContain('#000123')

    expect(shopCol).toContain('rcpt-rx')
    expect(lab).toContain('rcpt-rx')
  })
})

// ---------- WhatsApp text ----------

const SHOP: Shop = {
  name: 'Lensy Optical',
  address: '5 Tahrir St',
  phone: '01000000000',
  currency: 'EGP',
}

const doc = (over: Partial<OrderDoc> = {}): OrderDoc => ({
  invoiceNo: 'Y0001',
  orderDate: '20/09/2026',
  deliveryDate: '27/09/2026',
  customerName: 'Ahmed',
  customerPhone: '01000000051',
  doctorName: '',
  rows: [
    {
      index: 1, type: 'Distance',
      sphOd: '-1.25', cylOd: '-0.50', axOd: '180',
      sphOs: '-1.25', cylOs: '-0.50', axOs: '175',
      ipd: '63', lens: 'Progressive', frame: 'Ray-Ban', color: 'أسود', status: 'جديد',
    },
  ],
  totals: { gross: 1000, discount: 50, net: 950, paid: 500, remaining: 450 },
  ...over,
})

describe('buildOrderText', () => {
  it('carries the facts a customer actually needs', () => {
    const text = buildOrderText(doc(), SHOP)
    expect(text).toContain('Lensy Optical')
    expect(text).toContain('Y0001')
    expect(text).toContain('Ahmed')
    expect(text).toContain('Progressive')
    expect(text).toContain('20/09/2026')
  })

  it('leads with the remaining balance, which is the number they want', () => {
    const text = buildOrderText(doc(), SHOP)
    expect(text).toContain('450.00 EGP')
    // and it is the bolded line, so it is what stands out in the chat
    expect(text).toContain('*المتبقي: 450.00 EGP*')
  })

  it('shows the discount only when there is one', () => {
    expect(buildOrderText(doc(), SHOP)).toContain('الخصم')
    const none = buildOrderText(doc({ totals: { gross: 1000, discount: 0, net: 1000, paid: 1000, remaining: 0 } }), SHOP)
    expect(none).not.toContain('الخصم')
  })

  it('omits a blank eye rather than printing empty punctuation', () => {
    // A mono lens has no CYL and an order may have no numbers at all; printing
    // "R:  /  x" on a customer-facing receipt reads as missing, not as N/A.
    const text = buildOrderText(doc({
      rows: [{ ...doc().rows[0], sphOd: '-2.00', cylOd: '', axOd: '', sphOs: '', cylOs: '', axOs: '', ipd: '' }],
    }), SHOP)
    expect(text).not.toContain('يمين: /')
    expect(text).not.toContain('x')
    expect(text).toContain('يمين: -2.00')
  })

  it('omits optional fields that are empty instead of printing "undefined"', () => {
    const text = buildOrderText(doc({ customerPhone: '', doctorName: '', deliveryDate: '' }), SHOP)
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
    expect(text).not.toContain('الجوال')
    expect(text).not.toContain('الطبيب')
    expect(text).not.toContain('التسليم')
  })

  it('says so when there are no prescriptions, rather than printing nothing', () => {
    expect(buildOrderText(doc({ rows: [] }), SHOP)).toContain('لا توجد وصفات')
  })

  it('numbers every row of a two-prescription order', () => {
    const rows = [doc().rows[0], { ...doc().rows[0], index: 2, lens: 'Single Vision' }]
    const text = buildOrderText(doc({ rows }), SHOP)
    expect(text).toContain('*1)*')
    expect(text).toContain('*2)*')
    expect(text).toContain('Single Vision')
  })

  it('keeps Arabic lens and colour names intact', () => {
    const text = buildOrderText(doc({ rows: [{ ...doc().rows[0], lens: 'متعدد البؤر', color: 'بني' }] }), SHOP)
    expect(text).toContain('متعدد البؤر')
    expect(text).toContain('بني')
  })
})

describe('whatsAppShareUrl', () => {
  it('points at wa.me with the text encoded', () => {
    const url = whatsAppShareUrl('فاتورة #Y0001')
    expect(url.startsWith('https://wa.me/?text=')).toBe(true)
    expect(decodeURIComponent(url.split('text=')[1])).toBe('فاتورة #Y0001')
  })

  // The characters most likely to survive a hand-rolled template: a space
  // truncating the link, an & starting a bogus query parameter, and a + read
  // as a space. Encoding is the whole correctness of this function.
  it('escapes characters that would otherwise break the query string', () => {
    const text = 'Lens & Frame 100% +20 0100 x2'
    const decoded = decodeURIComponent(whatsAppShareUrl(text).split('text=')[1])
    expect(decoded).toBe(text)
    expect(whatsAppShareUrl(text).split('text=')[1]).not.toMatch(/[&+]/)
  })

  it('round-trips a whole receipt', () => {
    const text = buildOrderText(doc(), SHOP)
    expect(decodeURIComponent(whatsAppShareUrl(text).split('text=')[1])).toBe(text)
  })
})

// ---------- addressing the customer ----------

describe('resolveWhatsAppNumber', () => {
  // The same person is stored four different ways depending on who typed it.
  // Every one has to land on the same chat.
  const expected = '201000000051'
  it('drops the national trunk zero and adds the country code', () => {
    expect(resolveWhatsAppNumber('01000000051')).toBe(expected)
  })
  it('keeps a number that is already international', () => {
    expect(resolveWhatsAppNumber('+201000000051')).toBe(expected)
    expect(resolveWhatsAppNumber('201000000051')).toBe(expected)
  })
  it('understands the 00 prefix used when dialling from abroad', () => {
    expect(resolveWhatsAppNumber('00201000000051')).toBe(expected)
  })
  it('copes with the spaces and dashes people actually type', () => {
    expect(resolveWhatsAppNumber('+20 100 000 0051')).toBe(expected)
    expect(resolveWhatsAppNumber('010-000-000-51')).toBe(expected)
  })

  // The reason the fallback exists at all.
  it('returns null rather than guessing when there is nothing to work with', () => {
    expect(resolveWhatsAppNumber('')).toBeNull()
    expect(resolveWhatsAppNumber('   ')).toBeNull()
    expect(resolveWhatsAppNumber('abc')).toBeNull()
  })
  it('rejects a length no real number has instead of dialling it', () => {
    expect(resolveWhatsAppNumber('123')).toBeNull()
    expect(resolveWhatsAppNumber('1234567890123456789')).toBeNull()
  })

  it('follows the shop setting, not a hardcoded country', () => {
    expect(resolveWhatsAppNumber('0501234567', '966')).toBe('966501234567')
    // trunk zero dropped, then the code prefixed - 11 digits, not 12
    expect(resolveWhatsAppNumber('0501234567', '20')).toBe('20501234567')
    // already carries the configured code, so it must not be doubled
    expect(resolveWhatsAppNumber('+966501234567', '966')).toBe('966501234567')
  })
})

describe('whatsAppShareUrl with a customer number', () => {
  it('puts the number in the PATH, which is the documented wa.me form', () => {
    const url = whatsAppShareUrl('hello', '01000000051')
    expect(url.startsWith('https://wa.me/201000000051?text=')).toBe(true)
    // the documented short form has no ?phone= anywhere
    expect(url).not.toContain('phone=')
  })

  it('falls back to the contact picker when the number cannot be trusted', () => {
    expect(whatsAppShareUrl('hello', '').startsWith('https://wa.me/?text=')).toBe(true)
    expect(whatsAppShareUrl('hello', '123').startsWith('https://wa.me/?text=')).toBe(true)
  })

  it('still encodes the text when a number is present', () => {
    const url = whatsAppShareUrl('فاتورة & 100%', '01000000051')
    expect(url.split('?text=')[1]).not.toMatch(/[&+]/)
    expect(decodeURIComponent(url.split('?text=')[1])).toBe('فاتورة & 100%')
  })
})
