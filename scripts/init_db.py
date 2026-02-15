# scripts/init_db.py
import sys
import os
# Add the project root to sys.path so we can import 'app'
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.models import (
    Base, User, Product, Warehouse, StockMovement, Role, Customer, Setting,
    LensType, FrameType, FrameColor, ContactLensType
)
from app.database.db_manager import get_engine, get_session, set_setting
from app.core.permissions import seed_permissions, seed_roles_and_bindings
from passlib.hash import bcrypt

def init_db():
    engine = get_engine()
    Base.metadata.create_all(engine)
    return engine

def seed_core(engine):
    session = get_session(engine)

    # create roles if not exist
    admin_role = session.query(Role).filter_by(name='Admin').first()
    if not admin_role:
        admin_role = Role(name='Admin')
        session.add(admin_role)
        session.commit()

    # create admin user if not exists
    admin = session.query(User).filter_by(username='admin').first()
    if not admin:
        pwd = 'Admin123'  # change after first login
        hashed = bcrypt.hash(pwd)
        admin = User(username='admin', password_hash=hashed, role_id=admin_role.id, full_name='Store Admin')
        session.add(admin)
        session.commit()
        print("Created admin user -> username: admin  password:", pwd)
    else:
        print("Admin user already exists:", admin.username)

    # create default warehouse
    wh = session.query(Warehouse).filter_by(name='Main Warehouse').first()
    if not wh:
        wh = Warehouse(name='Main Warehouse', location='Store')
        session.add(wh)
        session.commit()
        print("Created warehouse:", wh.name)

    # create a sample product
    p = session.query(Product).filter_by(sku='SAMPLE001').first()
    if not p:
        p = Product(sku='SAMPLE001', name='Lens Sample', description='Demo lens', cost_price=50.0, sale_price=120.0, unit='pcs')
        session.add(p)
        session.commit()
        print("Created sample product:", p.name)

        # initial stock movement
        sm = StockMovement(product_id=p.id, warehouse_id=wh.id, qty=50, type='purchase', ref_no='INIT_STOCK', note='Initial seed stock')
        session.add(sm)
        session.commit()
        print("Added initial stock movement (50 pcs).")
    else:
        print("Sample product already exists:", p.name)

    # create a sample customer
    c = session.query(Customer).filter_by(name='John Doe').first()
    if not c:
        c = Customer(name='John Doe', phone='0123456789', email='john@example.com', address='123 Main St')
        session.add(c)
        session.commit()
        print("Created sample customer:", c.name)

    # Seed default language
    if not session.query(Setting).filter_by(key='language').first():
        set_setting(session, 'language', 'en')
        print("Seeded default language: en")

    # Seed Optical specific data
    if not session.query(LensType).first():
        for t in ['Single Vision', 'Bifocal', 'Progressive']:
            session.add(LensType(name=t))
        print("Seeded Lens types")

    if not session.query(FrameType).first():
        for t in ['Full Rim', 'Half Rim', 'Rimless']:
            session.add(FrameType(name=t))
        print("Seeded Frame types")

    if not session.query(FrameColor).first():
        for c_name in ['Black', 'Gold', 'Silver', 'Brown']:
            session.add(FrameColor(name=c_name))
        print("Seeded Frame colors")

    # ContactLensType now imported above; guard in case model changes
    try:
        if not session.query(ContactLensType).first():
            for t in ['Soft Contact Lens', 'Hard Contact Lens', 'Colored Contact Lens']:
                session.add(ContactLensType(name=t))
            print("Seeded Contact Lens types")
    except Exception:
        # If ContactLensType is not available for any reason, continue without failing
        print("ContactLensType model unavailable; skipping contact lens seeding.")

    session.commit()

    # Also seed permissions and roles bindings
    seed_permissions(session)
    seed_roles_and_bindings(session)

    session.close()

if __name__ == '__main__':
    engine = init_db()
    seed_core(engine)
    print("Database initialization complete.")

