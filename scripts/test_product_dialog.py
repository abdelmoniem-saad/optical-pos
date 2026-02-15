# scripts/test_product_dialog.py
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PySide6.QtWidgets import QApplication
from app.database.db_manager import get_engine, get_session
from app.database.models import User
from app.ui.product_dialog import ProductDialog

app = QApplication(sys.argv)
# pick any user (not used heavily here)
s = get_session(get_engine())
user = s.query(User).first()
s.close()

# Create dialog (no product => add new)
d = ProductDialog()
# Show dialog briefly so visibility states are updated
d.show()
app.processEvents()
# Initially category empty
print('Initial SKU:', d.sku_input.text())
# Select Lens
for i in range(d.category_input.count()):
    if d.category_input.itemData(i) == 'Lens':
        d.category_input.setCurrentIndex(i)
        break
app.processEvents()
print('After selecting Lens SKU:', d.sku_input.text(), 'Lens visible?', d.lens_type_cb.isVisible(), 'Frame visible?', d.frame_type_cb.isVisible())
# Now select Frame
for i in range(d.category_input.count()):
    if d.category_input.itemData(i) == 'Frame':
        d.category_input.setCurrentIndex(i)
        break
app.processEvents()
print('After selecting Frame SKU:', d.sku_input.text(), 'Lens visible?', d.lens_type_cb.isVisible(), 'Frame visible?', d.frame_type_cb.isVisible())

# close dialog
d.close()
app.quit()

