# app/ui/customer_window.py
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem, 
    QPushButton, QLabel, QHeaderView, QMessageBox, QLineEdit, QGridLayout
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import Customer, Prescription
from app.core.i18n import _

class CustomerWindow(QWidget):
    def __init__(self, user, back_callback):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
        self.customer_ids = []  # Initialize list to store customer IDs
        self.init_ui()
        self.load_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(15)

        # Header
        header = QGridLayout()
        back_btn = QPushButton(_("← Back to Dashboard"))
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header.addWidget(back_btn, 0, 0, Qt.AlignLeft)

        title = QLabel(_("Customer Management"))
        title.setStyleSheet("font-size: 36px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        
        add_btn = QPushButton(_("+ Add")) # Simplified to Add
        add_btn.setMinimumHeight(45)
        add_btn.setStyleSheet("font-size: 16px; font-weight: bold; background-color: #2e7d32; color: white;")
        add_btn.clicked.connect(self.add_customer)
        header.addWidget(add_btn, 0, 2, Qt.AlignRight)
        layout.addLayout(header)

        # Search
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText(_("Search by name, phone, city..."))
        self.search_input.setMinimumHeight(65)
        self.search_input.setStyleSheet("font-size: 22px; padding: 10px; border-radius: 10px;")
        self.search_input.textChanged.connect(self.load_data)
        layout.addWidget(self.search_input)

        # Table
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels([_("Name"), _("Mobile Phone"), _("Second Number"), _("City"), _("Prescriptions")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.table.setStyleSheet("font-size: 20px;")
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        layout.addWidget(self.table)

        # Actions
        actions = QHBoxLayout()
        edit_btn = QPushButton(_("Details"))
        edit_btn.setMinimumHeight(60)
        edit_btn.setStyleSheet("font-size: 20px; font-weight: bold; background-color: #1976d2; color: white; border-radius: 10px;")
        edit_btn.clicked.connect(self.edit_customer)
        actions.addWidget(edit_btn)

        rx_btn = QPushButton(_("Prescriptions"))
        rx_btn.setMinimumHeight(60)
        rx_btn.setStyleSheet("font-size: 20px; font-weight: bold; background-color: #607d8b; color: white; border-radius: 10px;")
        rx_btn.clicked.connect(self.manage_prescriptions)
        actions.addWidget(rx_btn)
        
        layout.addLayout(actions)
        self.setLayout(layout)

    def refresh_data(self):
        """Refresh all customer data - called automatically when customers change"""
        self.load_data()

    def load_data(self):
        query_text = self.search_input.text().strip()
        session = get_session(get_engine())
        try:
            query = session.query(Customer)
            if query_text:
                query = query.filter(
                    (Customer.name.ilike(f"%{query_text}%")) | 
                    (Customer.phone.ilike(f"%{query_text}%")) |
                    (Customer.phone2.ilike(f"%{query_text}%")) |
                    (Customer.city.ilike(f"%{query_text}%")) |
                    (Customer.address.ilike(f"%{query_text}%"))
                )
            
            customers = query.all()
            self.table.setRowCount(0)
            self.customer_ids = []
            for row_idx, c in enumerate(customers):
                self.table.insertRow(row_idx)
                self.table.setItem(row_idx, 0, QTableWidgetItem(c.name))
                self.table.setItem(row_idx, 1, QTableWidgetItem(c.phone or ""))
                self.table.setItem(row_idx, 2, QTableWidgetItem(c.phone2 or ""))
                self.table.setItem(row_idx, 3, QTableWidgetItem(c.city or ""))
                
                from app.database.models import OrderExamination, Sale
                rx_count = session.query(Prescription).filter_by(customer_id=c.id).count()
                pos_orders_count = session.query(Sale).filter_by(customer_id=c.id).join(OrderExamination).distinct().count()
                
                total_records = rx_count + pos_orders_count
                self.table.setItem(row_idx, 4, QTableWidgetItem(f"{total_records} سجلات"))
                self.customer_ids.append(c.id)
        finally:
            session.close()

    def add_customer(self):
        from app.ui.customer_dialog import CustomerDialog
        dialog = CustomerDialog(self)
        if dialog.exec():
            self.load_data()

    def edit_customer(self):
        row = self.table.currentRow()
        if row < 0:
            QMessageBox.warning(self, _("Selection"), _("Select a customer to edit."))
            return
        
        customer_id = self.customer_ids[row]
        session = get_session(get_engine())
        customer = session.query(Customer).get(customer_id)
        session.close()

        if customer:
            from app.ui.customer_dialog import CustomerDialog
            dialog = CustomerDialog(self, customer=customer)
            if dialog.exec():
                self.load_data()

    def manage_prescriptions(self):
        row = self.table.currentRow()
        if row < 0:
            QMessageBox.warning(self, _("Selection"), _("Select a customer."))
            return

        if row >= len(self.customer_ids):
            QMessageBox.warning(self, _("Selection"), _("Invalid customer selected."))
            return

        session = get_session(get_engine())
        try:
            from app.core.permissions import has_permission
            allowed, _v = has_permission(session, self.user.id, "VIEW_PRESCRIPTIONS")

            if not allowed:
                QMessageBox.warning(self, _("Permission Denied"), _("You do not have permission to view prescriptions."))
                return

            customer_id = self.customer_ids[row]
            customer = session.query(Customer).get(customer_id)
            if customer:
                # Detach from session before passing to window
                session.expunge(customer)
                from app.ui.prescription_window import PrescriptionWindow
                self.rx_win = PrescriptionWindow(customer)
                self.rx_win.show()
        finally:
            session.close()

