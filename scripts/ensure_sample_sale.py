# scripts/ensure_sample_sale.py
"""
Ensure at least one Sale exists in the database for UI testing.
If there are no sales, this script will create a minimal sample sale using
existing product/customer/warehouse or creating them if missing.
This is non-destructive: it will not drop tables.
"""
import os, sys, datetime
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine, get_session
from app.database.models import Product, Customer, Warehouse, StockMovement, Sale, SaleItem, OrderExamination

engine = get_engine()
s = get_session(engine)
try:
    sale_count = s.query(Sale).count()
    print('Sales in DB:', sale_count)
    if sale_count > 0:
        print('No action needed.')
        sys.exit(0)

    # Find or create warehouse
    wh = s.query(Warehouse).first()
    if not wh:
        wh = Warehouse(name='Main Warehouse', location='Store')
        s.add(wh)
        s.commit()
        print('Created warehouse')

    # Find or create product
    p = s.query(Product).first()
    if not p:
        p = Product(sku='AUTO001', name='Sample Lens', description='Seed sample', cost_price=10.0, sale_price=25.0, unit='pcs', category='Lens', lens_type='Single Vision')
        s.add(p)
        s.commit()
        print('Created sample product', p.sku)
        # initial stock
        sm = StockMovement(product_id=p.id, warehouse_id=wh.id, qty=10, type='purchase', ref_no='INIT', note='Initial stock')
        s.add(sm)
        s.commit()
    else:
        print('Using existing product:', p.sku)

    # Find or create customer
    c = s.query(Customer).first()
    if not c:
        c = Customer(name='Test Customer', phone='0000000000', city='Test')
        s.add(c)
        s.commit()
        print('Created customer')
    else:
        print('Using existing customer:', c.name)

    # Create a sale
    invoice_no = f"SAMPLE-{int(datetime.datetime.utcnow().timestamp())}"
    sale = Sale(invoice_no=invoice_no, user_id=None, customer_id=c.id, total_amount=25.0, discount=0.0, offer=0.0, net_amount=25.0, amount_paid=0.0, payment_method='Cash', order_date=datetime.datetime.utcnow(), lab_status='Not Started')
    s.add(sale)
    s.flush()

    # add sale item and deduct stock
    si = SaleItem(sale_id=sale.id, product_id=p.id, qty=1, unit_price=p.sale_price or 0.0, total_price=p.sale_price or 0.0)
    s.add(si)
    sm2 = StockMovement(product_id=p.id, warehouse_id=wh.id, qty=-1, type='sale', ref_no=invoice_no, note='Sample sale')
    s.add(sm2)

    # add a minimal OrderExamination row
    ex = OrderExamination(sale_id=sale.id, exam_type='Distance', sphere_od='0.00', cylinder_od='0.00', axis_od='0', sphere_os='0.00', cylinder_os='0.00', axis_os='0', ipd='63', lens_info=p.name, frame_info='', frame_color='', frame_status='New')
    s.add(ex)

    s.commit()
    print('Created sample sale:', invoice_no)
finally:
    s.close()


