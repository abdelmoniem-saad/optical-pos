# scripts/test_product_qty_behaviour.py
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PySide6.QtWidgets import QApplication
from app.database.db_manager import get_engine, get_session
from app.database.models import Product
from app.ui.product_dialog import ProductDialog

app = QApplication(sys.argv)

s = get_session(get_engine())
product = s.query(Product).first()
s.close()

print('Using existing product id:', product.id if product else 'No product')

# Open dialog for existing product
if product:
    d = ProductDialog(product=product)
    d.show()
    app.processEvents()
    print('Existing product initial qty (should equal available):', d.initial_qty_input.value(), 'available_display:', d.available_display.value())
    d.close()

# Open dialog for new product
d2 = ProductDialog()
d2.show()
app.processEvents()
print('New product initial qty (should be 0):', d2.initial_qty_input.value())
d2.close()
app.quit()


