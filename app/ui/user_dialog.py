# app/ui/user_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QFormLayout, QLineEdit, 
    QComboBox, QPushButton, QHBoxLayout, QMessageBox, QCheckBox, QLabel
)
from app.database.db_manager import get_engine, get_session
from app.database.models import User, Role
from app.core.i18n import _
from passlib.hash import bcrypt

class UserDialog(QDialog):
    def __init__(self, parent=None, user_to_edit=None):
        super().__init__(parent)
        self.user_to_edit = user_to_edit
        self.setWindowTitle(_("Staff Management") if not user_to_edit else _("Details"))
        self.setMinimumWidth(500)
        self.init_ui()
        if self.user_to_edit:
            self.load_user_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(30, 30, 30, 30)
        layout.setSpacing(15)

        form = QFormLayout()
        form.setSpacing(10)

        input_style = "font-size: 16px; height: 35px;"
        lbl_style = "font-size: 16px; font-weight: bold;"

        self.username_input = QLineEdit()
        self.username_input.setStyleSheet(input_style)
        l1 = QLabel(_("Username") + ":"); l1.setStyleSheet(lbl_style)
        form.addRow(l1, self.username_input)

        self.full_name_input = QLineEdit()
        self.full_name_input.setStyleSheet(input_style)
        l2 = QLabel(_("Name") + ":"); l2.setStyleSheet(lbl_style)
        form.addRow(l2, self.full_name_input)

        self.role_combo = QComboBox()
        self.role_combo.setStyleSheet(input_style)
        self.load_roles()
        l3 = QLabel(_("Role:") + ":"); l3.setStyleSheet(lbl_style)
        form.addRow(l3, self.role_combo)

        self.password_input = QLineEdit()
        self.password_input.setStyleSheet(input_style)
        self.password_input.setEchoMode(QLineEdit.Password)
        if self.user_to_edit:
            self.password_input.setPlaceholderText(_("Leave blank to keep current"))
        l4 = QLabel(_("Password") + ":"); l4.setStyleSheet(lbl_style)
        form.addRow(l4, self.password_input)

        self.is_active_check = QCheckBox(_("Active"))
        self.is_active_check.setStyleSheet("font-size: 16px;")
        self.is_active_check.setChecked(True)
        form.addRow("", self.is_active_check)

        layout.addLayout(form)

        buttons = QHBoxLayout()
        save_btn = QPushButton(_("Save"))
        save_btn.setMinimumHeight(50)
        save_btn.setStyleSheet("font-size: 18px; font-weight: bold; background-color: #1976d2; color: white;")
        save_btn.clicked.connect(self.save_user)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setMinimumHeight(50)
        cancel_btn.setStyleSheet("font-size: 18px;")
        cancel_btn.clicked.connect(self.reject)
        
        buttons.addWidget(save_btn)
        buttons.addWidget(cancel_btn)
        layout.addLayout(buttons)

        self.setLayout(layout)

    def load_roles(self):
        session = get_session(get_engine())
        roles = session.query(Role).all()
        for r in roles:
            self.role_combo.addItem(r.name, r.id)
        session.close()

    def load_user_data(self):
        self.username_input.setText(self.user_to_edit.username)
        self.full_name_input.setText(self.user_to_edit.full_name or "")
        index = self.role_combo.findData(self.user_to_edit.role_id)
        if index >= 0:
            self.role_combo.setCurrentIndex(index)
        self.is_active_check.setChecked(self.user_to_edit.is_active)
        # We don't load the password hash

    def save_user(self):
        username = self.username_input.text().strip()
        full_name = self.full_name_input.text().strip()
        password = self.password_input.text().strip()
        role_id = self.role_combo.currentData()
        is_active = self.is_active_check.isChecked()

        if not username:
            QMessageBox.warning(self, _("Validation Error"), _("Username") + " " + _("is required."))
            return

        if not self.user_to_edit and not password:
            QMessageBox.warning(self, _("Validation Error"), _("Password") + " " + _("is required."))
            return

        session = get_session(get_engine())
        try:
            if self.user_to_edit:
                u = session.query(User).get(self.user_to_edit.id)
                # Check if username changed and is unique
                if u.username != username:
                    exists = session.query(User).filter_by(username=username).first()
                    if exists:
                        QMessageBox.warning(self, _("Error"), f"{_('Username')} '{username}' {_('already exists.')}")
                        return
                
                u.username = username
                u.full_name = full_name
                u.role_id = role_id
                u.is_active = is_active
                if password:
                    u.password_hash = bcrypt.hash(password)
            else:
                exists = session.query(User).filter_by(username=username).first()
                if exists:
                    QMessageBox.warning(self, _("Error"), f"{_('Username')} '{username}' {_('already exists.')}")
                    return
                
                new_u = User(
                    username=username,
                    full_name=full_name,
                    password_hash=bcrypt.hash(password),
                    role_id=role_id,
                    is_active=is_active
                )
                session.add(new_u)
            
            session.commit()
            self.accept()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Database Error"), str(e))
        finally:
            session.close()
