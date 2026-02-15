from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QTableWidget, 
    QTableWidgetItem, QHeaderView, QPushButton, QGroupBox, QFormLayout, QLineEdit, QMessageBox
)
from PySide6.QtCore import Qt, Signal
from app.database.db_manager import get_engine, get_session
from app.database.models import Customer, Sale, OrderExamination
from app.ui.invoice_detail_dialog import InvoiceDetailDialog
from app.core.i18n import _

class CustomerLookupDialog(QDialog):
    customer_updated = Signal()

    def __init__(self, customer_id, parent=None):
        super().__init__(parent)
        self.customer_id = customer_id
        self.setWindowTitle(_("Customer Details & History"))
        self.setMinimumSize(1000, 700)
        self.init_ui()
        self.load_data()

    def init_ui(self):
        layout = QVBoxLayout(self)
        
        # Customer Info Section
        info_group = QGroupBox(_("Customer Information"))
        info_group.setStyleSheet("font-size: 16px; font-weight: bold;")
        self.info_form = QFormLayout(info_group)
        
        self.name_edit = QLineEdit(); self.name_edit.setMinimumHeight(40)
        self.phone_edit = QLineEdit(); self.phone_edit.setMinimumHeight(40)
        self.phone2_edit = QLineEdit(); self.phone2_edit.setMinimumHeight(40)
        self.city_edit = QLineEdit(); self.city_edit.setMinimumHeight(40)
        self.address_edit = QLineEdit(); self.address_edit.setMinimumHeight(40)
        
        self.info_form.addRow(_("Name") + ":", self.name_edit)
        self.info_form.addRow(_("Mobile Phone") + ":", self.phone_edit)
        self.info_form.addRow(_("Secondary Phone") + ":", self.phone2_edit)
        self.info_form.addRow(_("City") + ":", self.city_edit)
        self.info_form.addRow(_("Address") + ":", self.address_edit)
        
        save_cust_btn = QPushButton(_("Save Customer Details"))
        save_cust_btn.setMinimumHeight(45)
        save_cust_btn.setStyleSheet("background-color: #2e7d32; color: white;")
        save_cust_btn.clicked.connect(self.save_customer)
        self.info_form.addRow(save_cust_btn)
        
        layout.addWidget(info_group)
        
        # Sales History Section
        history_group = QGroupBox(_("Sales History (Preorders)"))
        history_group.setStyleSheet("font-size: 16px; font-weight: bold;")
        history_layout = QVBoxLayout(history_group)
        
        self.sales_table = QTableWidget(0, 5)
        self.sales_table.setLayoutDirection(Qt.LeftToRight)
        self.sales_table.setHorizontalHeaderLabels([_("Date"), _("Invoice"), _("Total"), _("Status"), _("Action")])
        self.sales_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.sales_table.setStyleSheet("font-size: 16px; font-weight: normal;")
        history_layout.addWidget(self.sales_table)
        
        layout.addWidget(history_group)
        
        close_btn = QPushButton(_("Close"))
        close_btn.setMinimumHeight(45)
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)

    def load_data(self):
        session = get_session(get_engine())
        try:
            customer = session.query(Customer).get(self.customer_id)
            if not customer: return
            
            self.name_edit.setText(customer.name)
            self.phone_edit.setText(customer.phone or "")
            self.phone2_edit.setText(customer.phone2 or "")
            self.city_edit.setText(customer.city or "")
            self.address_edit.setText(customer.address or "")
            
            sales = session.query(Sale).filter_by(customer_id=self.customer_id).order_by(Sale.order_date.desc()).all()
            self.sales_table.setRowCount(0)
            for row, s in enumerate(sales):
                self.sales_table.insertRow(row)
                self.sales_table.setItem(row, 0, QTableWidgetItem(s.order_date.strftime("%d/%m/%y %H:%M") if s.order_date else ""))
                self.sales_table.setItem(row, 1, QTableWidgetItem(s.invoice_no))
                self.sales_table.setItem(row, 2, QTableWidgetItem(f"{s.net_amount:.2f}"))
                
                status = _("Received") if s.is_received else _("Pending")
                status_item = QTableWidgetItem(status)
                if not s.is_received: status_item.setForeground(Qt.red)
                self.sales_table.setItem(row, 3, status_item)
                
                details_btn = QPushButton(_("Details"))
                details_btn.clicked.connect(lambda checked, sid=s.id: self.show_invoice_details(sid))
                self.sales_table.setCellWidget(row, 4, details_btn)
                
        finally:
            session.close()

    def save_customer(self):
        session = get_session(get_engine())
        try:
            customer = session.query(Customer).get(self.customer_id)
            customer.name = self.name_edit.text()
            customer.phone = self.phone_edit.text()
            customer.phone2 = self.phone2_edit.text()
            customer.city = self.city_edit.text()
            customer.address = self.address_edit.text()
            session.commit()
            QMessageBox.information(self, _("Success"), _("Customer details updated successfully."))
            self.customer_updated.emit()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), str(e))
        finally:
            session.close()

    def show_invoice_details(self, sale_id):
        dialog = InvoiceDetailDialog(sale_id, self)
        dialog.exec()
