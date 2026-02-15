# app/ui/side_navigation.py
import subprocess
import logging
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, QFrame,
                               QLineEdit, QListWidget, QListWidgetItem)
from PySide6.QtCore import Qt, Signal
from app.core.i18n import _
from app.database.db_manager import get_engine, session_scope
from app.core.permissions import has_permission
from app.database.models import Customer, Product

logger = logging.getLogger(__name__)

class TopNavigation(QWidget):
    nav_requested = Signal(str) # 'dashboard', 'pos', 'inventory', etc.
    customer_selected = Signal(int)  # Emit customer ID
    product_selected = Signal(int)   # Emit product ID

    def __init__(self, user):
        super().__init__()
        self.user = user
        self.init_ui()

    def init_ui(self):
        self.setFixedHeight(100)
        self.setStyleSheet("""
            QWidget {
                background-color: #1a237e;
                color: white;
            }
            QPushButton {
                background-color: transparent;
                color: white;
                padding: 10px 20px;
                font-size: 18px;
                border: none;
                border-radius: 0px;
                min-width: 120px;
            }
            QPushButton:hover {
                background-color: #283593;
            }
            QPushButton[active="true"] {
                background-color: #3f51b5;
                border-bottom: 4px solid #ffeb3b;
            }
            QLabel#AppTitle {
                font-size: 28px;
                font-weight: bold;
                color: #ffeb3b;
                min-width: 250px;
            }
            QFrame#Separator {
                background-color: #3949ab;
                height: 3px;
            }
            QLineEdit {
                padding: 10px 15px;
                border: 1px solid #3949ab;
                border-radius: 6px;
                background-color: #0d47a1;
                color: white;
                font-size: 18px;
            }
            QLineEdit::placeholder {
                color: #90caf9;
            }
            QListWidget {
                background-color: #1a237e;
                border: 1px solid #3949ab;
                color: white;
            }
            QListWidget::item:hover {
                background-color: #283593;
            }
            QListWidget::item:selected {
                background-color: #3f51b5;
            }
        """)

        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # Top bar with title and nav buttons
        top_bar = QHBoxLayout()
        top_bar.setContentsMargins(0, 0, 0, 0)
        top_bar.setSpacing(0)

        title = QLabel(_("Optical Shop"))
        title.setObjectName("AppTitle")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        top_bar.addWidget(title)


        self.buttons = {}
        
        # permission checks using session_scope
        engine = get_engine()
        with session_scope(engine) as session:
            can_create_sale, _v = has_permission(session, self.user.id, "CREATE_SALE")
            can_view_products, _v = has_permission(session, self.user.id, "VIEW_PRODUCTS")
            can_view_prescriptions, _v = has_permission(session, self.user.id, "VIEW_PRESCRIPTIONS")
            can_view_reports, _v = has_permission(session, self.user.id, "REPORT_DAILY_SALES")
            can_view_lab, _v = has_permission(session, self.user.id, "VIEW_LAB")
            can_manage_users, _v = has_permission(session, self.user.id, "MANAGE_USERS")
            can_manage_settings, _v = has_permission(session, self.user.id, "MANAGE_SETTINGS")

        nav_items = [("dashboard", _("Dashboard"))]
        
        if can_create_sale:
            nav_items.append(("pos", _("POS")))

        if can_view_products:
            nav_items.append(("inventory", _("Inventory")))
            
        if can_view_prescriptions:
            nav_items.append(("customers", _("Customers")))

        nav_items.append(("history", _("History")))

        if can_view_lab:
            nav_items.append(("lab", _("Lab")))

        if can_view_reports:
            nav_items.append(("reports", _("Reports")))

        # Add admin items
        if can_manage_users:
            nav_items.append(("staff", _("Staff")))

        if can_manage_settings:
            nav_items.append(("settings", _("Settings")))

        for key, label in nav_items:
            btn = QPushButton(label)
            btn.clicked.connect(lambda checked, k=key: self.on_nav_click(k))
            top_bar.addWidget(btn)
            self.buttons[key] = btn

        # Spacer
        top_bar.addStretch()

        # Calculator Button
        calc_btn = QPushButton("🖩")
        calc_btn.setStyleSheet("font-size: 28px;")
        calc_btn.setMaximumWidth(50)
        calc_btn.clicked.connect(self.open_calculator)
        top_bar.addWidget(calc_btn)

        # User info
        user_info = QLabel(f"{self.user.username}")
        user_info.setStyleSheet("padding: 0px 15px; font-size: 12px; color: #c5cae9;")
        top_bar.addWidget(user_info)

        # Logout Button
        logout_btn = QPushButton(_("Logout"))
        logout_btn.clicked.connect(lambda: self.on_nav_click('logout'))
        top_bar.addWidget(logout_btn)
        self.buttons['logout'] = logout_btn

        main_layout.addLayout(top_bar)

        # Separator
        sep = QFrame()
        sep.setObjectName("Separator")
        sep.setFixedHeight(2)
        main_layout.addWidget(sep)

        # Quick lookup bar (visible on non-dashboard screens)
        lookup_bar = QHBoxLayout()
        lookup_bar.setContentsMargins(10, 5, 10, 5)
        lookup_bar.setSpacing(10)

        lookup_label = QLabel(_("Quick Lookup:"))
        lookup_label.setStyleSheet("color: #c5cae9; font-size: 12px;")
        lookup_bar.addWidget(lookup_label)

        self.quick_search = QLineEdit()
        self.quick_search.setPlaceholderText(_("Search customer, product or invoice..."))
        self.quick_search.setMaximumWidth(300)
        self.quick_search.textChanged.connect(self.on_quick_search_change)
        self.quick_search.returnPressed.connect(self.on_quick_search_return)
        lookup_bar.addWidget(self.quick_search)

        self.search_results = QListWidget()
        self.search_results.setMaximumHeight(150)
        self.search_results.itemClicked.connect(self.on_search_result_clicked)
        self.search_results.hide()
        lookup_bar.addWidget(self.search_results)

        lookup_bar.addStretch()

        self.quick_lookup_container = QWidget()
        self.quick_lookup_container.setLayout(lookup_bar)
        # Show quick lookup by default so it's always accessible from the top nav
        self.quick_lookup_container.show()
        main_layout.addWidget(self.quick_lookup_container)

        self.setLayout(main_layout)

    def show_quick_lookup(self):
        """Show quick lookup bar"""
        self.quick_lookup_container.show()

    def hide_quick_lookup(self):
        """Hide quick lookup bar"""
        self.quick_lookup_container.hide()
        self.search_results.hide()

    def on_quick_search_change(self, text):
        """Handle quick search input for live results dropdown"""
        if not text or len(text) < 2:
            self.search_results.hide()
            return

        self.search_results.clear()
        engine = get_engine()
        with session_scope(engine) as session:
            from app.database.models import Sale
            
            # Search customers
            customers = session.query(Customer).filter(
                (Customer.name.ilike(f"%{text}%")) |
                (Customer.phone.ilike(f"%{text}%"))
            ).limit(5).all()

            for customer in customers:
                item = QListWidgetItem(f"👤 {customer.name} ({customer.phone})")
                item.setData(Qt.ItemDataRole.UserRole, ('customer', customer.id))
                self.search_results.addItem(item)

            # Search products
            products = session.query(Product).filter(
                (Product.name.ilike(f"%{text}%")) |
                (Product.barcode.ilike(f"%{text}%"))
            ).limit(5).all()

            for product in products:
                item = QListWidgetItem(f"📦 {product.name} ({product.barcode or product.sku or ''})")
                item.setData(Qt.ItemDataRole.UserRole, ('product', product.id))
                self.search_results.addItem(item)
                
            # Search Invoices
            sales = session.query(Sale).filter(Sale.invoice_no.ilike(f"%{text}%")).limit(5).all()
            for sale in sales:
                item = QListWidgetItem(f"📄 {_('Invoice')}: {sale.invoice_no}")
                item.setData(Qt.ItemDataRole.UserRole, ('sale', sale.id))
                self.search_results.addItem(item)

        if self.search_results.count() > 0:
            self.search_results.show()
        else:
            self.search_results.hide()

    def on_quick_search_return(self):
        """Handle Enter key in quick search"""
        text = self.quick_search.text().strip()
        if not text: return
        
        from app.database.models import Sale
        engine = get_engine()
        results = []
        with session_scope(engine) as session:
            # 1. Check Invoice
            sales = session.query(Sale).filter(Sale.invoice_no.ilike(f"%{text}%")).all()
            for s in sales:
                results.append({'type': 'sale', 'id': s.id, 'details': f"{_('Invoice')}: {s.invoice_no}"})
            
            # 2. Customers
            custs = session.query(Customer).filter(
                (Customer.name.ilike(f"%{text}%")) | 
                (Customer.phone.ilike(f"%{text}%")) |
                (Customer.phone2.ilike(f"%{text}%"))
            ).all()
            if text.isdigit():
                c_by_id = session.query(Customer).get(int(text))
                if c_by_id and c_by_id not in custs:
                    results.append({'type': 'customer', 'id': c_by_id.id, 'details': f"{_('Customer')} ID {c_by_id.id}: {c_by_id.name}"})

            for c in custs:
                results.append({'type': 'customer', 'id': c.id, 'details': f"{_('Customer')}: {c.name} ({c.phone})"})
            
            # 3. Products
            prods = session.query(Product).filter(
                (Product.name.ilike(f"%{text}%")) | 
                (Product.barcode.ilike(f"%{text}%")) |
                (Product.sku.ilike(f"%{text}%"))
            ).all()
            for p in prods:
                results.append({'type': 'product', 'id': p.id, 'details': f"{_('Product')}: {p.name}"})

        if not results:
            return
            
        if len(results) == 1:
            self.handle_search_result(results[0]['type'], results[0]['id'])
        else:
            from app.ui.search_results_dialog import SearchResultsDialog
            dialog = SearchResultsDialog(results, self)
            dialog.result_selected.connect(self.handle_search_result)
            dialog.exec()

    def handle_search_result(self, s_type, s_id):
        if s_type == 'customer':
            from app.ui.customer_lookup_dialog import CustomerLookupDialog
            dialog = CustomerLookupDialog(s_id, self)
            dialog.exec()
        elif s_type == 'product':
            self.product_selected.emit(s_id)
        elif s_type == 'sale':
            from app.ui.invoice_detail_dialog import InvoiceDetailDialog
            dialog = InvoiceDetailDialog(s_id, self)
            dialog.exec()
        
        self.search_results.hide()
        self.quick_search.clear()

    def on_search_result_clicked(self, item):
        """Handle search result selection from the dropdown list"""
        data = item.data(Qt.ItemDataRole.UserRole)
        if data:
            search_type, search_id = data
            self.handle_search_result(search_type, search_id)

    def on_nav_click(self, key):
        self.nav_requested.emit(key)

    def open_calculator(self):
        try:
            subprocess.Popen('calc.exe')
        except Exception as e:
            logger.exception('Error opening calculator')

    def set_active(self, key):
        for k, btn in self.buttons.items():
            btn.setProperty("active", k == key)
            btn.style().unpolish(btn)
            btn.style().polish(btn)
