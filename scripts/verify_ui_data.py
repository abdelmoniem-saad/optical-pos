# scripts/verify_ui_data.py
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine, get_session
from app.database.models import Sale, Product, StockMovement

def verify():
    session = get_session(get_engine())
    print("--- Verifying Data for UI ---")
    
    # Check Sales
    sales_count = session.query(Sale).count()
    print(f"Total Sales in History: {sales_count}")
    
    # Check Inventory
    products = session.query(Product).all()
    print(f"Total Products in Inventory: {len(products)}")
    for p in products:
        total_qty = session.query(StockMovement).filter_by(product_id=p.id).with_entities(StockMovement.qty).all()
        stock = sum(q[0] for q in total_qty)
        print(f" - {p.name} ({p.sku}): {stock} in stock")

    session.close()
    print("Verification complete.")

if __name__ == "__main__":
    verify()
