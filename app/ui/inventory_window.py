# app/ui/inventory_window.py
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem, 
    QPushButton, QLabel, QHeaderView, QMessageBox, QLineEdit, QGridLayout, QTabWidget,
    QComboBox, QInputDialog
)
from PySide6.QtCore import Qt, QTimer
from app.database.db_manager import get_engine, get_session
from app.database.models import Product, StockMovement, Supplier, Purchase, LensType, FrameType, FrameColor, ContactLensType, SaleItem
from app.core.permissions import has_permission
from app.ui.product_dialog import ProductDialog
from app.ui.supplier_dialog import SupplierDialog
from app.ui.purchase_dialog import PurchaseDialog
from app.core.i18n import _
from app.core.state import state

class InventoryWindow(QWidget):
    def __init__(self, user, back_callback):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
        
        # Permission check
        session = get_session(get_engine())
        allowed, _v = has_permission(session, self.user.id, "VIEW_PRODUCTS")
        session.close()
        
        if not allowed:
            QMessageBox.warning(self, _("Permission Denied"), _("You do not have permission to view inventory."))
            # Schedule close/back
            QTimer.singleShot(0, self.back_callback)
            return

        self.init_ui()
        self.load_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(15)

        # Header
        header_layout = QGridLayout()
        back_btn = QPushButton(_("← Back to Dashboard"))
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header_layout.addWidget(back_btn, 0, 0, Qt.AlignLeft)

        title = QLabel(_("Inventory Management"))
        title.setStyleSheet("font-size: 36px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        layout.addLayout(header_layout)

        self.tabs = QTabWidget()
        self.tabs.setStyleSheet("QTabBar::tab { height: 60px; font-size: 20px; min-width: 200px; font-weight: bold; }")
        
        self.init_products_tab()
        self.init_suppliers_tab()
        self.init_purchases_tab()
        self.init_optical_settings_tab()

        layout.addWidget(self.tabs)
        self.setLayout(layout)

        # Listen for product/stock changes to refresh inventory automatically
        state.product_added.connect(self.on_product_changed)
        state.product_updated.connect(self.on_product_changed)
        state.product_deleted.connect(self.on_product_changed)
        state.refresh_all.connect(self.on_product_changed)
        state.metadata_changed.connect(self.on_metadata_changed)

    def init_products_tab(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        
        # Search & Filters
        top = QVBoxLayout()
        search_hb = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText(_("Search products by name or SKU..."))
        self.search_input.setMinimumHeight(65)
        self.search_input.setStyleSheet("font-size: 22px; padding: 10px;")
        self.search_input.textChanged.connect(self.load_data)
        search_hb.addWidget(self.search_input)
        
        add_btn = QPushButton(_("+ Add New Product"))
        add_btn.setMinimumHeight(65)
        add_btn.setStyleSheet("font-size: 20px; font-weight: bold; background-color: #2e7d32; color: white; border-radius: 10px;")
        add_btn.clicked.connect(self.add_product_dialog)
        search_hb.addWidget(add_btn)
        top.addLayout(search_hb)
        
        filters_hb = QHBoxLayout()
        self.cat_filter = QComboBox()
        # Display labels are localized (Arabic) while underlying data keeps canonical English codes
        self.cat_filter.addItem(_("All Categories"), None)
        # Removed Lens and ContactLens from filter options
        self.cat_filter.addItem('فريمات', 'Frame')
        self.cat_filter.addItem('نظارات شمسية', 'Sunglasses')
        self.cat_filter.addItem('إكسسوارات', 'Accessory')
        self.cat_filter.addItem('أخرى', 'Other')
        self.cat_filter.setMinimumHeight(50)
        self.cat_filter.setStyleSheet("font-size: 18px;")
        self.cat_filter.currentIndexChanged.connect(self.load_data)
        filters_hb.addWidget(QLabel(_("Category") + ":"))
        filters_hb.addWidget(self.cat_filter)
        
        self.type_filter = QLineEdit()
        self.type_filter.setPlaceholderText(_("Filter by Type/Color..."))
        self.type_filter.setMinimumHeight(50)
        self.type_filter.setStyleSheet("font-size: 18px;")
        
        top.addLayout(filters_hb)
        layout.addLayout(top)

        # Table
        self.table = QTableWidget(0, 8)
        self.table.setHorizontalHeaderLabels([
            _("SKU"), _("Barcode"), _("Name"), _("Category"), _("Frame Type"), _("Color"), _("Sale Price"), _("In Stock")
        ])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.table.setStyleSheet("font-size: 20px;")
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        layout.addWidget(self.table)

        # Bottom Actions
        actions_layout = QHBoxLayout()
        edit_btn = QPushButton(_("Edit Selected Product"))
        edit_btn.setMinimumHeight(50)
        edit_btn.setStyleSheet("font-size: 16px;")
        edit_btn.clicked.connect(self.edit_product_dialog)
        actions_layout.addWidget(edit_btn)

        adjust_btn = QPushButton(_("Adjust Stock"))
        adjust_btn.setMinimumHeight(50)
        adjust_btn.setStyleSheet("font-size: 16px;")
        adjust_btn.clicked.connect(self.adjust_stock_dialog)
        actions_layout.addWidget(adjust_btn)

        delete_btn = QPushButton(_("Delete Selected Product"))
        delete_btn.setMinimumHeight(50)
        delete_btn.setStyleSheet("font-size: 16px; background-color: #d32f2f; color: white;")
        delete_btn.clicked.connect(self.delete_product)
        actions_layout.addWidget(delete_btn)

        layout.addLayout(actions_layout)
        
        self.tabs.addTab(tab, _("Inventory"))

    def init_suppliers_tab(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        
        top = QHBoxLayout()
        self.supplier_search = QLineEdit()
        self.supplier_search.setPlaceholderText(_("Search"))
        self.supplier_search.setMinimumHeight(50)
        self.supplier_search.setStyleSheet("font-size: 18px;")
        self.supplier_search.textChanged.connect(self.load_suppliers)
        top.addWidget(self.supplier_search)
        
        add_btn = QPushButton(_("Add Supplier"))
        add_btn.setMinimumHeight(50)
        add_btn.setStyleSheet("font-size: 16px; font-weight: bold; background-color: #2e7d32; color: white;")
        add_btn.clicked.connect(self.add_supplier_dialog)
        top.addWidget(add_btn)
        layout.addLayout(top)
        
        self.supplier_table = QTableWidget(0, 3)
        self.supplier_table.setHorizontalHeaderLabels([_("Name"), _("Phone"), _("Email")])
        self.supplier_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.supplier_table.setStyleSheet("font-size: 18px;")
        self.supplier_table.horizontalHeader().setStyleSheet("font-size: 18px; font-weight: bold;")
        self.supplier_table.setSelectionBehavior(QTableWidget.SelectRows)
        layout.addWidget(self.supplier_table)
        
        edit_btn = QPushButton(_("Details"))
        edit_btn.setMinimumHeight(50)
        edit_btn.clicked.connect(self.edit_supplier_dialog)
        layout.addWidget(edit_btn)
        
        self.tabs.addTab(tab, _("Suppliers"))

    def init_purchases_tab(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        
        top = QHBoxLayout()
        self.purchase_search = QLineEdit()
        self.purchase_search.setPlaceholderText(_("Search by Invoice..."))
        self.purchase_search.setMinimumHeight(50)
        self.purchase_search.setStyleSheet("font-size: 18px;")
        self.purchase_search.textChanged.connect(self.load_purchases)
        top.addWidget(self.purchase_search)
        
        add_btn = QPushButton(_("Add Purchase"))
        add_btn.setMinimumHeight(50)
        add_btn.setStyleSheet("font-size: 16px; font-weight: bold; background-color: #1976d2; color: white;")
        add_btn.clicked.connect(self.add_purchase_dialog)
        top.addWidget(add_btn)
        layout.addLayout(top)
        
        self.purchase_table = QTableWidget(0, 4)
        self.purchase_table.setHorizontalHeaderLabels([_("Date"), _("Invoice:"), _("Supplier"), _("Total")])
        self.purchase_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.purchase_table.setStyleSheet("font-size: 18px;")
        self.purchase_table.horizontalHeader().setStyleSheet("font-size: 18px; font-weight: bold;")
        self.purchase_table.setSelectionBehavior(QTableWidget.SelectRows)
        layout.addWidget(self.purchase_table)
        
        self.tabs.addTab(tab, _("Purchases"))

    def load_data(self):
        self.load_products()
        self.load_suppliers()
        self.load_purchases()

    def refresh_data(self):
        """Refresh all data in the inventory window - called automatically when data changes"""
        self.load_data()
        # Also refresh optical settings if possible, but they are loaded per tab
        # We can trigger a reload of the current tab if it's an optical setting tab
        self.on_metadata_changed(None)

    def load_products(self):
        query_text = self.search_input.text().strip()
        cat_filter = self.cat_filter.currentData()
        type_filter = self.type_filter.text().strip()
        
        session = get_session(get_engine())
        try:
            from sqlalchemy import or_, not_
            query = session.query(Product)
            
            # Exclude Lens and ContactLens from inventory list
            query = query.filter(not_(Product.category.in_(['Lens', 'ContactLens'])))

            if query_text:
                query = query.filter(
                    (Product.sku.ilike(f"%{query_text}%")) | 
                    (Product.barcode.ilike(f"%{query_text}%")) | 
                    (Product.name.ilike(f"%{query_text}%"))
                )
            
            if cat_filter:
                query = query.filter(Product.category == cat_filter)
                
            if type_filter:
                query = query.filter(
                    or_(
                        Product.lens_type.ilike(f"%{type_filter}%"),
                        Product.frame_type.ilike(f"%{type_filter}%"),
                        Product.frame_color.ilike(f"%{type_filter}%")
                    )
                )
            
            products = query.all()
            
            self.table.setRowCount(0)
            self.product_skus = []
            for row_idx, p in enumerate(products):
                self.table.insertRow(row_idx)
                self.table.setItem(row_idx, 0, QTableWidgetItem(p.sku))
                self.table.setItem(row_idx, 1, QTableWidgetItem(p.barcode or ""))
                self.table.setItem(row_idx, 2, QTableWidgetItem(p.name))
                # Display localized category label (use translation if available)
                display_cat = _(p.category) if p.category else ""
                self.table.setItem(row_idx, 3, QTableWidgetItem(display_cat))
                self.table.setItem(row_idx, 4, QTableWidgetItem(p.frame_type or ""))
                self.table.setItem(row_idx, 5, QTableWidgetItem(p.frame_color or ""))
                self.table.setItem(row_idx, 6, QTableWidgetItem(f"{p.sale_price:.2f}"))
                
                total_qty = session.query(StockMovement).filter_by(product_id=p.id).with_entities(StockMovement.qty).all()
                stock = sum(q[0] for q in total_qty)
                stock_item = QTableWidgetItem(str(stock))
                self.table.setItem(row_idx, 7, stock_item)
                self.product_skus.append(p.sku)
        finally: session.close()

    def load_suppliers(self):
        query_text = self.supplier_search.text().strip()
        session = get_session(get_engine())
        try:
            query = session.query(Supplier)
            if query_text:
                query = query.filter(Supplier.name.ilike(f"%{query_text}%"))
            suppliers = query.all()
            self.supplier_table.setRowCount(0)
            self.supplier_ids = []
            for row, s in enumerate(suppliers):
                self.supplier_table.insertRow(row)
                self.supplier_table.setItem(row, 0, QTableWidgetItem(s.name))
                self.supplier_table.setItem(row, 1, QTableWidgetItem(s.phone or ""))
                self.supplier_table.setItem(row, 2, QTableWidgetItem(s.email or ""))
                self.supplier_ids.append(s.id)
        finally: session.close()

    def load_purchases(self):
        query_text = self.purchase_search.text().strip()
        session = get_session(get_engine())
        try:
            query = session.query(Purchase).join(Supplier, isouter=True)
            if query_text:
                query = query.filter(Purchase.invoice_no.ilike(f"%{query_text}%"))
            purchases = query.order_by(Purchase.created_at.desc()).all()
            self.purchase_table.setRowCount(0)
            for row, p in enumerate(purchases):
                self.purchase_table.insertRow(row)
                # Display date as dd/mm/yy
                self.purchase_table.setItem(row, 0, QTableWidgetItem(p.created_at.strftime("%d/%m/%y")))
                self.purchase_table.setItem(row, 1, QTableWidgetItem(p.invoice_no))
                self.purchase_table.setItem(row, 2, QTableWidgetItem(p.supplier.name if p.supplier else "N/A"))
                self.purchase_table.setItem(row, 3, QTableWidgetItem(f"{p.total_amount:.2f}"))
        finally: session.close()

    def add_product_dialog(self):
        dialog = ProductDialog(self)
        if dialog.exec():
            self.load_products()
            # Notify other parts of app
            try:
                state.product_added.emit(0)  # 0 indicates unknown/new; consumers should refresh
            except Exception:
                pass

    def edit_product_dialog(self):
        row = self.table.currentRow()
        if row < 0: return
        sku = self.product_skus[row]
        session = get_session(get_engine())
        product = session.query(Product).filter_by(sku=sku).first()
        session.close()
        if product:
            dialog = ProductDialog(self, product=product)
            if dialog.exec():
                self.load_products()
                try:
                    state.product_updated.emit(product.id)
                except Exception:
                    pass

    def adjust_stock_dialog(self):
        row = self.table.currentRow()
        if row < 0: return
        sku = self.product_skus[row]
        from app.ui.stock_adjust_dialog import StockAdjustDialog
        session = get_session(get_engine())
        product = session.query(Product).filter_by(sku=sku).first()
        session.close()
        if product:
            dialog = StockAdjustDialog(self, product)
            if dialog.exec():
                self.load_products()
                try:
                    state.product_updated.emit(product.id)
                except Exception:
                    pass

    def delete_product(self):
        row = self.table.currentRow()
        if row < 0:
            QMessageBox.warning(self, _("Selection"), _("Select a product to delete."))
            return
        
        sku = self.product_skus[row]
        session = get_session(get_engine())
        try:
            product = session.query(Product).filter_by(sku=sku).first()
            if not product:
                return

            # Check for sales
            sale_count = session.query(SaleItem).filter_by(product_id=product.id).count()
            if sale_count > 0:
                QMessageBox.warning(self, _("Cannot Delete"), _("This product has sales history and cannot be deleted."))
                return

            # Confirm deletion
            confirm = QMessageBox.question(self, _("Confirm Delete"), 
                                         f"{_('Are you sure you want to delete')} {product.name}?",
                                         QMessageBox.Yes | QMessageBox.No)
            
            if confirm == QMessageBox.Yes:
                # Delete stock movements first
                session.query(StockMovement).filter_by(product_id=product.id).delete()
                # Delete product
                session.delete(product)
                session.commit()
                
                self.load_products()
                try:
                    state.product_deleted.emit(product.id)
                except Exception:
                    pass
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), f"Failed to delete product: {e}")
        finally:
            session.close()

    def add_supplier_dialog(self):
        dialog = SupplierDialog(self)
        if dialog.exec(): self.load_suppliers()

    def edit_supplier_dialog(self):
        row = self.supplier_table.currentRow()
        if row < 0: return
        sid = self.supplier_ids[row]
        session = get_session(get_engine())
        s = session.query(Supplier).get(sid)
        session.close()
        if s:
            dialog = SupplierDialog(self, supplier=s)
            if dialog.exec(): self.load_suppliers()

    def add_purchase_dialog(self):
        dialog = PurchaseDialog(self)
        if dialog.exec():
            self.load_purchases()
            self.load_products()
            try:
                state.product_updated.emit(0)
            except Exception:
                pass

    def on_product_changed(self, product_id=None):
        """Refresh product-related data in the UI."""
        self.load_products()
        self.load_suppliers()
        self.load_purchases()

    def on_metadata_changed(self, model_name):
        """Reload optical settings tables when metadata changes."""
        if hasattr(self, 'optical_tables'):
            # If model_name is provided, reload only that table
            if model_name and model_name in self.optical_tables:
                table, model_class = self.optical_tables[model_name]
                self._load_optical_tab_data(model_class, table)
            else:
                # Reload all
                for key, (table, model_class) in self.optical_tables.items():
                    self._load_optical_tab_data(model_class, table)

    def init_optical_settings_tab(self):
        """Create optical settings tab with lens types, contact lenses, frame types, and colors"""
        tab = QWidget()
        layout = QVBoxLayout(tab)

        # Header
        header = QHBoxLayout()
        title = QLabel("إعدادات خاصة بالعدسات والإطارات")
        title.setStyleSheet("font-size: 18px; font-weight: bold;")
        header.addWidget(title)
        layout.addLayout(header)

        # Sub-tabs for optical settings
        self.optical_tabs = QTabWidget()
        self.optical_tabs.setStyleSheet("QTabBar::tab { height: 35px; font-size: 14px; min-width: 120px; }")

        # Store references to tables for reloading
        self.optical_tables = {}

        # Add optical settings tabs
        self._init_optical_tab(self.optical_tabs, 'عدسات', LensType)
        self._init_optical_tab(self.optical_tabs, 'عدسات لاصقة', ContactLensType)
        self._init_optical_tab(self.optical_tabs, 'فريمات', FrameType)
        self._init_optical_tab(self.optical_tabs, 'ألوان الإطار', FrameColor)

        layout.addWidget(self.optical_tabs)
        self.tabs.addTab(tab, _("Optical Settings"))

    def _init_optical_tab(self, parent_tabs, label, model_class):
        """Initialize a single optical settings tab"""
        tab = QWidget()
        ly = QVBoxLayout()
        ly.setContentsMargins(15, 15, 15, 15)
        ly.setSpacing(15)

        table = QTableWidget(0, 1)
        table.setHorizontalHeaderLabels(["الاسم"])
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        table.setStyleSheet("font-size: 16px;")
        table.horizontalHeader().setStyleSheet("font-size: 16px; font-weight: bold;")
        ly.addWidget(table)
        
        # Store table reference
        self.optical_tables[model_class.__name__] = (table, model_class)

        # Buttons
        btns = QHBoxLayout()
        add_btn = QPushButton(_("إضافة") + " " + label)
        add_btn.setStyleSheet("font-size: 16px; font-weight: bold; background-color: #2e7d32; color: white;")
        add_btn.clicked.connect(lambda: self._add_optical_entry(model_class, table, label))
        btns.addWidget(add_btn)

        del_btn = QPushButton(_("حذف المحدد"))
        del_btn.setStyleSheet("font-size: 16px; background-color: #d32f2f; color: white;")
        del_btn.clicked.connect(lambda: self._delete_optical_entry(model_class, table))
        btns.addWidget(del_btn)
        ly.addLayout(btns)

        tab.setLayout(ly)
        parent_tabs.addTab(tab, label)

        # Load data
        self._load_optical_tab_data(model_class, table)

    def _load_optical_tab_data(self, model_class, table):
        """Load optical settings data into table"""
        session = get_session(get_engine())
        try:
            items = session.query(model_class).all()
            table.setRowCount(0)
            for row, item in enumerate(items):
                table.insertRow(row)
                table.setItem(row, 0, QTableWidgetItem(item.name))
        finally:
            session.close()

    def _add_optical_entry(self, model_class, table, label):
        """Add new optical settings entry"""
        name, ok = QInputDialog.getText(self, "إضافة عنصر", "الاسم:")
        if ok and name:
            session = get_session(get_engine())
            try:
                item = model_class(name=name)
                session.add(item)
                session.commit()
                self._load_optical_tab_data(model_class, table)
                # Emit metadata changed signal
                try:
                    state.metadata_changed.emit(model_class.__name__)
                except Exception:
                    pass
            finally:
                session.close()

    def _delete_optical_entry(self, model_class, table):
        """Delete selected optical settings entry"""
        row = table.currentRow()
        if row < 0:
            QMessageBox.warning(self, _("Selection"), _("Select an item to delete."))
            return

        item_name = table.item(row, 0).text()
        session = get_session(get_engine())
        try:
            item = session.query(model_class).filter_by(name=item_name).first()
            if item:
                session.delete(item)
                session.commit()
                self._load_optical_tab_data(model_class, table)
                # Emit metadata changed signal
                try:
                    state.metadata_changed.emit(model_class.__name__)
                except Exception:
                    pass
        finally:
            session.close()
