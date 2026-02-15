# app/ui/purchase_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QFormLayout, QLineEdit, 
    QComboBox, QPushButton, QHBoxLayout, QMessageBox, QLabel, QTableWidget, QTableWidgetItem, QHeaderView, QDoubleSpinBox, QSpinBox
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import Supplier, Product, Purchase, PurchaseItem, StockMovement, Warehouse
from app.core.i18n import _

class PurchaseDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle(_("Add Purchase"))
        self.setMinimumSize(900, 700)
        self.items = []
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(15)

        form = QFormLayout()
        self.supplier_cb = QComboBox()
        self.load_suppliers()
        form.addRow(_("Supplier") + ":", self.supplier_cb)
        
        self.invoice_input = QLineEdit()
        form.addRow(_("Invoice:") + ":", self.invoice_input)
        
        layout.addLayout(form)

        # Items Table
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels([_("Product"), _("Qty"), _("Cost Price"), _("Total")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        layout.addWidget(self.table)

        btn_hb = QHBoxLayout()
        add_item_btn = QPushButton(_("+ Add"))
        add_item_btn.clicked.connect(self.add_item_row)
        btn_hb.addWidget(add_item_btn)
        
        remove_item_btn = QPushButton(_("- Qty")) # Reuse translation for Remove
        remove_item_btn.setText(_("Remove Selected Item"))
        remove_item_btn.clicked.connect(self.remove_item_row)
        btn_hb.addWidget(remove_item_btn)
        layout.addLayout(btn_hb)

        # Total
        self.total_label = QLabel(f"{_('Total')}: 0.00")
        self.total_label.setStyleSheet("font-size: 20px; font-weight: bold;")
        self.total_label.setAlignment(Qt.AlignRight)
        layout.addWidget(self.total_label)

        buttons = QHBoxLayout()
        save_btn = QPushButton(_("Save"))
        save_btn.setMinimumHeight(50)
        save_btn.setStyleSheet("background-color: #2e7d32; color: white; font-weight: bold;")
        save_btn.clicked.connect(self.save_purchase)

        save_print_btn = QPushButton(_("Save and Print Stickers"))
        save_print_btn.setMinimumHeight(50)
        save_print_btn.setStyleSheet("background-color: #1976d2; color: white; font-weight: bold;")
        save_print_btn.clicked.connect(self.save_and_print)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setMinimumHeight(50)
        cancel_btn.clicked.connect(self.reject)
        
        buttons.addWidget(save_btn)
        buttons.addWidget(save_print_btn)
        buttons.addWidget(cancel_btn)
        layout.addLayout(buttons)

        self.setLayout(layout)

    def load_suppliers(self):
        session = get_session(get_engine())
        suppliers = session.query(Supplier).all()
        for s in suppliers:
            self.supplier_cb.addItem(s.name, s.id)
        session.close()

    def add_item_row(self):
        row = self.table.rowCount()
        self.table.insertRow(row)
        
        prod_cb = QComboBox()
        session = get_session(get_engine())
        products = session.query(Product).all()
        for p in products:
            prod_cb.addItem(p.name, p.id)
        session.close()
        self.table.setCellWidget(row, 0, prod_cb)
        
        qty_sb = QSpinBox()
        qty_sb.setRange(1, 100000)
        qty_sb.valueChanged.connect(self.calculate_total)
        self.table.setCellWidget(row, 1, qty_sb)
        
        cost_sb = QDoubleSpinBox()
        cost_sb.setRange(0, 1000000)
        cost_sb.valueChanged.connect(self.calculate_total)
        self.table.setCellWidget(row, 2, cost_sb)
        
        total_item = QTableWidgetItem("0.00")
        total_item.setFlags(Qt.ItemIsSelectable | Qt.ItemIsEnabled)
        self.table.setItem(row, 3, total_item)

    def remove_item_row(self):
        row = self.table.currentRow()
        if row >= 0:
            self.table.removeRow(row)
            self.calculate_total()

    def calculate_total(self):
        total = 0
        for row in range(self.table.rowCount()):
            qty = self.table.cellWidget(row, 1).value()
            cost = self.table.cellWidget(row, 2).value()
            line_total = qty * cost
            self.table.item(row, 3).setText(f"{line_total:.2f}")
            total += line_total
        self.total_label.setText(f"{_('Total')}: {total:.2f}")

    def save_and_print(self):
        if self.save_purchase():
            self.print_stickers()
            self.accept()

    def print_stickers(self):
        content = f"{_('Barcode Stickers')}\n"
        content += "="*20 + "\n"
        session = get_session(get_engine())
        try:
            for row in range(self.table.rowCount()):
                prod_id = self.table.cellWidget(row, 0).currentData()
                qty = self.table.cellWidget(row, 1).value()
                prod = session.query(Product).get(prod_id)
                if prod:
                    barcode = prod.barcode or prod.sku or str(prod.id)
                    for i in range(qty):
                        content += f"{_('Product')}: {prod.name}\n"
                        content += f"{_('SKU')}: {barcode}\n"
                        content += f"{_('Sale Price')}: {prod.sale_price:.2f}\n"
                        content += "-"*20 + "\n"
            
            from app.ui.pos_window import PrintPreviewDialog
            preview = PrintPreviewDialog(content, self)
            preview.exec()
        finally:
            session.close()

    def save_purchase(self):
        if self.table.rowCount() == 0:
            QMessageBox.warning(self, _("Validation Error"), _('Add at least one item.'))
            return False
            
        supplier_id = self.supplier_cb.currentData()
        if not supplier_id:
            QMessageBox.warning(self, _("Validation Error"), _('Select a supplier.'))
            return False

        session = get_session(get_engine())
        try:
            total_amount = 0
            for row in range(self.table.rowCount()):
                total_amount += self.table.cellWidget(row, 1).value() * self.table.cellWidget(row, 2).value()

            purchase = Purchase(
                supplier_id=supplier_id,
                invoice_no=self.invoice_input.text(),
                total_amount=total_amount
            )
            session.add(purchase)
            session.flush()
            
            wh = session.query(Warehouse).first()
            wh_id = wh.id if wh else None

            for row in range(self.table.rowCount()):
                prod_id = self.table.cellWidget(row, 0).currentData()
                qty = self.table.cellWidget(row, 1).value()
                cost = self.table.cellWidget(row, 2).value()
                
                pi = PurchaseItem(
                    purchase_id=purchase.id,
                    product_id=prod_id,
                    qty=qty,
                    unit_cost=cost
                )
                session.add(pi)
                
                # Move stock
                move = StockMovement(
                    product_id=prod_id,
                    warehouse_id=wh_id,
                    qty=qty,
                    type="purchase",
                    ref_no=purchase.invoice_no,
                    note=_('Purchase from supplier')
                )
                session.add(move)

                # Update product cost price?
                prod = session.query(Product).get(prod_id)
                if prod:
                    prod.cost_price = cost
            
            session.commit()
            return True
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), str(e))
            return False
        finally:
            session.close()

