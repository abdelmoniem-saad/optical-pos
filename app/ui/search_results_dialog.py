from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QTableWidget, QTableWidgetItem, 
    QHeaderView, QPushButton, QLabel
)
from PySide6.QtCore import Qt, Signal
from app.core.i18n import _

class SearchResultsDialog(QDialog):
    result_selected = Signal(str, int) # (type, id)

    def __init__(self, results, parent=None):
        super().__init__(parent)
        self.results = results
        self.setWindowTitle(_("Search Results"))
        self.setMinimumSize(800, 500)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        
        layout.addWidget(QLabel(_("Multiple matches found. Please select one:")))
        
        self.table = QTableWidget(len(self.results), 3)
        self.table.setHorizontalHeaderLabels([_("Type"), _("Name/Details"), _("Action")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.setStyleSheet("font-size: 16px;")
        
        for i, res in enumerate(self.results):
            type_label = ""
            if res['type'] == 'customer': type_label = _("Customer")
            elif res['type'] == 'product': type_label = _("Product")
            elif res['type'] == 'sale': type_label = _("Invoice")
            
            self.table.setItem(i, 0, QTableWidgetItem(type_label))
            self.table.setItem(i, 1, QTableWidgetItem(res['details']))
            
            select_btn = QPushButton(_("Select"))
            select_btn.clicked.connect(lambda checked, r=res: self.select_result(r))
            self.table.setCellWidget(i, 2, select_btn)
            
        layout.addWidget(self.table)
        
        close_btn = QPushButton(_("Cancel"))
        close_btn.clicked.connect(self.reject)
        layout.addWidget(close_btn)

    def select_result(self, res):
        self.result_selected.emit(res['type'], res['id'])
        self.accept()
