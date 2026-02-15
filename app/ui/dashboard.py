# app/ui/dashboard.py
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, QGridLayout, QLineEdit, QMessageBox
)
from PySide6.QtCore import Qt, Signal
from app.core.i18n import _
from app.core.permissions import has_permission
from app.database.db_manager import get_engine, get_session
from app.database.models import Sale, Customer, Product

class Dashboard(QWidget):
    # Signals to notify MainWindow to change view
    nav_to_pos = Signal()
    nav_to_inventory = Signal()
    nav_to_history = Signal()
    nav_to_lab = Signal()
    nav_to_reports = Signal()
    nav_to_customers = Signal()
    nav_to_staff = Signal()
    nav_to_settings = Signal()
    logout_requested = Signal()
    
    # New signals for direct lookup results
    show_invoice_detail = Signal(int) # sale_id
    show_customer_detail = Signal(int) # customer_id
    show_product_detail = Signal(int) # product_id

    def __init__(self, user):
        super().__init__()
        self.user = user
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(100, 50, 100, 50)
        layout.setSpacing(20)

        # Welcome Header
        header = QLabel(f"{_('Welcome,')} {self.user.full_name}")
        header.setStyleSheet("font-size: 42px; font-weight: bold; margin-bottom: 20px;")
        header.setAlignment(Qt.AlignCenter)
        layout.addWidget(header)

        role_name = self.user.role.name if self.user.role else _('No Role')
        role_label = QLabel(f"{_('Role:')} {role_name}")
        role_label.setStyleSheet("font-size: 24px; color: gray; margin-bottom: 40px;")
        role_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(role_label)

        # Quick Lookup
        lookup_hb = QHBoxLayout()
        lookup_hb.setContentsMargins(100, 0, 100, 0)
        self.lookup_input = QLineEdit()
        self.lookup_input.setPlaceholderText(_("Quick Lookup: Invoice #, Customer ID/Name, or Barcode"))
        self.lookup_input.setMinimumHeight(80)
        self.lookup_input.setStyleSheet("font-size: 24px; border-radius: 15px; padding: 15px; border: 2px solid #1976d2;")
        self.lookup_input.returnPressed.connect(self.perform_lookup)
        lookup_hb.addWidget(self.lookup_input)
        
        lookup_btn = QPushButton(_("Search"))
        lookup_btn.setMinimumHeight(80)
        lookup_btn.setStyleSheet("background-color: #1976d2; color: white; font-weight: bold; font-size: 22px; border-radius: 15px; padding: 0 30px;")
        lookup_btn.clicked.connect(self.perform_lookup)
        lookup_hb.addWidget(lookup_btn)
        layout.addLayout(lookup_hb)

        # Grid of buttons
        grid = QGridLayout()
        grid.setSpacing(30)
        grid.setContentsMargins(10, 30, 10, 30)

        session = get_session(get_engine())
        can_create_sale, _v = has_permission(session, self.user.id, "CREATE_SALE")
        can_view_inventory, _v = has_permission(session, self.user.id, "VIEW_PRODUCTS")
        can_view_customers, _v = has_permission(session, self.user.id, "VIEW_PRESCRIPTIONS")
        can_view_lab, _v = has_permission(session, self.user.id, "VIEW_LAB")
        can_manage_users, _v = has_permission(session, self.user.id, "MANAGE_USERS")
        can_manage_settings, _v = has_permission(session, self.user.id, "MANAGE_SETTINGS")
        can_view_reports, _v = has_permission(session, self.user.id, "REPORT_DAILY_SALES")
        session.close()

        row, col = 0, 0
        if can_create_sale:
            self.pos_btn = self.create_nav_button(_("Sales POS"), "#1976d2", self.nav_to_pos)
            grid.addWidget(self.pos_btn, row, col)
            col += 1
            if col > 1: row += 1; col = 0

        if can_view_inventory:
            self.inv_btn = self.create_nav_button(_("Inventory"), "#2e7d32", self.nav_to_inventory)
            grid.addWidget(self.inv_btn, row, col)
            col += 1
            if col > 1: row += 1; col = 0

        self.history_btn = self.create_nav_button(_("Sales History"), "#f57c00", self.nav_to_history)
        grid.addWidget(self.history_btn, row, col)
        col += 1
        if col > 1: row += 1; col = 0

        if can_view_lab:
            self.lab_btn = self.create_nav_button(_("Lab Management"), "#607d8b", self.nav_to_lab)
            grid.addWidget(self.lab_btn, row, col)
            col += 1
            if col > 1: row += 1; col = 0

        if can_view_reports:
            self.reports_btn = self.create_nav_button(_("Reports"), "#7b1fa2", self.nav_to_reports)
            grid.addWidget(self.reports_btn, row, col)
            col += 1
            if col > 1: row += 1; col = 0

        if can_view_customers:
            self.customers_btn = self.create_nav_button(_("Customers (CRM)"), "#009688", self.nav_to_customers)
            grid.addWidget(self.customers_btn, row, col)
            col += 1
            if col > 1: row += 1; col = 0

        if can_manage_users:
            self.staff_btn = self.create_nav_button(_("Staff Management"), "#455a64", self.nav_to_staff)
            grid.addWidget(self.staff_btn, row, col)

        layout.addLayout(grid)
        layout.addStretch()

        # Footer with Settings and Logout
        footer = QHBoxLayout()
        
        # Cloud Status Indicator
        self.cloud_status = QLabel(_("Cloud Access: Active 🌐"))
        self.cloud_status.setStyleSheet("color: #2e7d32; font-weight: bold; font-size: 18px; margin-left: 10px;")
        footer.addWidget(self.cloud_status)
        
        footer.addStretch()

        if can_manage_settings:

            self.settings_btn = QPushButton(_("Settings"))
            self.settings_btn.setMinimumSize(200, 60)
            self.settings_btn.setStyleSheet("""
                QPushButton {
                    background-color: #455a64;
                    color: white;
                    font-size: 18px;
                    font-weight: bold;
                    border-radius: 5px;
                }
                QPushButton:hover {
                    background-color: #546e7a;
                }
            """)
            self.settings_btn.clicked.connect(self.nav_to_settings.emit)
            footer.addWidget(self.settings_btn)
            footer.addSpacing(15)

        logout_btn = QPushButton(_("Logout"))
        logout_btn.setMinimumSize(200, 60)
        logout_btn.setStyleSheet("""
            QPushButton {
                background-color: #d32f2f;
                color: white;
                font-size: 18px;
                font-weight: bold;
                border-radius: 5px;
            }
            QPushButton:hover {
                background-color: #e53935;
            }
        """)
        logout_btn.clicked.connect(self.logout_requested.emit)
        footer.addWidget(logout_btn)

        layout.addLayout(footer)

        self.setLayout(layout)

    def create_nav_button(self, text, color, signal):
        btn = QPushButton(text)
        btn.setMinimumSize(350, 200)
        btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {color};
                color: white;
                font-size: 32px;
                font-weight: bold;
                border-radius: 20px;
                padding: 20px;
            }}
            QPushButton:hover {{
                background-color: {self.lighten_color(color)};
            }}
        """)
        btn.clicked.connect(signal.emit)
        return btn

    def lighten_color(self, hex_color):
        # Very simple lighten for hover effect
        return hex_color # Could implement real logic if needed

    def perform_lookup(self):
        val = self.lookup_input.text().strip()
        if not val: return
        
        session = get_session(get_engine())
        try:
            results = []
            
            # 1. Check Invoice No
            sales = session.query(Sale).filter(Sale.invoice_no.ilike(f"%{val}%")).all()
            for s in sales:
                results.append({'type': 'sale', 'id': s.id, 'details': f"{_('Invoice')}: {s.invoice_no} ({s.customer.name if s.customer else 'N/A'})"})

            # 2. Check Customer ID, Name or Phone
            cust_query = session.query(Customer).filter(
                (Customer.phone.ilike(f"%{val}%")) | 
                (Customer.phone2.ilike(f"%{val}%")) | 
                (Customer.name.ilike(f"%{val}%"))
            )
            if val.isdigit():
                cust_by_id = session.query(Customer).get(int(val))
                if cust_by_id and cust_by_id not in cust_query.all():
                    results.append({'type': 'customer', 'id': cust_by_id.id, 'details': f"{_('Customer')} ID {cust_by_id.id}: {cust_by_id.name}"})

            for c in cust_query.all():
                results.append({'type': 'customer', 'id': c.id, 'details': f"{_('Customer')}: {c.name} ({c.phone})"})

            # 3. Check Product Barcode, SKU or Name
            prods = session.query(Product).filter(
                (Product.barcode.ilike(f"%{val}%")) | 
                (Product.sku.ilike(f"%{val}%")) |
                (Product.name.ilike(f"%{val}%"))
            ).all()
            for p in prods:
                results.append({'type': 'product', 'id': p.id, 'details': f"{_('Product')}: {p.name} ({p.barcode or p.sku or 'N/A'})"})

            if not results:
                QMessageBox.information(self, _("Lookup"), _("No matching record found."))
                return

            if len(results) == 1:
                self.handle_lookup_result(results[0]['type'], results[0]['id'])
            else:
                from app.ui.search_results_dialog import SearchResultsDialog
                dialog = SearchResultsDialog(results, self)
                dialog.result_selected.connect(self.handle_lookup_result)
                dialog.exec()
                
        finally:
            session.close()

    def handle_lookup_result(self, r_type, r_id):
        if r_type == 'sale':
            from app.ui.invoice_detail_dialog import InvoiceDetailDialog
            dialog = InvoiceDetailDialog(r_id, self)
            dialog.exec()
        elif r_type == 'customer':
            from app.ui.customer_lookup_dialog import CustomerLookupDialog
            dialog = CustomerLookupDialog(r_id, self)
            dialog.exec()
        elif r_type == 'product':
            from app.ui.product_dialog import ProductDialog
            session = get_session(get_engine())
            prod = session.query(Product).get(r_id)
            session.close()
            if prod:
                dialog = ProductDialog(self, product=prod)
                dialog.exec()
