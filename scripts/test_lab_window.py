# scripts/test_lab_window.py
"""
Test loading of LabWindow UI data without showing the GUI.
Prints row count and first few invoice numbers/status to diagnose empty table issue.
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtWidgets import QApplication
from app.database.db_manager import get_engine, get_session
from app.database.models import User

from app.ui.lab_window import LabWindow

app = QApplication(sys.argv)

# pick a user from DB
session = get_session(get_engine())
user = session.query(User).first()
session.close()

lw = LabWindow(user, back_callback=lambda: None)
# call load_data to populate table
lw.load_data()

row_count = lw.table.rowCount()
print(f'LabWindow table rows: {row_count}')
for r in range(min(10, row_count)):
    inv_item = lw.table.item(r, 1)
    status_item = lw.table.item(r, 3)
    inv = inv_item.text() if inv_item else '<no invoice>'
    status = status_item.text() if status_item else '<no status>'
    print(f'  Row {r}: Invoice={inv} Status={status}')

# exit
app.quit()


