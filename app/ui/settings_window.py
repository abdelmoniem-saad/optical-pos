# app/ui/settings_window.py
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QFormLayout, QLineEdit, 
    QPushButton, QHBoxLayout, QMessageBox, QLabel, QTextEdit, QGridLayout
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session, get_setting, set_setting
from app.core.i18n import _

class SettingsWindow(QWidget):
    def __init__(self, user, back_callback):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
        self.init_ui()
        self.load_settings()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(50, 50, 50, 50)
        layout.setSpacing(20)

        # Header
        header = QGridLayout()
        back_btn = QPushButton(_("← Back to Dashboard"))
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header.addWidget(back_btn, 0, 0, Qt.AlignLeft)

        title = QLabel(_("Settings"))
        title.setStyleSheet("font-size: 32px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        layout.addLayout(header)

        # Form
        form = QFormLayout()
        form.setSpacing(15)
        
        lbl_style = "font-size: 18px; font-weight: bold;"
        input_style = "font-size: 18px; height: 40px;"

        self.store_name_input = QLineEdit()
        self.store_name_input.setStyleSheet(input_style)
        l1 = QLabel(_("Name") + ":"); l1.setStyleSheet(lbl_style)
        form.addRow(l1, self.store_name_input)

        self.store_address_input = QLineEdit()
        self.store_address_input.setStyleSheet(input_style)
        l2 = QLabel(_("Address") + ":"); l2.setStyleSheet(lbl_style)
        form.addRow(l2, self.store_address_input)

        self.store_phone_input = QLineEdit()
        self.store_phone_input.setStyleSheet(input_style)
        l3 = QLabel(_("Phone") + ":"); l3.setStyleSheet(lbl_style)
        form.addRow(l3, self.store_phone_input)

        self.receipt_footer_input = QTextEdit()
        self.receipt_footer_input.setStyleSheet("font-size: 18px;")
        self.receipt_footer_input.setMaximumHeight(100)
        l4 = QLabel(_("Notes") + ":"); l4.setStyleSheet(lbl_style)
        form.addRow(l4, self.receipt_footer_input) # Using Notes as placeholder for Footer if not translated

        layout.addLayout(form)
        layout.addSpacing(20)

        save_btn = QPushButton(_("Save"))
        save_btn.setMinimumHeight(60)
        save_btn.setStyleSheet("background-color: #2e7d32; color: white; font-weight: bold; font-size: 20px;")
        save_btn.clicked.connect(self.save_settings)
        layout.addWidget(save_btn)

        layout.addStretch()
        self.setLayout(layout)

    def load_settings(self):
        session = get_session(get_engine())
        try:
            self.store_name_input.setText(get_setting(session, 'store_name', 'محل العدسات'))
            self.store_address_input.setText(get_setting(session, 'store_address', 'الشارع الرئيسي، المدينة'))
            self.store_phone_input.setText(get_setting(session, 'store_phone', '0123456789'))
            self.receipt_footer_input.setPlainText(get_setting(session, 'receipt_footer', 'شكراً لتسوقكم!'))
        finally:
            session.close()

    def save_settings(self):
        session = get_session(get_engine())
        try:
            set_setting(session, 'store_name', self.store_name_input.text())
            set_setting(session, 'store_address', self.store_address_input.text())
            set_setting(session, 'store_phone', self.store_phone_input.text())
            set_setting(session, 'receipt_footer', self.receipt_footer_input.toPlainText())
            
            QMessageBox.information(self, _("Success"), _("Settings saved successfully!"))
        except Exception as e:
            QMessageBox.critical(self, _("Error"), str(e))
        finally:
            session.close()
