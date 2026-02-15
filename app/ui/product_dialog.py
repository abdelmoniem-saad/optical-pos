# app/ui/product_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QFormLayout, QLineEdit, 
    QTextEdit, QDoubleSpinBox, QSpinBox, QPushButton, QHBoxLayout, QMessageBox, QLabel, QComboBox, QCompleter
)
from PySide6.QtCore import QStringListModel, Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import Product, LensType, FrameType, FrameColor, StockMovement, Supplier
from app.core.i18n import _

class ProductDialog(QDialog):
    def __init__(self, parent=None, product=None):
        super().__init__(parent)
        self.product = product
        self.setWindowTitle(_("Add New Product") if not product else _("Edit Selected Product"))
        self.setMinimumWidth(600)
        self.init_ui()
        if self.product:
            self.load_product_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(30, 30, 30, 30)
        layout.setSpacing(15)
        
        form = QFormLayout()
        form.setSpacing(10)
        
        input_style = "font-size: 16px; height: 35px;"
        lbl_style = "font-size: 16px; font-weight: bold;"

        # Move Category to the top (choose item first)
        self.category_input = QComboBox()
        self.category_input.setStyleSheet(input_style)
        # Display Arabic labels but keep canonical codes as userData for DB consistency
        self.category_input.addItem("", None)
        self.category_input.addItem('\u0641\u0631\u064a\u0645\u0627\u062a', 'Frame')
        self.category_input.addItem('\u0646\u0638\u0627\u0631\u0627\u062a \u0634\u0645\u0633\u064a\u0629', 'Sunglasses')
        self.category_input.addItem('\u0625\u0643\u0633\u0633\u0648\u0627\u0631\u0627\u062a', 'Accessory')
        self.category_input.addItem('\u0639\u062f\u0633\u0627\u062a \u0644\u0627\u0635\u0642\u0629', 'ContactLens')
        self.category_input.addItem('\u0623\u062e\u0631\u0649', 'Other')
        self.category_input.currentIndexChanged.connect(self.on_category_changed)
        # store label for later visibility toggling
        self.category_label = QLabel(_("Category") + ":"); self.category_label.setStyleSheet(lbl_style)
        form.addRow(self.category_label, self.category_input)

        # SKU (code) - auto-generate when category selected
        self.sku_input = QLineEdit()
        self.sku_input.setStyleSheet(input_style)
        self.sku_label = QLabel(_("SKU") + ":"); self.sku_label.setStyleSheet(lbl_style)
        form.addRow(self.sku_label, self.sku_input)

        # Track whether SKU was auto-generated so we don't overwrite manual edits
        self.sku_auto_generated = False
        self.sku_input.textChanged.connect(self._on_sku_text_changed)

        # Supplier (company) with dropdown and autocomplete
        self.supplier_input = QComboBox()
        self.supplier_input.setStyleSheet(input_style)
        self.supplier_input.setEditable(True)
        self.supplier_input.setInsertPolicy(QComboBox.NoInsert)
        self.supplier_label = QLabel(_("Company") + ":"); self.supplier_label.setStyleSheet(lbl_style)
        form.addRow(self.supplier_label, self.supplier_input)
        # Connect to filter invoices when supplier changes
        self.supplier_input.currentIndexChanged.connect(self._on_supplier_changed)
        self.supplier_input.currentTextChanged.connect(self._on_supplier_text_changed)

        # Invoice number with dropdown filtered by selected supplier
        self.invoice_input = QComboBox()
        self.invoice_input.setStyleSheet(input_style)
        self.invoice_input.setEditable(True)
        self.invoice_input.setInsertPolicy(QComboBox.NoInsert)
        self.invoice_label = QLabel(_("Invoice No") + ":"); self.invoice_label.setStyleSheet(lbl_style)
        form.addRow(self.invoice_label, self.invoice_input)


        # Name
        self.name_input = QLineEdit()
        self.name_input.setStyleSheet(input_style)
        self.name_label = QLabel(_("Name") + ":"); self.name_label.setStyleSheet(lbl_style)
        form.addRow(self.name_label, self.name_input)

        # Frame Type and Color (for frames)
        self.frame_type_cb = QComboBox()
        self.frame_type_cb.setStyleSheet(input_style)
        self.load_metadata(self.frame_type_cb, FrameType)
        self.frame_type_label = QLabel(_("Type of Frame") + ":"); self.frame_type_label.setStyleSheet(lbl_style)
        form.addRow(self.frame_type_label, self.frame_type_cb)

        self.frame_color_cb = QComboBox()
        self.frame_color_cb.setStyleSheet(input_style)
        self.load_metadata(self.frame_color_cb, FrameColor)
        self.frame_color_label = QLabel(_("Color of Frame") + ":"); self.frame_color_label.setStyleSheet(lbl_style)
        form.addRow(self.frame_color_label, self.frame_color_cb)

        # Details / Notes (lens details also go here)
        self.desc_input = QTextEdit()
        self.desc_input.setStyleSheet("font-size: 16px;")
        self.desc_input.setMaximumHeight(80)
        self.notes_label = QLabel(_("Notes") + ":"); self.notes_label.setStyleSheet(lbl_style)
        form.addRow(self.notes_label, self.desc_input)

        # Cost & Sale
        self.cost_price_input = QDoubleSpinBox()
        self.cost_price_input.setStyleSheet(input_style)
        self.cost_price_input.setMaximum(999999.99)
        l4 = QLabel(_("Cost Price") + ":"); l4.setStyleSheet(lbl_style)
        form.addRow(l4, self.cost_price_input)

        self.sale_price_input = QDoubleSpinBox()
        self.sale_price_input.setStyleSheet(input_style)
        self.sale_price_input.setMaximum(999999.99)
        l5 = QLabel(_("Sale Price") + ":"); l5.setStyleSheet(lbl_style)
        form.addRow(l5, self.sale_price_input)

        # Initial quantity input (الكمية - number of units in 'قطعة')
        self.initial_qty_input = QSpinBox()
        self.initial_qty_input.setStyleSheet(input_style)
        self.initial_qty_input.setMaximum(999999)
        self.initial_qty_input.setValue(0)
        # Label explicitly includes the unit word 'قطعة'
        self.initial_qty_label = QLabel("الكمية (قطعة):"); self.initial_qty_label.setStyleSheet(lbl_style)
        form.addRow(self.initial_qty_label, self.initial_qty_input)

        # Available stock (read-only) shown only when editing an existing product
        self.available_display = QSpinBox()
        self.available_display.setStyleSheet(input_style)
        self.available_display.setMaximum(999999)
        self.available_display.setReadOnly(True)
        self.available_display.setButtonSymbols(QSpinBox.NoButtons)
        self.available_display.hide()
        self.available_label = QLabel(_("Available") + ":"); self.available_label.setStyleSheet(lbl_style)
        form.addRow(self.available_label, self.available_display)
        self.available_label.hide()

        layout.addLayout(form)

        # Buttons
        buttons = QHBoxLayout()
        save_btn = QPushButton(_("Add") if not self.product else _("Save"))
        save_btn.setMinimumHeight(50)
        save_btn.setStyleSheet("font-size: 18px; font-weight: bold; background-color: #1976d2; color: white;")
        save_btn.clicked.connect(self.save_product)
        
        self.print_sticker_btn = QPushButton(_("Print Sticker"))
        self.print_sticker_btn.setMinimumHeight(50)
        self.print_sticker_btn.setStyleSheet("font-size: 18px; background-color: #455a64; color: white;")
        self.print_sticker_btn.clicked.connect(self.print_sticker)
        if not self.product:
            self.print_sticker_btn.setEnabled(False)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setMinimumHeight(50)
        cancel_btn.setStyleSheet("font-size: 18px;")
        cancel_btn.clicked.connect(self.reject)
        
        buttons.addWidget(save_btn)
        buttons.addWidget(self.print_sticker_btn)
        buttons.addWidget(cancel_btn)
        layout.addLayout(buttons)

        self.setLayout(layout)
        self.toggle_metadata_fields()
        # Load suppliers completer
        self.load_suppliers_completer()

    def load_metadata_into_combobox(self, combo, model_class):
        combo.clear()
        combo.addItem("")
        session = get_session(get_engine())
        try:
            items = session.query(model_class).all()
            for i in items:
                combo.addItem(i.name)
        finally:
            session.close()

    def load_suppliers_completer(self):
        """Load suppliers into dropdown and set up completer for search"""
        session = get_session(get_engine())
        try:
            suppliers = session.query(Supplier).order_by(Supplier.name).all()
            self.supplier_input.clear()
            self.supplier_input.addItem("")  # Empty option
            for sup in suppliers:
                self.supplier_input.addItem(sup.name, sup.id)

            # Set up completer for supplier typing/filtering
            names = [sup.name for sup in suppliers]
            model = QStringListModel(names)
            completer = QCompleter(model, self.supplier_input)
            completer.setCaseSensitivity(False)
            completer.setFilterMode(Qt.MatchContains)
            self.supplier_input.setCompleter(completer)
        except Exception:
            pass
        finally:
            session.close()

    def _on_supplier_changed(self):
        """When supplier selection changes, filter invoices for that supplier"""
        self._load_invoices_for_supplier()

    def _on_supplier_text_changed(self, text):
        """When user types in supplier field, filter invoices"""
        self._load_invoices_for_supplier()

    def _load_invoices_for_supplier(self):
        """Load invoice numbers for the selected or typed supplier"""
        supplier_text = self.supplier_input.currentText() if isinstance(self.supplier_input, QComboBox) else self.supplier_input.text()
        self.invoice_input.clear()
        self.invoice_input.addItem("")  # Empty option

        if not supplier_text.strip():
            return

        session = get_session(get_engine())
        try:
            from app.database.models import Purchase
            # Find supplier by name
            supplier = session.query(Supplier).filter(Supplier.name.ilike(f"%{supplier_text}%")).first()
            if supplier:
                # Get invoices for this supplier
                purchases = session.query(Purchase).filter_by(supplier_id=supplier.id).order_by(Purchase.created_at.desc()).all()
                for p in purchases:
                    if p.invoice_no:
                        self.invoice_input.addItem(p.invoice_no, p.id)

                # Set up completer for invoice numbers
                invoice_nums = [p.invoice_no for p in purchases if p.invoice_no]
                if invoice_nums:
                    model = QStringListModel(invoice_nums)
                    completer = QCompleter(model, self.invoice_input)
                    completer.setCaseSensitivity(False)
                    completer.setFilterMode(Qt.MatchContains)
                    self.invoice_input.setCompleter(completer)
        except Exception:
            pass
        finally:
            session.close()

    def on_category_changed(self):
        # When category changes, show/hide material and metadata fields
        cat = self.category_input.currentData() or self.category_input.currentText()
        is_lens = cat == "Lens"
        is_frame = cat == "Frame"
        # Show/hide labels and widgets to avoid compacting the form
        self.lens_type_label.setVisible(is_lens)
        self.lens_type_cb.setVisible(is_lens)
        self.material_label.setVisible(is_lens)
        self.material_cb.setVisible(is_lens)

        self.frame_type_label.setVisible(is_frame)
        self.frame_type_cb.setVisible(is_frame)
        self.frame_color_label.setVisible(is_frame)
        self.frame_color_cb.setVisible(is_frame)

        # Auto-generate SKU for new product when category changes.
        try:
            if not self.product:
                # generate if SKU empty or previously auto-generated
                self.generate_sku_for_category(cat, force=True)
        except Exception:
            pass

    def _on_sku_text_changed(self, txt):
        # If user edits SKU manually, mark as manual
        self.sku_auto_generated = False

    def generate_sku_for_category(self, cat, force=False):
        from app.database.db_manager import generate_sku
        session = get_session(get_engine())
        try:
            new_sku = generate_sku(session, cat)
            current = self.sku_input.text().strip()
            if force or (not current) or getattr(self, 'sku_auto_generated', False):
                self.sku_input.setText(new_sku)
                self.sku_auto_generated = True
        except Exception:
            pass
        finally:
            session.close()

    def load_metadata(self, combo, model_class):
        combo.addItem("")
        session = get_session(get_engine())
        try:
            items = session.query(model_class).all()
            for i in items:
                combo.addItem(i.name)
        finally:
            session.close()

    def toggle_metadata_fields(self):
        # Use canonical code stored in userData
        cat = self.category_input.currentData() or self.category_input.currentText()
        is_frame = cat == "Frame"

        # Show or hide entire rows to avoid condensed UI
        self.frame_type_label.setVisible(is_frame)
        self.frame_type_cb.setVisible(is_frame)
        self.frame_color_label.setVisible(is_frame)
        self.frame_color_cb.setVisible(is_frame)

    def load_product_data(self):
        self.sku_input.setText(self.product.sku or "")
        self.name_input.setText(self.product.name)
        self.desc_input.setPlainText(self.product.description or "")
        self.cost_price_input.setValue(self.product.cost_price)
        self.sale_price_input.setValue(self.product.sale_price)
        # Do not populate unit field; unit is optional and not displayed in dialog

        # Select category by matching stored canonical code (userData)
        cat_code = self.product.category or ""
        found_index = 0
        for i in range(self.category_input.count()):
            if self.category_input.itemData(i) == cat_code:
                found_index = i
                break
        self.category_input.setCurrentIndex(found_index)

        self.frame_type_cb.setCurrentText(self.product.frame_type or "")
        self.frame_color_cb.setCurrentText(self.product.frame_color or "")
        self.toggle_metadata_fields()
        # Show available stock and hide initial quantity input
        try:
            session = get_session(get_engine())
            total_qty = session.query(StockMovement).filter_by(product_id=self.product.id).with_entities(StockMovement.qty).all()
            stock = sum(q[0] for q in total_qty) if total_qty else 0
            self.available_display.setValue(stock)
            self.available_display.show()
            self.available_label.show()
            
            # Hide the initial quantity field when editing
            self.initial_qty_label.hide()
            self.initial_qty_input.hide()
        except Exception:
            pass
        finally:
            try: session.close()
            except Exception: pass

    def print_sticker(self):
        sku = self.sku_input.text()
        name = self.name_input.text()
        price = self.sale_price_input.value()
        
        content = f"{_('OPTICAL SHOP')}\n{name}\n{_('SKU')}: {sku}\n{_('Sale Price')}: {price:.2f}"

        from app.ui.pos_window import PrintPreviewDialog
        preview = PrintPreviewDialog(content, self)
        preview.exec()

    def save_product(self):
        sku = self.sku_input.text().strip()
        name = self.name_input.text().strip()

        if not name:
            QMessageBox.warning(self, _("Validation Error"), _("Name") + " " + _("is required."))
            return

        session = get_session(get_engine())
        try:
            if self.product:
                p = session.query(Product).get(self.product.id)
            else:
                if sku:
                    exists = session.query(Product).filter_by(sku=sku).first()
                    if exists:
                        QMessageBox.warning(self, _("Error"), f"{_('SKU')} '{sku}' {_('already exists.')}")
                        return
                p = Product()
                session.add(p)

            p.sku = sku
            p.name = name
            p.description = self.desc_input.toPlainText()
            p.cost_price = self.cost_price_input.value()
            p.sale_price = self.sale_price_input.value()
            # Keep product.unit default or empty; do not collect unit from dialog
            p.unit = p.unit or None

            # Save canonical category code (userData) to the database
            selected_cat = self.category_input.currentData() or self.category_input.currentText()
            p.category = selected_cat
            p.frame_type = self.frame_type_cb.currentText() if selected_cat == "Frame" else None
            p.frame_color = self.frame_color_cb.currentText() if selected_cat == "Frame" else None

            # For new products, add initial stock movement if quantity > 0
            if not self.product and self.initial_qty_input.value() > 0:
                from app.database.models import StockMovement
                # Ensure product has an id assigned
                session.flush()
                invoice_no = self.invoice_input.currentText().strip() if isinstance(self.invoice_input, QComboBox) else (self.invoice_input.text().strip() if hasattr(self.invoice_input, 'text') else '')
                movement = StockMovement(product_id=p.id, qty=self.initial_qty_input.value(), type='purchase', ref_no=invoice_no)
                session.add(movement)

            session.commit()
            self.accept()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Database Error"), str(e))
        finally:
            session.close()

