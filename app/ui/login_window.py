# app/ui/login_window.py
import sys
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QLineEdit, QPushButton, QMessageBox, QHBoxLayout, QComboBox
)
from PySide6.QtCore import Qt, Signal
from app.core.auth import authenticate_user
from app.database.db_manager import get_engine, get_session, get_setting, set_setting
from app.core.i18n import _, set_language, get_language

class LoginWindow(QWidget):
    login_success = Signal(object)  # Emits the user object on success

    def __init__(self):
        super().__init__()
        self.setWindowTitle(_("Login"))
        self.setMinimumSize(600, 500)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(50, 40, 50, 40)
        layout.setSpacing(15)

        self.title_label = QLabel(_("Welcome"))
        self.title_label.setAlignment(Qt.AlignCenter)
        self.title_label.setStyleSheet("font-size: 42px; font-weight: bold; margin-top: 20px; margin-bottom: 30px;")
        layout.addWidget(self.title_label)

        self.username_input = QLineEdit()
        self.username_input.setPlaceholderText(_("Username"))
        self.username_input.setMinimumHeight(80)
        self.username_input.setStyleSheet("font-size: 24px; padding: 10px; border-radius: 10px; border: 2px solid #ddd;")
        layout.addWidget(self.username_input)

        self.password_input = QLineEdit()
        self.password_input.setPlaceholderText(_("Password"))
        self.password_input.setEchoMode(QLineEdit.Password)
        self.password_input.setMinimumHeight(80)
        self.password_input.setStyleSheet("font-size: 24px; padding: 10px; border-radius: 10px; border: 2px solid #ddd;")
        layout.addWidget(self.password_input)

        self.login_button = QPushButton(_("Login"))
        self.login_button.setMinimumHeight(90)
        self.login_button.setStyleSheet("""
            QPushButton {
                background-color: #1976d2;
                color: white;
                font-size: 32px;
                font-weight: bold;
                border-radius: 10px;
            }
            QPushButton:hover {
                background-color: #1565c0;
            }
        """)
        self.login_button.clicked.connect(self.handle_login)
        layout.addWidget(self.login_button)

        self.setLayout(layout)

    def refresh_ui_text(self):
        self.setWindowTitle(_("Login"))
        self.title_label.setText(_("Welcome"))
        self.login_button.setText(_("Login"))
        self.username_input.setPlaceholderText(_("Username"))
        self.password_input.setPlaceholderText(_("Password"))

    def handle_login(self):
        username = self.username_input.text()
        password = self.password_input.text()

        if not username or not password:
            QMessageBox.warning(self, _("Error"), _("Please enter both username and password."))
            return

        engine = get_engine()
        session = get_session(engine)
        try:
            user = authenticate_user(session, username, password)
            if user:
                self.login_success.emit(user)
            else:
                QMessageBox.critical(self, _("Login Failed"), _("Invalid username or password."))
        except Exception as e:
            QMessageBox.critical(self, _("Database Error"), f"{_('Could not connect to database:')} {str(e)}")
        finally:
            session.close()

if __name__ == "__main__":
    from PySide6.QtWidgets import QApplication
    app = QApplication(sys.argv)
    window = LoginWindow()
    window.login_success.connect(lambda: window.close())
    window.show()
    sys.exit(app.exec())
