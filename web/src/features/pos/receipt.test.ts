import { describe, expect, it } from 'vitest'
import type { Customer, Sale } from '../../lib/database.types'
import type { CompletedOrder } from './POSContext'
import { UNIT_CSS, buildOrderDocument, renderOrderUnitHTML } from './receipt'
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
