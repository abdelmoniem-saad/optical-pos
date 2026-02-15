# scripts/test_signals_lab.py
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PySide6.QtWidgets import QApplication
from app.core.state import state
from app.database.db_manager import get_engine, get_session
from app.database.models import User
from app.ui.lab_window import LabWindow

app = QApplication(sys.argv)
s = get_session(get_engine())
user = s.query(User).first()
s.close()
win = LabWindow(user, back_callback=lambda: None)
print('Before emit rows:', win.table.rowCount())
# Emit signals
state.refresh_all.emit()
print('After refresh_all rows:', win.table.rowCount())
# Simulate sale added
state.sale_added.emit(1)
print('After sale_added rows:', win.table.rowCount())
app.quit()


