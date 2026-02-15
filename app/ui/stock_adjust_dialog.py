# app/ui/stock_adjust_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QFormLayout, QSpinBox, 
    QLineEdit, QComboBox, QPushButton, QHBoxLayout, QMessageBox, QLabel
)
from app.database.db_manager import get_engine, get_session
from app.database.models import StockMovement, Warehouse
from app.core.i18n import _
from app.core.state import state

class StockAdjustDialog(QDialog):
    def __init__(self, parent, product):
        super().__init__(parent)
        self.product = product
        self.setWindowTitle(f"{_('Adjust Stock')} - {product.name}")
        self.setMinimumWidth(500)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(30, 30, 30, 30)
        layout.setSpacing(15)

        form = QFormLayout()
        form.setSpacing(10)
        
        lbl_style = "font-size: 16px; font-weight: bold;"
        val_style = "font-size: 16px; font-weight: normal;"
        input_style = "font-size: 16px; height: 35px;"

        l_prod = QLabel(_("Product") + ":"); l_prod.setStyleSheet(lbl_style)
        v_prod = QLabel(self.product.name); v_prod.setStyleSheet(val_style)
        form.addRow(l_prod, v_prod)

        l_sku = QLabel(_("SKU") + ":"); l_sku.setStyleSheet(lbl_style)
        v_sku = QLabel(self.product.sku); v_sku.setStyleSheet(val_style)
        form.addRow(l_sku, v_sku)

        self.qty_input = QSpinBox()
        self.qty_input.setRange(0, 10000)
        self.qty_input.setStyleSheet(input_style)
        l_qty = QLabel("الكمية (قطعة):"); l_qty.setStyleSheet(lbl_style)
        form.addRow(l_qty, self.qty_input)

        self.type_input = QComboBox()
        # Three options: شراء (add), تلف (deduct), تعديل (replace)
        self.type_input.addItem('شراء', 'purchase')  # Add to available
        self.type_input.addItem('تلف', 'damage')      # Deduct from available
        self.type_input.addItem('تعديل', 'adjustment') # Replace available with this amount
        self.type_input.setStyleSheet(input_style)
        l_act = QLabel(_("Action") + ":"); l_act.setStyleSheet(lbl_style)
        form.addRow(l_act, self.type_input)

        self.note_input = QLineEdit()
        self.note_input.setPlaceholderText(_("Notes") + "...")
        self.note_input.setStyleSheet(input_style)
        l_note = QLabel(_("Notes") + ":"); l_note.setStyleSheet(lbl_style)
        form.addRow(l_note, self.note_input)

        layout.addLayout(form)

        buttons = QHBoxLayout()
        save_btn = QPushButton(_("Save"))
        save_btn.setMinimumHeight(50)
        save_btn.setStyleSheet("font-size: 18px; font-weight: bold; background-color: #1976d2; color: white;")
        save_btn.clicked.connect(self.save_adjustment)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setMinimumHeight(50)
        cancel_btn.setStyleSheet("font-size: 18px;")
        cancel_btn.clicked.connect(self.reject)
        
        buttons.addWidget(save_btn)
        buttons.addWidget(cancel_btn)
        layout.addLayout(buttons)

        self.setLayout(layout)

    def save_adjustment(self):
        qty = self.qty_input.value()
        action_type = self.type_input.currentData() or self.type_input.currentText()

        if qty == 0 and action_type != 'adjustment':
            QMessageBox.warning(self, _("Validation Error"), _("Quantity cannot be zero."))
            return

        session = get_session(get_engine())
        try:
            wh = session.query(Warehouse).first()
            wh_id = wh.id if wh else None

            if action_type == 'adjustment':
                # تعديل: Replace the available stock with the exact amount entered
                # First, get current stock
                current_movements = session.query(StockMovement).filter_by(product_id=self.product.id).with_entities(StockMovement.qty).all()
                current_stock = sum(m[0] for m in current_movements) if current_movements else 0

                # Calculate the difference
                adjustment_qty = qty - current_stock

                # Create a movement for the adjustment
                move = StockMovement(
                    product_id=self.product.id,
                    warehouse_id=wh_id,
                    qty=adjustment_qty,
                    type='adjustment',
                    note=f"تعديل مباشر: {current_stock} → {qty}. {self.note_input.text()}"
                )
            else:
                # شراء: Add to stock (positive qty)
                # تلف: Deduct from stock (negative qty)
                final_qty = qty if action_type == 'purchase' else -qty

                move = StockMovement(
                    product_id=self.product.id,
                    warehouse_id=wh_id,
                    qty=final_qty,
                    type=action_type,
                    note=self.note_input.text()
                )

            session.add(move)
            session.commit()

            # Emit state signal to refresh UI
            try:
                state.product_updated.emit(self.product.id)
            except Exception:
                pass

            self.accept()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), str(e))
        finally:
            session.close()

