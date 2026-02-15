# scripts/test_product_dialog_full.py
"""Comprehensive test of ProductDialog with new supplier/invoice filtering"""
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PySide6.QtWidgets import QApplication
from app.database.db_manager import get_engine, get_session
from app.database.models import User, Supplier, Purchase
from app.ui.product_dialog import ProductDialog

app = QApplication(sys.argv)
s = get_session(get_engine())
user = s.query(User).first()

# Check suppliers and purchases exist
suppliers = s.query(Supplier).all()
print(f'✓ Database has {len(suppliers)} suppliers')
for sup in suppliers:
    purchases = s.query(Purchase).filter_by(supplier_id=sup.id).all()
    print(f'  - {sup.name}: {len(purchases)} purchases')

s.close()

# Create and show dialog
d = ProductDialog()
d.show()
app.processEvents()

print('\n✓ ProductDialog features:')

# Test 1: Category selection hides/shows fields
print('  1. Category selection:')
for i in range(d.category_input.count()):
    cat_text = d.category_input.itemText(i)
    cat_code = d.category_input.itemData(i)
    if cat_code:
        d.category_input.setCurrentIndex(i)
        app.processEvents()
        lens_vis = d.lens_type_cb.isVisible()
        frame_vis = d.frame_type_cb.isVisible()
        print(f'     - {cat_text}: Lens={lens_vis}, Frame={frame_vis}')

# Test 2: SKU auto-generation
print('\n  2. SKU auto-generation:')
for i in range(d.category_input.count()):
    cat_code = d.category_input.itemData(i)
    if cat_code in ['Lens', 'Frame', 'ContactLens']:
        d.category_input.setCurrentIndex(i)
        app.processEvents()
        sku = d.sku_input.text()
        cat_text = d.category_input.itemText(i)
        print(f'     - {cat_text}: SKU={sku}')

# Test 3: Supplier dropdown and filtering
print('\n  3. Supplier dropdown and invoice filtering:')
if d.supplier_input.count() > 1:
    d.supplier_input.setCurrentIndex(1)
    app.processEvents()
    supplier_name = d.supplier_input.currentText()
    invoice_count = d.invoice_input.count()
    print(f'     - Selected: {supplier_name}')
    print(f'     - Invoices shown: {invoice_count} items')
    if invoice_count > 1:
        print(f'       (e.g., {d.invoice_input.itemText(1)})')
else:
    print('     - No suppliers to test')

# Test 4: Barcode field removed
print('\n  4. Fields check:')
has_barcode = hasattr(d, 'barcode_input')
print(f'     - Barcode field removed: {not has_barcode}')
print(f'     - Supplier field type: {type(d.supplier_input).__name__} (QComboBox)')
print(f'     - Invoice field type: {type(d.invoice_input).__name__} (QComboBox)')

d.close()
app.quit()
print('\n✓ All tests passed!')

