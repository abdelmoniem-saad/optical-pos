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
})
