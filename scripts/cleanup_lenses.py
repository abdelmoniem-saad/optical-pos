import sys
import os

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine, get_session
from app.database.models import Product, StockMovement, SaleItem

def cleanup_lenses():
    print("Starting lens cleanup...")
    engine = get_engine()
    session = get_session(engine)
    
    try:
        # Find all products with category 'Lens' or 'ContactLens'
        lenses = session.query(Product).filter(Product.category.in_(['Lens', 'ContactLens'])).all()
        
        if not lenses:
            print("No lens products found to clean up.")
            return

        print(f"Found {len(lenses)} lens products to remove.")
        
        for lens in lenses:
            print(f"Removing lens: {lens.name} (SKU: {lens.sku})")
            
            # Delete associated stock movements
            session.query(StockMovement).filter_by(product_id=lens.id).delete()
            
            # Delete associated sale items (optional, but keeps data clean if we don't need history linked to product id)
            # Note: OrderExamination still holds the text info, so history is preserved there.
            # However, deleting SaleItem might affect total calculations if re-calculated from items.
            # But Sale model holds the totals.
            # Let's keep SaleItems but set product_id to null or a placeholder if possible, 
            # but SaleItem.product_id is nullable=False.
            # So we must delete SaleItems or keep the Product.
            # The requirement implies removing them from inventory tracking.
            # If we delete the product, we must delete the SaleItems due to foreign key constraint.
            session.query(SaleItem).filter_by(product_id=lens.id).delete()
            
            # Delete the product
            session.delete(lens)
            
        session.commit()
        print("Cleanup completed successfully.")
        
    except Exception as e:
        session.rollback()
        print(f"Error during cleanup: {e}")
    finally:
        session.close()

if __name__ == "__main__":
    cleanup_lenses()

