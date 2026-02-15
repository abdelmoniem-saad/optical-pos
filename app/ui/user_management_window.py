# app/ui/user_management_window.py
import logging
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem, 
    QPushButton, QLabel, QHeaderView, QMessageBox, QLineEdit, QGridLayout
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import User, Role
from app.core.i18n import _
from app.ui.user_dialog import UserDialog

class UserManagementWindow(QWidget):
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
        header = QGridLayout()
        back_btn = QPushButton(_("← Back to Dashboard"))
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header.addWidget(back_btn, 0, 0, Qt.AlignLeft)

        title = QLabel(_("Staff Management"))
        title.setStyleSheet("font-size: 28px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        
        add_btn = QPushButton(_("+ Add"))
        add_btn.setMinimumHeight(45)
        add_btn.setStyleSheet("font-size: 16px; font-weight: bold; background-color: #2e7d32; color: white;")
        add_btn.clicked.connect(self.add_user)
        header.addWidget(add_btn, 0, 2, Qt.AlignRight)
        layout.addLayout(header)

        # Search
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText(_("Search"))
        self.search_input.setMinimumHeight(50)
        self.search_input.setStyleSheet("font-size: 18px;")
        self.search_input.textChanged.connect(self.load_data)
        layout.addWidget(self.search_input)

        # Table
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels([_("Username"), _("Name"), _("Role:"), _("Active")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setStyleSheet("font-size: 16px; font-weight: bold;")
        self.table.setStyleSheet("font-size: 16px;")
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        layout.addWidget(self.table)

        # Actions
        actions = QHBoxLayout()
        edit_btn = QPushButton(_("Details"))
        edit_btn.setMinimumHeight(50)
        edit_btn.setStyleSheet("font-size: 16px;")
        edit_btn.clicked.connect(self.edit_user)
        actions.addWidget(edit_btn)
        
        layout.addLayout(actions)
        self.setLayout(layout)

    def refresh_data(self):
        """Refresh all user data - called automatically when users change"""
        self.load_data()

    def load_data(self):
        query_text = self.search_input.text().strip() if hasattr(self, 'search_input') else ""
        session = get_session(get_engine())
        try:
            query = session.query(User).order_by(User.username)
            if query_text:
                query = query.filter((User.username.ilike(f"%{query_text}%")) | (User.full_name.ilike(f"%{query_text}%")))
            
            users = query.all()
            if hasattr(self, 'table'):
                self.table.setRowCount(0)
            self.user_ids = []  # Reset user IDs list

            if not hasattr(self, 'table'):
                return  # UI not ready

            for row_idx, u in enumerate(users):
                self.table.insertRow(row_idx)
                self.table.setItem(row_idx, 0, QTableWidgetItem(u.username))
                self.table.setItem(row_idx, 1, QTableWidgetItem(u.full_name or ""))
                self.table.setItem(row_idx, 2, QTableWidgetItem(u.role.name if u.role else _("No Role")))
                
                active_text = _("Yes") if u.is_active else _("No")
                active_item = QTableWidgetItem(active_text)
                if not u.is_active:
                    active_item.setForeground(Qt.red)
                self.table.setItem(row_idx, 3, active_item)
                self.user_ids.append(u.id)  # Store user ID for edit operations
        except Exception as e:
            logger = logging.getLogger()
            logger.exception("Error loading users: %s", e)
        finally:
            session.close()

    def add_user(self):
        dialog = UserDialog(self)
        if dialog.exec():
            self.load_data()

    def edit_user(self):
        row = self.table.currentRow()
        if row < 0:
            QMessageBox.warning(self, _("Selection"), _("Please select a user to edit."))
            return
        
        if row >= len(self.user_ids):
            QMessageBox.warning(self, _("Selection"), _("Invalid user selected."))
            return

        user_id = self.user_ids[row]
        session = get_session(get_engine())
        try:
            user_to_edit = session.query(User).get(user_id)
            if user_to_edit:
                # Detach from session before passing to dialog
                session.expunge(user_to_edit)
                dialog = UserDialog(self, user_to_edit=user_to_edit)
                if dialog.exec():
                    self.load_data()
        finally:
            session.close()
