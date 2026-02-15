# app/ui/supplier_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QFormLayout, QLineEdit, 
    QTextEdit, QPushButton, QHBoxLayout, QMessageBox, QLabel
)
from app.database.db_manager import get_engine, get_session
from app.database.models import Supplier
from app.core.i18n import _

class SupplierDialog(QDialog):
    def __init__(self, parent=None, supplier=None):
        super().__init__(parent)
        self.supplier = supplier
        self.setWindowTitle(_("Supplier Management"))
        self.setMinimumWidth(600)
        self.init_ui()
        if self.supplier:
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
        l2 = QLabel(_("Phone") + ":"); l2.setStyleSheet(lbl_style)
        form.addRow(l2, self.phone_input)

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
        save_btn = QPushButton(_("Add") if not self.supplier else _("Details"))
        save_btn.setMinimumHeight(50)
        save_btn.setStyleSheet("font-size: 18px; font-weight: bold; background-color: #1976d2; color: white;")
        save_btn.clicked.connect(self.save_supplier)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setMinimumHeight(50)
        cancel_btn.setStyleSheet("font-size: 18px;")
        cancel_btn.clicked.connect(self.reject)
        
        buttons.addWidget(save_btn)
        buttons.addWidget(cancel_btn)
        layout.addLayout(buttons)

        self.setLayout(layout)

    def load_data(self):
        self.name_input.setText(self.supplier.name)
        self.phone_input.setText(self.supplier.phone or "")
        self.email_input.setText(self.supplier.email or "")
        self.address_input.setPlainText(self.supplier.address or "")

    def save_supplier(self):
        name = self.name_input.text().strip()
        if not name:
            QMessageBox.warning(self, _("Validation Error"), _("Name") + " " + _("is required."))
            return

        session = get_session(get_engine())
        try:
            if self.supplier:
                s = session.query(Supplier).get(self.supplier.id)
                s.name = name
                s.phone = self.phone_input.text()
                s.email = self.email_input.text()
                s.address = self.address_input.toPlainText()
            else:
                self.supplier = Supplier(
                    name=name,
                    phone=self.phone_input.text(),
                    email=self.email_input.text(),
                    address=self.address_input.toPlainText()
                )
                session.add(self.supplier)
            session.commit()
            self.accept()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Database Error"), str(e))
        finally:
            session.close()
