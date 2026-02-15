# app/ui/history_window.py
import datetime
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem, 
    QPushButton, QLabel, QHeaderView, QMessageBox, QGridLayout, QLineEdit
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import Sale, Customer
from app.ui.invoice_detail_dialog import InvoiceDetailDialog
from app.core.i18n import _

class SalesHistoryWindow(QWidget):
    def __init__(self, user, back_callback):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
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

        title = QLabel(_("Sales History & Invoices"))
        title.setStyleSheet("font-size: 36px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        
        layout.addLayout(header_layout)

        # Search and Sort
        top_bar = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText(_("Search by Customer Name, Phone or Invoice..."))
        self.search_input.setMinimumHeight(65)
        self.search_input.setStyleSheet("font-size: 22px; padding: 10px;")
        self.search_input.textChanged.connect(self.load_data)
        top_bar.addWidget(self.search_input)

        layout.addLayout(top_bar)

        # Table
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels([_("Date"), _("Invoice"), _("Customer"), _("Total after discount"), _("Status"), _("Action")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.table.setStyleSheet("font-size: 20px;")
        self.table.setSortingEnabled(True)
        layout.addWidget(self.table)

        self.setLayout(layout)

    def refresh_data(self):
        """Refresh all sales history data - called automatically when sales change"""
        self.apply_filter(None)

    def apply_filter(self, filters):
        """Apply external filters (from reports) and refresh"""
        self.external_filters = filters
        self.load_data()

    def load_data(self):
        query_text = self.search_input.text().strip()
        # Removed manual sort controls; rely on table header sorting
        session = get_session(get_engine())
        try:
            query = session.query(Sale).join(Customer, isouter=True)
            if query_text:
                query = query.filter(
                    (Sale.invoice_no.ilike(f"%{query_text}%")) |
                    (Customer.name.ilike(f"%{query_text}%")) |
                    (Customer.phone.ilike(f"%{query_text}%"))
                )
            
            # Apply external filters if any
            if hasattr(self, 'external_filters') and self.external_filters:
                start_date = self.external_filters.get('start_date')
                user_id = self.external_filters.get('user_id')
                if start_date:
                    query = query.filter(Sale.order_date >= start_date)
                if user_id:
                    query = query.filter(Sale.user_id == user_id)
                    
            # Default sort: newest first
            query = query.order_by(Sale.order_date.desc())

            sales = query.all()
            self.table.setSortingEnabled(False)
            self.table.setRowCount(0)
            for row_idx, s in enumerate(sales):
                self.table.insertRow(row_idx)
                
                date_item = QTableWidgetItem(s.order_date.strftime("%d/%m/%Y م %H:%M") if s.order_date else "")
                date_item.setData(Qt.UserRole, s.order_date)
                self.table.setItem(row_idx, 0, date_item)
                
                self.table.setItem(row_idx, 1, QTableWidgetItem(s.invoice_no))
                self.table.setItem(row_idx, 2, QTableWidgetItem(s.customer.name if s.customer else "N/A"))
                
                total_item = QTableWidgetItem(f"{s.net_amount:.2f}")
                total_item.setData(Qt.DisplayRole, s.net_amount)
                self.table.setItem(row_idx, 3, total_item)
                
                # Show Lab Status if available
                status_map = {
                    'Not Started': 'لم يبدأ',
                    'In Lab': 'قيد العمل',
                    'Ready': 'جاهز',
                    'Received': 'استلم'
                }
                status_code = s.lab_status or ('Received' if s.is_received else 'Not Started')
                status_label = status_map.get(status_code, status_code)
                status_item = QTableWidgetItem(status_label)
                status_item.setData(Qt.UserRole, status_code)
                if status_code == 'Ready':
                    status_item.setForeground(Qt.blue)
                elif status_code == 'In Lab':
                    status_item.setForeground(Qt.darkYellow)
                elif status_code == 'Received':
                    status_item.setForeground(Qt.green)
                else:
                    status_item.setForeground(Qt.red)
                self.table.setItem(row_idx, 4, status_item)
                
                view_btn = QPushButton(_("Details"))
                view_btn.clicked.connect(lambda checked, sid=s.id: self.view_invoice_details(sid))
                self.table.setCellWidget(row_idx, 5, view_btn)
            self.table.setSortingEnabled(True)
        finally:
            session.close()

    def view_invoice_details(self, sale_id):
        dialog = InvoiceDetailDialog(sale_id, self)
        dialog.exec()

    def mark_as_received(self, sale_id):
        session = get_session(get_engine())
        try:
            sale = session.query(Sale).get(sale_id)
            sale.is_received = True
            sale.receiving_date = datetime.datetime.utcnow()
            session.commit()
            QMessageBox.information(self, _("Success"), _("Order marked as received."))
            self.load_data()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), str(e))
        finally:
            session.close()

