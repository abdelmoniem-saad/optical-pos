import sys
import os
import datetime
from passlib.hash import bcrypt

# Add the project root to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.models import (
    Base, User, Product, Warehouse, StockMovement, Role, Customer, Setting,
    LensType, FrameType, FrameColor, ContactLensType, Supplier, Purchase, PurchaseItem,
    Sale, SaleItem, OrderExamination, Prescription
)
from app.database.db_manager import get_engine, get_session, set_setting
from app.core.permissions import seed_permissions, seed_roles_and_bindings

def reset_and_seed():
    engine = get_engine()
    
    # Close any existing connections if possible (SQLite might lock)
    # Since we are running as a separate script, it should be fine unless the main app is open.
    
    print("Dropping all tables...")
    Base.metadata.drop_all(engine)
    
    print("Creating all tables...")
    Base.metadata.create_all(engine)
    
    session = get_session(engine)
    
    # 1. Seed Roles and Permissions
    print("Seeding roles and permissions...")
    seed_permissions(session)
    seed_roles_and_bindings(session)
    admin_role = session.query(Role).filter_by(name='Admin').first()
    
    # 2. Seed Admin User
    print("Seeding admin user...")
    admin = User(
        username='admin', 
        password_hash=bcrypt.hash('Admin123'), 
        role_id=admin_role.id, 
        full_name='System Administrator'
    )
    session.add(admin)
    
    # 3. Seed Warehouse
    print("Seeding warehouse...")
    wh = Warehouse(name='Main Warehouse', location='Store')
    session.add(wh)
    session.flush()
    
    # 4. Seed Optical Settings
    print("Seeding optical settings...")
    lens_types = ['Single Vision', 'Bifocal', 'Progressive', 'Blue Cut', 'Photochromic']
    for t in lens_types:
        session.add(LensType(name=t))
        
    frame_types = ['Full Rim', 'Half Rim', 'Rimless', 'Cat Eye', 'Aviator']
    for t in frame_types:
        session.add(FrameType(name=t))
        
    black = FrameColor(name='Black')
    colors = [black, FrameColor(name='Gold'), FrameColor(name='Silver'), FrameColor(name='Brown'), FrameColor(name='Blue')]
    for c in colors:
        session.add(c)
    
    contact_lens_types = ['Soft Contact Lens', 'Hard Contact Lens', 'Colored Contact Lens']
    for t in contact_lens_types:
        session.add(ContactLensType(name=t))

    # 5. Seed Suppliers
    print("Seeding suppliers...")
    sup1 = Supplier(name='Optical Wholesalers Ltd', phone='555-0101', email='info@optiwholesale.com', address='123 Supply Ave')
    sup2 = Supplier(name='Global Frames Co', phone='555-0102', email='sales@globalframes.com', address='456 Vision St')
    session.add_all([sup1, sup2])
    session.flush()
    
    # 6. Seed Products
    print("Seeding products...")
    p1 = Product(
        sku='LNS001', name='Standard SV Lens', category='Lens', lens_type='Single Vision',
        cost_price=20.0, sale_price=45.0, unit='pcs'
    )
    p2 = Product(
        sku='FRM001', name='Classic Black Acetate', category='Frame', frame_type='Full Rim', frame_color='Black',
        cost_price=30.0, sale_price=85.0, unit='pcs'
    )
    p3 = Product(
        sku='ACC001', name='Microfiber Cleaning Cloth', category='Accessory',
        cost_price=0.5, sale_price=5.0, unit='pcs'
    )
    session.add_all([p1, p2, p3])
    session.flush()
    
    # 7. Seed Stock Movements
    session.add(StockMovement(product_id=p1.id, warehouse_id=wh.id, qty=100, type='purchase', ref_no='INIT', note='Initial stock'))
    session.add(StockMovement(product_id=p2.id, warehouse_id=wh.id, qty=50, type='purchase', ref_no='INIT', note='Initial stock'))
    session.add(StockMovement(product_id=p3.id, warehouse_id=wh.id, qty=200, type='purchase', ref_no='INIT', note='Initial stock'))
    
    # 8. Seed Customers
    print("Seeding customers...")
    c1 = Customer(name='Ahmed Ali', phone='01011223344', city='Cairo', address='Maadi, Street 9')
    c2 = Customer(name='Sara Hassan', phone='01223344556', city='Alexandria', address='Smouha')
    session.add_all([c1, c2])
    session.flush()
    
    # 9. Seed a Sale
    print("Seeding sample sale...")
    sale = Sale(
        invoice_no='000001',
        customer_id=c1.id,
        user_id=admin.id,
        total_amount=130.0,
        discount=10.0,
        net_amount=120.0,
        amount_paid=100.0,
        payment_method='Cash',
        order_date=datetime.datetime.now(),
        delivery_date=datetime.datetime.now() + datetime.timedelta(days=2),
        is_received=False
    )
    session.add(sale)
    session.flush()
    
    # Add sale items
    si1 = SaleItem(sale_id=sale.id, product_id=p2.id, qty=1, unit_price=85.0, total_price=85.0)
    si2 = SaleItem(sale_id=sale.id, product_id=p1.id, qty=1, unit_price=45.0, total_price=45.0)
    session.add_all([si1, si2])
    
    exam = OrderExamination(
        sale_id=sale.id,
        exam_type='Distance',
        sphere_od='-1.25', cylinder_od='-0.50', axis_od='180',
        sphere_os='-1.00', cylinder_os='-0.75', axis_os='175',
        ipd='64',
        lens_info='Standard SV Lens',
        frame_info='Classic Black Acetate',
        frame_color='Black',
        frame_status='New'
    )
    session.add(exam)
    
    # Deduct stock for the sale
    session.add(StockMovement(product_id=p2.id, warehouse_id=wh.id, qty=-1, type='sale', ref_no='000001', note='Sale to Ahmed Ali'))
    
    # 9.5 Seed a Manual Prescription
    print("Seeding sample manual prescription...")
    presc = Prescription(
        customer_id=c2.id,
        doctor_name='Dr. Samir',
        type='Bifocal',
        sphere_od='+1.00', cylinder_od='-0.25', axis_od='90',
        sphere_os='+1.00', cylinder_os='-0.25', axis_os='85',
        ipd_od='32', ipd_os='32',
        notes='Reading glasses'
    )
    session.add(presc)
    
    # 10. Seed Setting
    set_setting(session, 'language', 'ar')
    set_setting(session, 'store_name', 'Optical Shop')
    
    session.commit()
    session.close()
    print("✓ Reset and Seed complete!")

if __name__ == '__main__':
    reset_and_seed()
