# app/ui/customer_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QFormLayout, QLineEdit, 
    QTextEdit, QPushButton, QHBoxLayout, QMessageBox, QLabel
)
from app.database.db_manager import get_engine, get_session
from app.database.models import Customer
from app.core.i18n import _

class CustomerDialog(QDialog):
    def __init__(self, parent=None, customer=None):
        super().__init__(parent)
        self.customer = customer
        self.setWindowTitle(_("Customer Management"))
        self.setMinimumWidth(600)
        self.init_ui()
        if self.customer:
            self.load_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(30, 30, 30, 30)
        layout.setSpacing(15)
        
        form = QFormLayout()
        form.setSpacing(10)
        
        input_style = "font-size: 16px; height: 35px;"
        lbl_style = "font-size: 16px; font-weight: bold;"
        
        self.name_input = QLineEdit()
        self.name_input.setStyleSheet(input_style)
        l1 = QLabel(_("Name") + ":"); l1.setStyleSheet(lbl_style)
        form.addRow(l1, self.name_input)

        self.phone_input = QLineEdit()
        self.phone_input.setStyleSheet(input_style)
        l2 = QLabel(_("Mobile Phone") + ":"); l2.setStyleSheet(lbl_style)
        form.addRow(l2, self.phone_input)

        self.phone2_input = QLineEdit()
        self.phone2_input.setStyleSheet(input_style)
        l3 = QLabel(_("Second Number") + ":"); l3.setStyleSheet(lbl_style)
        form.addRow(l3, self.phone2_input)

        self.city_input = QLineEdit()
        self.city_input.setStyleSheet(input_style)
        l4 = QLabel(_("City Name") + ":"); l4.setStyleSheet(lbl_style)
        form.addRow(l4, self.city_input)

        self.email_input = QLineEdit()
        self.email_input.setStyleSheet(input_style)
        l5 = QLabel(_("Email") + ":"); l5.setStyleSheet(lbl_style)
        form.addRow(l5, self.email_input)

        self.address_input = QTextEdit()
        self.address_input.setStyleSheet("font-size: 16px;")
        self.address_input.setMaximumHeight(100)
        l6 = QLabel(_("Address") + ":"); l6.setStyleSheet(lbl_style)
        form.addRow(l6, self.address_input)

        layout.addLayout(form)

        buttons = QHBoxLayout()
        save_btn = QPushButton(_("Add") if not self.customer else _("Details"))
        save_btn.setMinimumHeight(50)
        save_btn.setStyleSheet("font-size: 18px; font-weight: bold; background-color: #1976d2; color: white;")
        save_btn.clicked.connect(self.save_customer)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setMinimumHeight(50)
        cancel_btn.setStyleSheet("font-size: 18px;")
        cancel_btn.clicked.connect(self.reject)
        
        buttons.addWidget(save_btn)
        buttons.addWidget(cancel_btn)
        layout.addLayout(buttons)

        self.setLayout(layout)

    def load_data(self):
        self.name_input.setText(self.customer.name)
        self.phone_input.setText(self.customer.phone or "")
        self.phone2_input.setText(self.customer.phone2 or "")
        self.city_input.setText(self.customer.city or "")
        self.email_input.setText(self.customer.email or "")
        self.address_input.setPlainText(self.customer.address or "")

    def save_customer(self):
        name = self.name_input.text().strip()
        if not name:
            QMessageBox.warning(self, _("Validation Error"), _("Name") + " " + _("is required."))
            return

        session = get_session(get_engine())
        try:
            if self.customer:
                c = session.query(Customer).get(self.customer.id)
                c.name = name
                c.phone = self.phone_input.text()
                c.phone2 = self.phone2_input.text()
                c.city = self.city_input.text()
                c.email = self.email_input.text()
                c.address = self.address_input.toPlainText()
            else:
                self.customer = Customer(
                    name=name,
                    phone=self.phone_input.text(),
                    phone2=self.phone2_input.text(),
                    city=self.city_input.text(),
                    email=self.email_input.text(),
                    address=self.address_input.toPlainText()
                )
                session.add(self.customer)
            session.commit()
            # If it was a new customer, we need to refresh from DB to get the ID properly bound
            if not self.customer.id:
                session.refresh(self.customer)
            session.expunge_all() # Detach so it can be used in other sessions
            self.accept()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Database Error"), str(e))
        finally:
            session.close()
