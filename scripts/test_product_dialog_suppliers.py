# scripts/test_product_dialog_suppliers.py
"""Test the enhanced supplier dropdown and invoice filtering in ProductDialog"""
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PySide6.QtWidgets import QApplication
from app.database.db_manager import get_engine, get_session
from app.database.models import User
from app.ui.product_dialog import ProductDialog

app = QApplication(sys.argv)
s = get_session(get_engine())
user = s.query(User).first()
s.close()

# Create dialog for new product
d = ProductDialog()
d.show()
app.processEvents()

print('✓ Dialog created and shown')

# Check supplier dropdown is populated
print(f'Supplier dropdown items: {d.supplier_input.count()}')
for i in range(min(5, d.supplier_input.count())):
    print(f'  {i}: {d.supplier_input.itemText(i)}')

# Select a supplier (if any exist)
if d.supplier_input.count() > 1:
    d.supplier_input.setCurrentIndex(1)
    app.processEvents()
    supplier_name = d.supplier_input.currentText()
    print(f'\n✓ Selected supplier: {supplier_name}')
    print(f'Invoice dropdown items for this supplier: {d.invoice_input.count()}')
    for i in range(min(5, d.invoice_input.count())):
        print(f'  {i}: {d.invoice_input.itemText(i)}')
else:
    print('No suppliers in database to test')

# Test typing in supplier field (filters invoices)
print('\n✓ Testing supplier text change...')
d.supplier_input.setCurrentIndex(0)
d.supplier_input.setEditText('test')
app.processEvents()
print(f'Invoices after typing "test": {d.invoice_input.count()}')

d.close()
app.quit()
print('\n✓ Test complete!')

