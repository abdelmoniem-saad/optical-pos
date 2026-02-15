# scripts/verify_pos_logic.py
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine, get_session
from app.database.models import User, Product, Sale, SaleItem, StockMovement, Warehouse
from app.core.permissions import has_permission

def test_pos_backend():
    engine = get_engine()
    session = get_session(engine)
    
    try:
        # 1. Get admin user
        admin = session.query(User).filter_by(username='admin').first()
        print(f"Testing for user: {admin.username}")
        
        # 2. Check permission
        allowed, unused = has_permission(session, admin.id, "CREATE_SALE")
        print(f"Permission CREATE_SALE: {allowed}")
        assert allowed == True
        
        # 3. Find product
        product = session.query(Product).filter_by(sku='SAMPLE001').first()
        print(f"Product found: {product.name} (Price: {product.sale_price})")
        
        # 4. Get warehouse
        wh = session.query(Warehouse).first()
        print(f"Warehouse: {wh.name}")
        
        # 5. Simulate Sale Logic
        invoice_no = "TEST-INV-001"
        gross_total = product.sale_price * 2
        discount = 10.0
        net_total = gross_total - discount
        
        sale = Sale(
            invoice_no=invoice_no,
            user_id=admin.id,
            total_amount=gross_total,
            discount=discount,
            net_amount=net_total,
            payment_method='Cash'
        )
        session.add(sale)
        session.flush()
        
        si = SaleItem(
            sale_id=sale.id,
            product_id=product.id,
            qty=2,
            unit_price=product.sale_price,
            total_price=gross_total
        )
        session.add(si)
        
        sm = StockMovement(
            product_id=product.id,
            warehouse_id=wh.id,
            qty=-2,
            type='sale',
            ref_no=invoice_no,
            note="Test sale"
        )
        session.add(sm)
        
        session.commit()
        print(f"Sale {invoice_no} saved successfully.")
        
        # 6. Verify stock movement
        total_qty = session.query(StockMovement).filter_by(product_id=product.id).all()
        current_stock = sum(m.qty for m in total_qty)
        print(f"Current stock for {product.sku}: {current_stock}")
        # Initial was 50, -2 = 48
        assert current_stock == 48
        
        print("POS Backend Logic Verification Passed!")
        
    except Exception as e:
        session.rollback()
        print(f"Test failed: {e}")
        sys.exit(1)
    finally:
        session.close()

if __name__ == "__main__":
    test_pos_backend()

