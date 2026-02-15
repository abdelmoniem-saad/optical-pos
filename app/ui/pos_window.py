# app/ui/pos_window.py
import os
import shutil
import datetime
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLineEdit, QPushButton, 
    QTableWidget, QTableWidgetItem, QLabel, QHeaderView, QMessageBox, 
    QGridLayout, QStackedWidget, QGroupBox, QFormLayout, QComboBox, 
    QDateEdit, QDoubleSpinBox, QCompleter, QDialog, QTextEdit, QFileDialog
)
from PySide6.QtCore import Qt, QDate, Signal, QTimer, QUrl
from PySide6.QtGui import QStandardItemModel, QStandardItem, QIntValidator, QDesktopServices
from app.database.db_manager import get_engine, get_session, get_setting, get_next_invoice_no
from app.database.models import (
    Product, Sale, SaleItem, StockMovement, Customer, OrderExamination, Warehouse, Prescription, LensType
)
from app.core.i18n import _
from app.core.state import state

class SearchableComboBox(QComboBox):
    def __init__(self, parent=None, allow_new=False):
        super().__init__(parent)
        self.setEditable(True)
        # InsertPolicy: allow typing new items if allow_new is True
        if allow_new:
            self.setInsertPolicy(QComboBox.InsertPolicy.InsertAtBottom)
        else:
            self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.completer().setCompletionMode(QCompleter.PopupCompletion)
        self.completer().setFilterMode(Qt.MatchContains)

class PrintPreviewDialog(QDialog):
    def __init__(self, content, parent=None):
        super().__init__(parent)
        self.setWindowTitle(_("Print Preview"))
        self.setMinimumSize(600, 800)
        layout = QVBoxLayout(self)
        
        self.text_edit = QTextEdit()
        self.text_edit.setReadOnly(True)
        self.text_edit.setPlainText(content)
        self.text_edit.setStyleSheet("font-family: 'Courier New'; font-size: 14px;")
        layout.addWidget(self.text_edit)
        
        btns = QHBoxLayout()
        confirm_btn = QPushButton(_("Confirm & Print"))
        confirm_btn.setStyleSheet("background-color: #2e7d32; color: white; font-weight: bold; height: 40px;")
        confirm_btn.clicked.connect(self.accept)
        
        cancel_btn = QPushButton(_("Cancel"))
        cancel_btn.setStyleSheet("height: 40px;")
        cancel_btn.clicked.connect(self.reject)
        
        btns.addWidget(confirm_btn)
        btns.addWidget(cancel_btn)
        layout.addLayout(btns)

class POSWindow(QWidget):
    def __init__(self, user, back_callback=None):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
        self.current_customer = None
        self.current_sale = None
        self.search_results = []
        self.selected_category = "Glasses" # Default
        self.items_to_add = [] # For Step 3
        
        self.init_ui()

    def init_ui(self):
        self.setWindowTitle(_("Optical Shop POS"))
        self.setMinimumSize(1280, 900)
        
        self.main_layout = QVBoxLayout(self)
        self.main_layout.setContentsMargins(20, 20, 20, 20)
        self.main_layout.setSpacing(15)
        
        # Header
        header = QHBoxLayout()
        if self.back_callback:
            back_btn = QPushButton(_("← Back"))
            back_btn.setMinimumHeight(45)
            back_btn.clicked.connect(self.back_callback)
            header.addWidget(back_btn)
        
        self.title_label = QLabel(_("Sales POS"))
        self.title_label.setStyleSheet("font-size: 32px; font-weight: bold;")
        header.addWidget(self.title_label, 1, Qt.AlignCenter)
        
        self.main_layout.addLayout(header)
        
        self.stack = QStackedWidget()
        self.main_layout.addWidget(self.stack)
        
        self.init_step0_category()
        self.init_step1_customer()
        self.init_step2_order()
        self.init_step3_other_items()
        self.init_step4_additional_category()
        
        # Listen for product/metadata changes to update in-place UI
        state.product_added.connect(self.on_products_changed)
        state.product_updated.connect(self.on_products_changed)
        state.product_deleted.connect(self.on_products_changed)
        state.metadata_changed.connect(self.on_metadata_changed)

        self.setLayout(self.main_layout)

    def refresh_data(self):
        """Refresh all data in the POS window - called automatically when data changes"""
        # Reload metadata (lens types, frame types, colors) from database
        self.on_metadata_changed(None)
        # Reload product lists and customers
        self.on_products_changed(None)

    def init_step0_category(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setAlignment(Qt.AlignCenter)
        
        title = QLabel(_("Select Category"))
        title.setStyleSheet("font-size: 38px; font-weight: bold; margin-bottom: 30px;")
        title.setAlignment(Qt.AlignCenter)
        layout.addWidget(title)
        
        grid = QGridLayout()
        grid.setSpacing(25)
        
        cats = [
            ("Glasses", _("Glasses"), "#1976d2"),
            ("Contact Lenses", _("Contact Lenses"), "#0288d1"),
            ("Sunglasses", _("Sunglasses"), "#388e3c"),
            ("Accessories", _("Accessories"), "#f57c00"),
            ("Others", _("Others"), "#7b1fa2")
        ]
        
        for i, (code, label, color) in enumerate(cats):
            btn = QPushButton(label)
            btn.setMinimumSize(300, 220)
            btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: {color};
                    color: white;
                    font-size: 28px;
                    font-weight: bold;
                    border-radius: 20px;
                }}
                QPushButton:hover {{
                    background-color: {color};
                    opacity: 0.9;
                }}
            """)
            btn.clicked.connect(lambda checked, c=code: self.start_with_category(c))
            grid.addWidget(btn, i // 3, i % 3)
            
        layout.addLayout(grid)
        self.stack.addWidget(page)

    def start_with_category(self, category):
        self.selected_category = category
        self.stack.setCurrentIndex(1) # Go to Customer Lookup
        
    def init_step1_customer(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        
        group = QGroupBox(_("Customer Lookup"))
        group.setStyleSheet("font-size: 24px; font-weight: bold;")
        g_layout = QVBoxLayout(group)
        
        form = QGridLayout()
        form.setSpacing(20)
        
        self.c_name = QLineEdit(); self.c_name.setPlaceholderText(_("Name"))
        self.c_phone = QLineEdit(); self.c_phone.setPlaceholderText(_("Mobile Phone"))
        self.c_phone2 = QLineEdit(); self.c_phone2.setPlaceholderText(_("Second Number"))
        self.c_city = QLineEdit(); self.c_city.setPlaceholderText(_("City Name"))
        self.c_email = QLineEdit(); self.c_email.setPlaceholderText(_("Email"))
        self.c_address = QLineEdit(); self.c_address.setPlaceholderText(_("Address"))
        
        input_style = "font-size: 22px; height: 55px; font-weight: normal;"
        for field in [self.c_name, self.c_phone, self.c_phone2, self.c_city, self.c_email, self.c_address]:
            field.setStyleSheet(input_style)
            field.textChanged.connect(self.on_customer_field_changed)
            
        label_style = "font-size: 20px; font-weight: bold;"
        l1 = QLabel(_("Name")); l1.setStyleSheet(label_style); form.addWidget(l1, 0, 0); form.addWidget(self.c_name, 0, 1)
        l2 = QLabel(_("Mobile Phone")); l2.setStyleSheet(label_style); form.addWidget(l2, 0, 2); form.addWidget(self.c_phone, 0, 3)
        l3 = QLabel(_("Second Number")); l3.setStyleSheet(label_style); form.addWidget(l3, 1, 0); form.addWidget(self.c_phone2, 1, 1)
        l4 = QLabel(_("City Name")); l4.setStyleSheet(label_style); form.addWidget(l4, 1, 2); form.addWidget(self.c_city, 1, 3)
        l5 = QLabel(_("Email")); l5.setStyleSheet(label_style); form.addWidget(l5, 2, 0); form.addWidget(self.c_email, 2, 1)
        l6 = QLabel(_("Address")); l6.setStyleSheet(label_style); form.addWidget(l6, 2, 2); form.addWidget(self.c_address, 2, 3)
        
        g_layout.addLayout(form)
        layout.addWidget(group)
        
        self.cust_table = QTableWidget(0, 4)
        self.cust_table.setHorizontalHeaderLabels([_("Name"), _("Phone"), _("City"), _("ID")])
        self.cust_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.cust_table.setStyleSheet("font-size: 20px; font-weight: normal;")
        self.cust_table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.cust_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.cust_table.itemSelectionChanged.connect(self.on_customer_selection_changed)
        layout.addWidget(self.cust_table)
        
        nav = QHBoxLayout()
        prev_btn = QPushButton(_("← Back"))
        prev_btn.setMinimumHeight(60)
        prev_btn.setStyleSheet("font-size: 20px;")
        prev_btn.clicked.connect(lambda: self.stack.setCurrentIndex(0))
        nav.addWidget(prev_btn)
        nav.addStretch()
        self.next_btn = QPushButton(_("Next Screen") + " →")
        self.next_btn.setMinimumSize(300, 70)
        self.next_btn.setStyleSheet("font-size: 24px; font-weight: bold; background-color: #1976d2; color: white; border-radius: 10px;")
        self.next_btn.clicked.connect(self.go_to_step2)
        nav.addWidget(self.next_btn)
        layout.addLayout(nav)
        
        self.stack.addWidget(page)

    def on_customer_field_changed(self):
        if hasattr(self, 'search_timer'):
            self.search_timer.stop()
        else:
            self.search_timer = QTimer()
            self.search_timer.setSingleShot(True)
            self.search_timer.timeout.connect(self.perform_customer_search)
        self.search_timer.start(300)

    def perform_customer_search(self):
        name = self.c_name.text().strip()
        phone = self.c_phone.text().strip()
        phone2 = self.c_phone2.text().strip()
        city = self.c_city.text().strip()
        email = self.c_email.text().strip()
        address = self.c_address.text().strip()
        
        if not any([name, phone, phone2, city, email, address]):
            self.cust_table.setRowCount(0)
            self.search_results = []
            return

        session = get_session(get_engine())
        try:
            from sqlalchemy import or_
            filters = []
            if name: filters.append(Customer.name.ilike(f"%{name}%"))
            if phone: filters.append(Customer.phone.ilike(f"%{phone}%"))
            if phone2: filters.append(Customer.phone2.ilike(f"%{phone2}%"))
            if city: filters.append(Customer.city.ilike(f"%{city}%"))
            if email: filters.append(Customer.email.ilike(f"%{email}%"))
            if address: filters.append(Customer.address.ilike(f"%{address}%"))
            
            if filters:
                query = session.query(Customer).filter(or_(*filters))
                customers = query.limit(10).all()
                self.cust_table.setRowCount(0)
                self.search_results = customers
                for row, c in enumerate(customers):
                    self.cust_table.insertRow(row)
                    self.cust_table.setItem(row, 0, QTableWidgetItem(c.name))
                    self.cust_table.setItem(row, 1, QTableWidgetItem(c.phone or ""))
                    self.cust_table.setItem(row, 2, QTableWidgetItem(c.city or ""))
                    self.cust_table.setItem(row, 3, QTableWidgetItem(str(c.id)))
        finally:
            session.close()

    def on_customer_selection_changed(self):
        row = self.cust_table.currentRow()
        if row >= 0 and row < len(self.search_results):
            c = self.search_results[row]
            self.current_customer = c
            for field in [self.c_name, self.c_phone, self.c_phone2, self.c_city, self.c_email, self.c_address]:
                field.blockSignals(True)
            self.c_name.setText(c.name)
            self.c_phone.setText(c.phone or "")
            self.c_phone2.setText(c.phone2 or "")
            self.c_city.setText(c.city or "")
            self.c_email.setText(c.email or "")
            self.c_address.setText(c.address or "")
            for field in [self.c_name, self.c_phone, self.c_phone2, self.c_city, self.c_email, self.c_address]:
                field.blockSignals(False)

    def go_to_step2(self):
        name = self.c_name.text().strip()
        if not name:
            QMessageBox.warning(self, _("Validation"), _("Please enter customer name."))
            return
        if not self.current_customer:
            session = get_session(get_engine())
            try:
                c = Customer(name=name, phone=self.c_phone.text(), phone2=self.c_phone2.text(), city=self.c_city.text(), email=self.c_email.text(), address=self.c_address.text())
                session.add(c)
                session.commit()
                session.refresh(c)
                self.current_customer = c
                session.expunge(c)
            except Exception as e:
                QMessageBox.critical(self, _("Error"), f"Failed to save customer: {e}")
                return
            finally:
                session.close()

        if self.selected_category in ["Glasses", "Contact Lenses"]:
            self.stack.setCurrentIndex(2) # Prescription Step
        else:
            self.stack.setCurrentIndex(3) # Other Items Step

        self.update_order_step_ui()

    def init_step2_order(self):
        page = QWidget()
        h_layout = QHBoxLayout(page)
        
        # Left Side: Main Order Form
        left_side = QVBoxLayout()
        top_info = QHBoxLayout()
        date_form = QFormLayout()
        self.order_date_edit = QDateEdit(QDate.currentDate())
        self.order_date_edit.setCalendarPopup(True)
        # Display dates in dd/mm/yyyy format per user preference
        self.order_date_edit.setDisplayFormat("dd/MM/yyyy")
        self.order_date_edit.setMinimumHeight(50)
        self.order_date_edit.setStyleSheet("font-size: 20px;")
        l1 = QLabel(_("Date") + ":"); l1.setStyleSheet("font-size: 18px; font-weight: bold;")
        date_form.addRow(l1, self.order_date_edit)
        self.delivery_date_edit = QDateEdit(QDate.currentDate().addDays(3))
        self.delivery_date_edit.setCalendarPopup(True)
        self.delivery_date_edit.setDisplayFormat("dd/MM/yyyy")
        self.delivery_date_edit.setMinimumHeight(50)
        self.delivery_date_edit.setStyleSheet("font-size: 20px; font-weight: bold; color: #1976d2;")
        l2 = QLabel(_("Delivery Date") + ":"); l2.setStyleSheet("font-size: 18px; font-weight: bold;")
        date_form.addRow(l2, self.delivery_date_edit)
        self.doctor_name_input = QLineEdit()
        self.doctor_name_input.setPlaceholderText(_("Doctor Name"))
        self.doctor_name_input.setMinimumHeight(50)
        self.doctor_name_input.setStyleSheet("font-size: 20px;")
        l3 = QLabel(_("Doctor Name") + ":"); l3.setStyleSheet("font-size: 18px; font-weight: bold;")
        date_form.addRow(l3, self.doctor_name_input)
        top_info.addLayout(date_form)
        top_info.addStretch()
        self.invoice_label = QLabel(_("Invoice:") + " ---")
        self.invoice_label.setStyleSheet("font-size: 28px; font-weight: bold; color: #333;")
        top_info.addWidget(self.invoice_label)
        left_side.addLayout(top_info)
        
        # Container for Eye Examination
        self.exam_container = QWidget()
        exam_vbox = QVBoxLayout(self.exam_container)
        exam_vbox.setContentsMargins(0, 0, 0, 0)
        
        self.exam_table = QTableWidget(0, 14) # Exam Type, L(3), R(3), IPD, Lens, Frame, Color, Status, Image, Action
        self.exam_table.setLayoutDirection(Qt.LeftToRight)
        cols = [
            _("Exam Type"), "L.SPH", "L.CYL", "L.AXIS", "R.SPH", "R.CYL", "R.AXIS", "I.P.D", 
            _("Lens Specifications"), _("Frame"), _("Frame Color"), _("Frame Status"), _("Image"), _("Action")
        ]
        self.exam_table.setHorizontalHeaderLabels(cols)
        # Custom widths for better fit
        header = self.exam_table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Interactive)
        self.exam_table.setColumnWidth(0, 140) # Exam Type
        for i in range(1, 8): self.exam_table.setColumnWidth(i, 90) # Measurements
        self.exam_table.setColumnWidth(8, 280) # Lens
        self.exam_table.setColumnWidth(9, 220) # Frame
        self.exam_table.setColumnWidth(10, 130) # Color
        self.exam_table.setColumnWidth(11, 130) # Status
        header.setSectionResizeMode(13, QHeaderView.Stretch) # Last col stretch
        
        self.exam_table.setStyleSheet("font-size: 18px;")
        self.exam_table.horizontalHeader().setStyleSheet("font-size: 18px; font-weight: bold;")
        self.exam_table.setMinimumHeight(350)
        exam_vbox.addWidget(self.exam_table)
        
        add_row_layout = QHBoxLayout()
        add_row_btn = QPushButton("+")
        add_row_btn.setFixedSize(50, 50)
        add_row_btn.setStyleSheet("font-size: 28px; font-weight: bold; background-color: #4caf50; color: white; border-radius: 25px;")
        add_row_btn.clicked.connect(self.add_exam_row)
        
        self.add_more_btn = QPushButton(_("Add More Items?"))
        self.add_more_btn.setMinimumHeight(55)
        self.add_more_btn.setMinimumWidth(250)
        self.add_more_btn.setStyleSheet("font-size: 20px; background-color: #ff9800; color: white; font-weight: bold; border-radius: 10px;")
        self.add_more_btn.clicked.connect(lambda: self.stack.setCurrentIndex(4)) # Go to Step 4 (Additional Category)
        
        add_row_layout.addWidget(self.add_more_btn)
        add_row_layout.addStretch()
        add_row_layout.addWidget(add_row_btn)
        exam_vbox.addLayout(add_row_layout)
        
        left_side.addWidget(self.exam_container)
        
        # Summary for Other Items
        self.other_items_summary = QLabel()
        self.other_items_summary.setStyleSheet("font-size: 18px; color: #555; font-style: italic; margin-top: 10px;")
        self.other_items_summary.hide()
        left_side.addWidget(self.other_items_summary)
        
        bottom_layout = QHBoxLayout()
        fin_group = QGroupBox(_("Order Details"))
        fin_group.setStyleSheet("font-size: 20px; font-weight: bold;")
        fin_form = QFormLayout(fin_group)
        self.cost_input = QDoubleSpinBox()
        self.cost_input.setRange(0, 1000000); self.cost_input.setMinimumHeight(55)
        self.cost_input.setStyleSheet("font-size: 22px;")
        self.cost_input.valueChanged.connect(self.calculate_totals)
        self.discount_input = QDoubleSpinBox()
        self.discount_input.setRange(0, 1000000); self.discount_input.setMinimumHeight(55)
        self.discount_input.setStyleSheet("font-size: 22px;")
        self.discount_input.valueChanged.connect(self.calculate_totals)
        
        self.total_input = QDoubleSpinBox()
        self.total_input.setRange(0, 1000000); self.total_input.setMinimumHeight(65)
        self.total_input.setStyleSheet("font-size: 32px; font-weight: bold; color: #2e7d32;")
        self.total_input.valueChanged.connect(self.calculate_totals)
        
        self.paid_input = QDoubleSpinBox()
        self.paid_input.setRange(0, 1000000); self.paid_input.setMinimumHeight(55)
        self.paid_input.setStyleSheet("font-size: 22px;")
        self.paid_input.valueChanged.connect(self.calculate_totals)
        
        self.balance_input = QDoubleSpinBox()
        self.balance_input.setRange(-1000000, 1000000); self.balance_input.setMinimumHeight(65)
        self.balance_input.setStyleSheet("font-size: 32px; font-weight: bold; color: #d32f2f;")
        
        l_c = QLabel(_("Cost")); l_c.setStyleSheet("font-size: 18px; font-weight: bold;")
        l_d = QLabel(_("Discount")); l_d.setStyleSheet("font-size: 18px; font-weight: bold;")
        l_t = QLabel(_("Total after discount")); l_t.setStyleSheet("font-size: 18px; font-weight: bold;")
        l_p = QLabel(_("Amount Paid")); l_p.setStyleSheet("font-size: 18px; font-weight: bold;")
        l_b = QLabel(_("Remaining balance to be paid")); l_b.setStyleSheet("font-size: 18px; font-weight: bold;")
        
        fin_form.addRow(l_c, self.cost_input)
        fin_form.addRow(l_d, self.discount_input)
        fin_form.addRow(l_t, self.total_input)
        fin_form.addRow(l_p, self.paid_input)
        fin_form.addRow(l_b, self.balance_input)
        bottom_layout.addWidget(fin_group, 1)
        
        actions = QVBoxLayout()
        self.save_btn = QPushButton(_("Save"))
        self.save_btn.setMinimumHeight(80)
        self.save_btn.setStyleSheet("background-color: #1976d2; color: white; font-size: 28px; font-weight: bold; border-radius: 10px;")
        self.save_btn.clicked.connect(self.save_order)
        self.print_btn = QPushButton(_("Print"))
        self.print_btn.setMinimumHeight(80)
        self.print_btn.setEnabled(False)
        self.print_btn.setStyleSheet("background-color: #607d8b; color: white; font-size: 28px; font-weight: bold; border-radius: 10px;")
        self.print_btn.clicked.connect(self.print_order)
        prev_btn = QPushButton(_("← Back"))
        prev_btn.setMinimumHeight(60)
        prev_btn.setStyleSheet("font-size: 20px; font-weight: bold;")
        prev_btn.clicked.connect(lambda: self.stack.setCurrentIndex(1))
        actions.addWidget(self.save_btn)
        actions.addWidget(self.print_btn)
        actions.addWidget(prev_btn)
        bottom_layout.addLayout(actions, 1)
        left_side.addLayout(bottom_layout)
        h_layout.addLayout(left_side, 3)
        
        # Right Side: Past Examinations
        self.past_exams_group = QGroupBox(_("Past Examinations"))
        self.past_exams_group.setFixedWidth(450)
        self.past_exams_group.setStyleSheet("font-size: 20px; font-weight: bold;")
        past_layout = QVBoxLayout(self.past_exams_group)
        self.past_exams_table = QTableWidget(0, 3)
        self.past_exams_table.setHorizontalHeaderLabels([_("Date"), _("Type"), _("Action")])
        self.past_exams_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.past_exams_table.setStyleSheet("font-size: 18px;")
        self.past_exams_table.horizontalHeader().setStyleSheet("font-size: 18px; font-weight: bold;")
        past_layout.addWidget(self.past_exams_table)
        h_layout.addWidget(self.past_exams_group)
        
        self.stack.addWidget(page)

    def add_exam_row(self, data=None):
        row = self.exam_table.rowCount()
        self.exam_table.insertRow(row)
        
        type_cb = QComboBox()
        type_cb.addItems([_("Distance"), _("Reading"), _("Contact Lenses")])
        self.exam_table.setCellWidget(row, 0, type_cb)
        
        # SPH, CYL, AXIS for L and R, and IPD
        for i in range(1, 8):
            le = QLineEdit()
            le.setAlignment(Qt.AlignCenter)
            le.setMinimumHeight(35)
            if i in [3, 6, 7]: # AXIS and IPD
                le.setValidator(QIntValidator(0, 360))
            self.exam_table.setCellWidget(row, i, le)
            
        # Lens types from Optical Settings (searchable combobox for autocomplete)
        # Allow typing new lens types that will be added to the list
        lens_cb = SearchableComboBox(allow_new=True)
        self.populate_lens_types(lens_cb)
        self.exam_table.setCellWidget(row, 8, lens_cb)
        
        # Frame products from inventory (searchable combobox)
        # Allow typing new frame names that will be auto-created as products
        frame_cb = SearchableComboBox(allow_new=True)
        self.populate_product_completer(frame_cb, role='frame')
        self.exam_table.setCellWidget(row, 9, frame_cb)
        
        color_cb = QComboBox()
        self.populate_metadata_cb(color_cb, "frame_colors")
        self.exam_table.setCellWidget(row, 10, color_cb)
        
        status_cb = QComboBox()
        status_cb.addItems([_("New"), _("Old")])
        self.exam_table.setCellWidget(row, 11, status_cb)
        
        # Image attachment
        img_btn = QPushButton(_("Attach"))
        img_btn.setProperty("image_path", "")
        img_btn.clicked.connect(lambda: self.attach_image_to_row(row))
        self.exam_table.setCellWidget(row, 12, img_btn)
        
        # Delete Action
        del_btn = QPushButton("❌")
        del_btn.setStyleSheet("color: red; font-size: 18px;")
        del_btn.clicked.connect(lambda: self.exam_table.removeRow(row))
        self.exam_table.setCellWidget(row, 13, del_btn)
        
        if data:
            type_cb.setCurrentText(data.get('exam_type', _("Distance")))
            self.exam_table.cellWidget(row, 1).setText(data.get('sphere_os', ""))
            self.exam_table.cellWidget(row, 2).setText(data.get('cylinder_os', ""))
            self.exam_table.cellWidget(row, 3).setText(data.get('axis_os', ""))
            self.exam_table.cellWidget(row, 4).setText(data.get('sphere_od', ""))
            self.exam_table.cellWidget(row, 5).setText(data.get('cylinder_od', ""))
            self.exam_table.cellWidget(row, 6).setText(data.get('axis_od', ""))
            self.exam_table.cellWidget(row, 7).setText(data.get('ipd', ""))
            lens_cb.setCurrentText(data.get('lens_info', ""))
            frame_cb.setCurrentText(data.get('frame_info', ""))
            color_cb.setCurrentText(data.get('frame_color', ""))
            status_cb.setCurrentText(data.get('frame_status', _("New")))
            # Doctor name is now global for the order, but we can set it if it's in data
            if 'doctor_name' in data and data['doctor_name']:
                self.doctor_name_input.setText(data['doctor_name'])
                
            if data.get('image_path'):
                img_btn.setProperty("image_path", data['image_path'])
                img_btn.setText(_("View"))
                img_btn.setStyleSheet("background-color: #4caf50; color: white;")

    def attach_image_to_row(self, row):
        btn = self.exam_table.cellWidget(row, 12)
        current_path = btn.property("image_path")
        
        if current_path and os.path.exists(current_path):
            QDesktopServices.openUrl(QUrl.fromLocalFile(current_path))
            return

        file_path, filter_used = QFileDialog.getOpenFileName(self, _("Attach Image"), "", "Images (*.png *.jpg *.jpeg *.bmp)")
        if file_path:
            # Copy to uploads
            os.makedirs("uploads", exist_ok=True)
            ext = os.path.splitext(file_path)[1]
            new_filename = f"pos_rx_{self.current_customer.id}_{int(datetime.datetime.now().timestamp())}{ext}"
            new_path = os.path.join("uploads", new_filename)
            shutil.copy(file_path, new_path)
            
            btn.setProperty("image_path", new_path)
            btn.setText(_("View"))
            btn.setStyleSheet("background-color: #4caf50; color: white;")

    def init_step3_other_items(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        
        self.item_title_label = QLabel(_("Add More Items"))
        self.item_title_label.setStyleSheet("font-size: 32px; font-weight: bold; margin-bottom: 20px;")
        layout.addWidget(self.item_title_label)
        
        self.item_table = QTableWidget(0, 5)
        self.item_table.setHorizontalHeaderLabels([_("Item"), _("Price"), _("Qty"), _("Total"), _("Action")])
        self.item_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.item_table.setStyleSheet("font-size: 20px;")
        self.item_table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.item_table.setMinimumHeight(350)
        layout.addWidget(self.item_table)
        
        # Add Item Selection
        selection_group = QGroupBox(_("Select Item"))
        selection_group.setStyleSheet("font-size: 20px; font-weight: bold;")
        selection = QHBoxLayout(selection_group)
        self.product_cb = SearchableComboBox()
        self.product_cb.setMinimumHeight(60)
        self.product_cb.setStyleSheet("font-size: 22px;")
        self.populate_product_completer(self.product_cb, role='general')
        
        l_sel = QLabel(_("Search") + ":"); l_sel.setStyleSheet("font-size: 18px;")
        selection.addWidget(l_sel)
        selection.addWidget(self.product_cb, 2)
        
        add_btn = QPushButton(_("Add"))
        add_btn.setMinimumHeight(60)
        add_btn.setMinimumWidth(150)
        add_btn.setStyleSheet("background-color: #4caf50; color: white; font-size: 20px; font-weight: bold; border-radius: 10px;")
        add_btn.clicked.connect(self.add_item_to_order)
        selection.addWidget(add_btn)
        layout.addWidget(selection_group)
        
        nav = QHBoxLayout()
        back_btn = QPushButton(_("← Back"))
        back_btn.setMinimumHeight(65)
        back_btn.setMinimumWidth(180)
        back_btn.setStyleSheet("font-size: 20px; font-weight: bold;")
        # Back from Step 3 should go to Step 4 (Category Selection)
        back_btn.clicked.connect(lambda: self.stack.setCurrentIndex(4))
        nav.addWidget(back_btn)
        nav.addStretch()
        
        finish_btn = QPushButton(_("Finish Checkout") + " →")
        finish_btn.setMinimumHeight(75)
        finish_btn.setMinimumWidth(300)
        finish_btn.setStyleSheet("background-color: #1976d2; color: white; font-size: 24px; font-weight: bold; border-radius: 10px;")
        finish_btn.clicked.connect(lambda: self.stack.setCurrentIndex(2)) # Always go to Step 2 for payment/save
        nav.addWidget(finish_btn)
        layout.addLayout(nav)
        
        self.stack.addWidget(page)

    def init_step4_additional_category(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setAlignment(Qt.AlignCenter)
        
        title = QLabel(_("Select Category for Additional Items"))
        title.setStyleSheet("font-size: 32px; font-weight: bold; margin-bottom: 25px;")
        title.setAlignment(Qt.AlignCenter)
        layout.addWidget(title)
        
        grid = QGridLayout()
        grid.setSpacing(25)
        
        cats = [
            ("Sunglasses", _("Sunglasses"), "#388e3c"),
            ("Accessories", _("Accessories"), "#f57c00"),
            ("Others", _("Others"), "#7b1fa2"),
            ("Contact Lenses", _("Contact Lenses"), "#0288d1"),
            ("Glasses", _("Glasses"), "#1976d2")
        ]
        
        for i, (code, label, color) in enumerate(cats):
            btn = QPushButton(label)
            btn.setMinimumSize(280, 200)
            btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: {color};
                    color: white;
                    font-size: 24px;
                    font-weight: bold;
                    border-radius: 20px;
                }}
                QPushButton:hover {{
                    background-color: {color};
                    opacity: 0.9;
                }}
            """)
            btn.clicked.connect(lambda checked, c=code: self.start_additional_category(c))
            grid.addWidget(btn, i // 3, i % 3)
            
        layout.addLayout(grid)
        
        back_btn = QPushButton(_("← Back"))
        back_btn.setMinimumSize(220, 65)
        back_btn.setStyleSheet("font-size: 22px; font-weight: bold;")
        back_btn.clicked.connect(lambda: self.stack.setCurrentIndex(2))
        layout.addWidget(back_btn, 0, Qt.AlignCenter)
        
        self.stack.addWidget(page)

    def start_additional_category(self, category):
        self.current_additional_category = category
        self.item_title_label.setText(_("Add More Items") + f" - {_(category)}")
        # Mapping for populate_product_completer
        mapping = {
            'Glasses': 'frame',
            'Sunglasses': 'Sunglasses',
            'Accessories': 'Accessories',
            'Others': 'Others',
            'Contact Lenses': 'Contact Lenses'
        }
        role = mapping.get(category, category)
        self.populate_product_completer(self.product_cb, role=role)
        self.stack.setCurrentIndex(3)

    def add_item_to_order(self):
        text = self.product_cb.currentText().strip()
        if not text: return
        
        session = get_session(get_engine())
        try:
            # Parse product from text "Name | Price..."
            name_part = text.split(' | ')[0].strip()
            
            # Determine category for auto-creation
            category = getattr(self, 'current_additional_category', 'Others')
            mapping = {
                'Glasses': 'Frame',
                'Sunglasses': 'Sunglasses',
                'Accessories': 'Accessory',
                'Others': 'Other',
                'Contact Lenses': 'ContactLens'
            }
            db_cat = mapping.get(category, 'Other')
            
            product = session.query(Product).filter_by(name=name_part, category=db_cat).first()
            if not product:
                # User wants it added directly if not there
                from app.database.db_manager import generate_sku
                sku = generate_sku(session, db_cat)
                product = Product(
                    name=name_part,
                    category=db_cat,
                    sku=sku,
                    sale_price=0.0,
                    cost_price=0.0
                )
                session.add(product)
                session.flush()
                
                wh = session.query(Warehouse).first()
                move = StockMovement(
                    product_id=product.id,
                    warehouse_id=wh.id if wh else None,
                    qty=0,
                    type='initial'
                )
                session.add(move)
                session.flush()
                state.product_added.emit(product.id)
            
            row = self.item_table.rowCount()
            self.item_table.insertRow(row)
            self.item_table.setItem(row, 0, QTableWidgetItem(product.name))
            self.item_table.setItem(row, 1, QTableWidgetItem(f"{product.sale_price:.2f}"))
            
            qty_spin = QDoubleSpinBox()
            qty_spin.setRange(0.1, 1000)
            qty_spin.setValue(1.0)
            qty_spin.setMinimumHeight(45)
            qty_spin.setStyleSheet("font-size: 18px;")
            qty_spin.valueChanged.connect(self.update_item_totals)
            self.item_table.setCellWidget(row, 2, qty_spin)
            
            total_item = QTableWidgetItem(f"{product.sale_price:.2f}")
            self.item_table.setItem(row, 3, total_item)
            
            del_btn = QPushButton("❌")
            del_btn.setFixedSize(50, 45)
            del_btn.setStyleSheet("color: red; font-size: 20px;")
            del_btn.clicked.connect(lambda: self.remove_item_from_table(row))
            self.item_table.setCellWidget(row, 4, del_btn)
            
            # Store product ID in UserRole for later saving
            self.item_table.item(row, 0).setData(Qt.UserRole, product.id)
            
            session.commit() # Commit new product if created
            self.update_item_totals()
            
            # If product was new, refresh the completer to show it next time
            if not session.query(Product).filter_by(name=name_part, category=db_cat).first(): # wait, it was just added
                self.start_additional_category(category) 

        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), f"Failed to add item: {e}")
        finally:
            session.close()

    def update_item_totals(self):
        total_additional = 0
        summary_parts = []
        for r in range(self.item_table.rowCount()):
            price_item = self.item_table.item(r, 1)
            if not price_item: continue
            price = float(price_item.text())
            qty = self.item_table.cellWidget(r, 2).value()
            row_total = price * qty
            self.item_table.item(r, 3).setText(f"{row_total:.2f}")
            total_additional += row_total
            summary_parts.append(f"{self.item_table.item(r, 0).text()} (x{int(qty)})")
        
        if summary_parts:
            self.other_items_summary.setText(f"{_('Other Items')}: {', '.join(summary_parts)}")
            self.other_items_summary.show()
        else:
            self.other_items_summary.hide()
            
        self.calculate_totals()

    def remove_item_from_table(self, row):
        self.item_table.removeRow(row)
        self.update_item_totals()

    def populate_product_completer(self, combo, role=None):
        """Populate combo with products."""
        combo.clear()
        session = get_session(get_engine())
        try:
            query = session.query(Product)
            if role == 'lens':
                query = query.filter(Product.category == 'Lens')
            elif role == 'frame' or role == 'Glasses':
                query = query.filter(Product.category == 'Frame')
            elif role in ['Sunglasses', 'Accessories', 'Others', 'Contact Lenses']:
                mapping = {
                    'Sunglasses': 'Sunglasses',
                    'Accessories': 'Accessory',
                    'Others': 'Other',
                    'Contact Lenses': 'ContactLens'
                }
                db_cat = mapping.get(role, role)
                query = query.filter(Product.category == db_cat)
            
            products = query.order_by(Product.name).all()
            for p in products:
                # Show Price and Category for better selection
                combo.addItem(f"{p.name} | {_('Price')}: {p.sale_price:.2f} | {_('Category')}: {p.category}", p.id)
        finally:
            session.close()

    def populate_lens_types(self, combo):
        """Populate combo with lens types from LensType table."""
        from app.database.models import LensType
        combo.clear()
        session = get_session(get_engine())
        try:
            lens_types = session.query(LensType).order_by(LensType.name).all()
            for lt in lens_types:
                combo.addItem(lt.name, lt.id)
        finally:
            session.close()

    def populate_frame_types(self, combo):
        """Populate combo with frame types from FrameType table."""
        from app.database.models import FrameType
        combo.clear()
        session = get_session(get_engine())
        try:
            frame_types = session.query(FrameType).order_by(FrameType.name).all()
            for ft in frame_types:
                combo.addItem(ft.name, ft.id)
        finally:
            session.close()

    def populate_metadata_cb(self, combo, table_name):
        from sqlalchemy import text
        session = get_session(get_engine())
        try:
            rows = session.execute(text(f"SELECT name FROM {table_name}")).all()
            for r in rows: combo.addItem(r[0])
        except: pass
        finally: session.close()

    def ensure_lens_type_exists(self, lens_name, session=None):
        """Ensure a lens type exists in the database. Create it if not."""
        from app.database.models import LensType
        if not lens_name or not lens_name.strip():
            return None

        # Use provided session or create new one
        own_session = session is None
        if own_session:
            session = get_session(get_engine())

        try:
            existing = session.query(LensType).filter_by(name=lens_name).first()
            if existing:
                return existing.id

            # Create new lens type
            new_lens = LensType(name=lens_name)
            session.add(new_lens)
            if own_session:
                session.commit()
            else:
                session.flush()  # Just flush if using shared session
            return new_lens.id
        except Exception as e:
            if own_session:
                session.rollback()
            import logging
            logging.exception(f"Error ensuring lens type {lens_name}: {e}")
            return None
        finally:
            if own_session:
                session.close()

    def ensure_frame_type_exists(self, frame_name):
        """Ensure a frame type exists in the database. Create it if not."""
        from app.database.models import FrameType
        if not frame_name or not frame_name.strip():
            return None

        session = get_session(get_engine())
        try:
            existing = session.query(FrameType).filter_by(name=frame_name).first()
            if existing:
                return existing.id

            # Create new frame type
            new_frame = FrameType(name=frame_name)
            session.add(new_frame)
            session.commit()
            return new_frame.id
        except Exception as e:
            session.rollback()
            import logging
            logging.exception(f"Error ensuring frame type {frame_name}: {e}")
            return None
        finally:
            session.close()

    def on_products_changed(self, product_id=0):
        """Refresh product completers in existing exam rows and for future rows."""
        try:
            for row in range(self.exam_table.rowCount()):
                frame_cb = self.exam_table.cellWidget(row, 9)
                if isinstance(frame_cb, SearchableComboBox):
                    self.populate_product_completer(frame_cb, role='frame')
        except Exception:
            pass

    def on_metadata_changed(self, metadata_type=None):
        """Refresh when metadata changes (lens types, colors, etc.)"""
        try:
            # Refresh all existing exam rows
            for row in range(self.exam_table.rowCount()):
                lens_cb = self.exam_table.cellWidget(row, 8)
                frame_cb = self.exam_table.cellWidget(row, 9)
                color_cb = self.exam_table.cellWidget(row, 10)

                if isinstance(lens_cb, SearchableComboBox):
                    # Store current value
                    current_lens = lens_cb.currentText()
                    # Repopulate dropdown
                    self.populate_lens_types(lens_cb)
                    # Restore selection if it still exists, otherwise keep as is
                    if current_lens:
                        index = lens_cb.findText(current_lens)
                        if index >= 0:
                            lens_cb.setCurrentIndex(index)

                if isinstance(frame_cb, SearchableComboBox):
                    # Store current value
                    current_frame = frame_cb.currentText()
                    # Repopulate dropdown
                    self.populate_product_completer(frame_cb, role='frame')
                    # Restore selection if it still exists, otherwise keep as is
                    if current_frame:
                        index = frame_cb.findText(current_frame)
                        if index >= 0:
                            frame_cb.setCurrentIndex(index)

                if isinstance(color_cb, QComboBox):
                    # Store current value
                    current_color = color_cb.currentText()
                    # Repopulate dropdown
                    self.populate_metadata_cb(color_cb, "frame_colors")
                    # Restore selection if it still exists
                    if current_color:
                        index = color_cb.findText(current_color)
                        if index >= 0:
                            color_cb.setCurrentIndex(index)
        except Exception as e:
            import logging
            logging.exception(f"Error in on_metadata_changed: {e}")
            pass

    def update_order_step_ui(self):
        if self.current_customer:
            self.title_label.setText(f"{_('Order & Examination')} - {self.current_customer.name}")
            session = get_session(get_engine())
            self.invoice_label.setText(f"{_('Invoice:')} {get_next_invoice_no(session)}")
            self.update_past_exams(session)
            session.close()
        
        is_presc = self.selected_category in ["Glasses", "Contact Lenses"]
        self.exam_container.setVisible(is_presc)
        self.past_exams_group.setVisible(is_presc)
        
        # Hide doctor name if not glasses/contact lenses
        self.doctor_name_input.setVisible(is_presc)
        
        if is_presc and self.exam_table.rowCount() == 0: 
            self.add_exam_row()

    def update_past_exams(self, session):
        self.past_exams_table.setRowCount(0)
        from app.database.models import Sale, OrderExamination
        past_exams = session.query(OrderExamination).join(Sale).filter(Sale.customer_id == self.current_customer.id).order_by(Sale.order_date.desc()).limit(10).all()
        
        for row, ex in enumerate(past_exams):
            self.past_exams_table.insertRow(row)
            # Show date as dd/mm/yyyy
            date_str = ex.sale.order_date.strftime("%d/%m/%Y") if ex.sale.order_date else ""
            self.past_exams_table.setItem(row, 0, QTableWidgetItem(date_str))
            self.past_exams_table.setItem(row, 1, QTableWidgetItem(ex.exam_type))
            
            use_btn = QPushButton(_("Use"))
            use_btn.clicked.connect(lambda checked, data=ex: self.use_past_exam(data))
            self.past_exams_table.setCellWidget(row, 2, use_btn)

    def use_past_exam(self, ex):
        data = {
            'exam_type': ex.exam_type,
            'sphere_od': ex.sphere_od,
            'cylinder_od': ex.cylinder_od,
            'axis_od': ex.axis_od,
            'sphere_os': ex.sphere_os,
            'cylinder_os': ex.cylinder_os,
            'axis_os': ex.axis_os,
            'ipd': ex.ipd,
            'lens_info': ex.lens_info,
            'frame_info': ex.frame_info,
            'frame_color': ex.frame_color,
            'frame_status': ex.frame_status,
            'doctor_name': ex.doctor_name,
            'image_path': ex.image_path
        }
        self.add_exam_row(data)

    def calculate_totals(self):
        # Exam rows cost (manual input for now, but let's see if we should auto-calc)
        # However, the user provided 'Cost' input in the UI.
        # We should probably add the Step 3 items total to the 'Cost' or as a separate total.
        # For better UX, let's keep 'Cost' as the base (maybe exams) and add other items.
        
        exam_cost = self.cost_input.value()
        
        additional_total = 0
        if hasattr(self, 'item_table'):
            for r in range(self.item_table.rowCount()):
                try:
                    additional_total += float(self.item_table.item(r, 3).text())
                except: pass
        
        total_gross = exam_cost + additional_total
        discount = self.discount_input.value()
        paid = self.paid_input.value()
        net = total_gross - discount
        balance = net - paid
        
        self.total_input.blockSignals(True)
        self.total_input.setValue(net)
        self.total_input.blockSignals(False)
        
        self.balance_input.setValue(balance)

    def save_order(self):
        session = get_session(get_engine())
        try:
            affected_product_ids = set()
            is_update = hasattr(self, 'current_sale') and self.current_sale is not None
            
            old_lens_names = []
            if is_update:
                sale = session.query(Sale).get(self.current_sale.id)
                # Capture old lens names before deleting
                old_exams = session.query(OrderExamination).filter_by(sale_id=sale.id).all()
                
                wh = session.query(Warehouse).first()

                for ex in old_exams:
                    if ex.lens_info:
                        old_lens_names.append(ex.lens_info)
                    
                    # Return frame to inventory if it was New
                    if ex.frame_status == _("New") and ex.frame_info:
                        frame_name = ex.frame_info.split(' (')[0]
                        frame_prod = session.query(Product).filter_by(name=frame_name).first()
                        if frame_prod:
                            move = StockMovement(
                                product_id=frame_prod.id,
                                warehouse_id=wh.id if wh else None,
                                qty=1, # Return to stock
                                type="return",
                                ref_no=sale.invoice_no,
                                note=f"Order Update Return: {sale.invoice_no}"
                            )
                            session.add(move)
                            affected_product_ids.add(frame_prod.id)

                # Cleanup existing items and exams for update
                session.query(SaleItem).filter_by(sale_id=sale.id).delete()
                session.query(OrderExamination).filter_by(sale_id=sale.id).delete()
                invoice_no = sale.invoice_no
            else:
                invoice_no = get_next_invoice_no(session)
                sale = Sale(invoice_no=invoice_no, user_id=self.user.id)
                session.add(sale)
            
            sale.customer_id = self.current_customer.id
            
            exam_cost = self.cost_input.value()
            additional_total = 0
            if hasattr(self, 'item_table'):
                for r in range(self.item_table.rowCount()):
                    try:
                        additional_total += float(self.item_table.item(r, 3).text())
                    except: pass
            
            sale.total_amount = exam_cost + additional_total
            sale.discount = self.discount_input.value()
            sale.net_amount = self.total_input.value()
            sale.amount_paid = self.paid_input.value()
            sale.payment_method = "Cash"
            
            # Use combined date and current time
            q_date = self.order_date_edit.date().toPython()
            now = datetime.datetime.now()
            sale.order_date = datetime.datetime.combine(q_date, now.time())
            sale.delivery_date = self.delivery_date_edit.date().toPython()
            sale.doctor_name = self.doctor_name_input.text()
            
            session.flush()

            for row in range(self.exam_table.rowCount()):
                lens_combo = self.exam_table.cellWidget(row, 8)
                lens_text = lens_combo.currentText().strip()

                # Ensure lens type exists in Optical Settings (use shared session)
                if lens_text:
                    self.ensure_lens_type_exists(lens_text, session=session)

                frame_combo = self.exam_table.cellWidget(row, 9)
                frame_text = frame_combo.currentText().strip()
                frame_prod = None
                frame_product_id = None

                if frame_text:
                    # Parse frame text to get product name
                    # Format could be: "Name (SKU)" or just "Name" (if typed new)
                    if ' (' in frame_text:
                        parsed_name = frame_text.split(' (')[0]
                    else:
                        parsed_name = frame_text

                    # Try to find existing product by name
                    frame_prod = session.query(Product).filter_by(name=parsed_name).first()

                    # If frame product doesn't exist, create it
                    if not frame_prod:
                        frame_prod = Product(
                            name=parsed_name,
                            category='Frame',
                            sale_price=0.0,
                            cost_price=0.0
                        )
                        session.add(frame_prod)
                        session.flush()

                        # Create initial stock movement for new frame
                        wh = session.query(Warehouse).first()
                        move = StockMovement(
                            product_id=frame_prod.id,
                            warehouse_id=wh.id if wh else None,
                            qty=0,
                            type='initial'
                        )
                        session.add(move)
                        session.flush()
                        state.product_added.emit(frame_prod.id)

                    if frame_prod:
                        frame_product_id = frame_prod.id

                exam = OrderExamination(
                    sale_id=sale.id,
                    exam_type=self.exam_table.cellWidget(row, 0).currentText(),
                    sphere_os=self.exam_table.cellWidget(row, 1).text(),
                    cylinder_os=self.exam_table.cellWidget(row, 2).text(),
                    axis_os=self.exam_table.cellWidget(row, 3).text(),
                    sphere_od=self.exam_table.cellWidget(row, 4).text(),
                    cylinder_od=self.exam_table.cellWidget(row, 5).text(),
                    axis_od=self.exam_table.cellWidget(row, 6).text(),
                    ipd=self.exam_table.cellWidget(row, 7).text(),
                    lens_info=lens_text,
                    frame_info=frame_text,
                    frame_color=self.exam_table.cellWidget(row, 10).currentText(),
                    frame_status=self.exam_table.cellWidget(row, 11).currentText(),
                    image_path=self.exam_table.cellWidget(row, 12).property("image_path")
                )
                session.add(exam)

                # Deduct frame from inventory (if it's a new frame - status "New")
                status = self.exam_table.cellWidget(row, 11).currentText()
                if status == _("New") and frame_product_id:
                    wh = session.query(Warehouse).first()
                    move = StockMovement(product_id=frame_product_id, warehouse_id=wh.id if wh else None, qty=-1, type="sale", ref_no=invoice_no, note=f"POS Sale: {invoice_no}")
                    session.add(move)
                    affected_product_ids.add(frame_product_id)
                    if frame_prod:
                        si = SaleItem(sale_id=sale.id, product_id=frame_prod.id, qty=1, unit_price=frame_prod.sale_price or 0.0, total_price=frame_prod.sale_price or 0.0)
                        session.add(si)

            # Save Additional items from Step 3
            if hasattr(self, 'item_table'):
                wh = session.query(Warehouse).first()
                for row in range(self.item_table.rowCount()):
                    p_id = self.item_table.item(row, 0).data(Qt.UserRole)
                    price = float(self.item_table.item(row, 1).text())
                    qty = self.item_table.cellWidget(row, 2).value()
                    total = price * qty
                    
                    sale_item = SaleItem(
                        sale_id=sale.id,
                        product_id=p_id,
                        qty=int(qty),
                        unit_price=price,
                        total_price=total
                    )
                    session.add(sale_item)
                    
                    # Deduct from inventory
                    move = StockMovement(
                        product_id=p_id,
                        warehouse_id=wh.id if wh else None,
                        qty=-int(qty),
                        type="sale",
                        ref_no=invoice_no,
                        note=f"POS Sale: {invoice_no}"
                    )
                    session.add(move)
                    affected_product_ids.add(p_id)

            session.commit()
            
            # Cleanup unused lens types
            if old_lens_names:
                for old_name in old_lens_names:
                    # Check if this lens name is used by any other order
                    count = session.query(OrderExamination).filter_by(lens_info=old_name).count()
                    if count == 0:
                        # Not used anymore, delete from LensType
                        lens_type = session.query(LensType).filter_by(name=old_name).first()
                        if lens_type:
                            session.delete(lens_type)
                session.commit()

            self.current_sale = sale
            self.print_btn.setEnabled(True)
            self.print_btn.setStyleSheet("background-color: #2e7d32; color: white; font-size: 22px; font-weight: bold;")
            QMessageBox.information(self, _("Success"), _("Order saved successfully!"))

            # Emit signal to trigger refresh everywhere
            state.sale_added.emit(sale.id)
            state.metadata_changed.emit("LensType")
            for pid in affected_product_ids:
                state.product_updated.emit(pid)
            state.refresh_all.emit()

            # Immediately refresh THIS window's dropdowns so they show new items
            self.refresh_data()

        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), f"Failed to save order: {e}")
        finally: 
            session.close()

    def print_order(self):
        if not self.current_sale: return
        session = get_session(get_engine())
        try:
            sale = session.query(Sale).get(self.current_sale.id)
            customer = sale.customer
            exams = session.query(OrderExamination).filter_by(sale_id=sale.id).all()
            items = session.query(SaleItem).filter_by(sale_id=sale.id).all()
            shop_name = get_setting(session, 'store_name', 'Optical Shop')
            shop_addr = get_setting(session, 'store_address', 'Address')
            shop_phone = get_setting(session, 'store_phone', 'Number')
            
            # New date format: 16/01/2026 م 08:43
            date_format = "%d/%m/%Y م %H:%M"
            order_date_str = sale.order_date.strftime(date_format) if sale.order_date else '---'
            delivery_date_str = sale.delivery_date.strftime("%d/%m/%Y") if sale.delivery_date else '---'
            doctor_name = sale.doctor_name or '---'

            item_list_str = ""
            for itm in items:
                prod = itm.product
                item_list_str += f"{prod.name:<25} {itm.qty:>3} {itm.unit_price:>8.2f} {itm.total_price:>10.2f}\n"

            # 1. LAB RECIPE (Only Exams)
            lab_c = ""
            if exams:
                lab_c = f"--- {_('LAB COPY')} ---\n"
                lab_c += f"{shop_name}\n{shop_addr} | {shop_phone}\n"
                lab_c += f"{_('Invoice:')} {sale.invoice_no}\n"
                lab_c += f"{_('Date')}: {order_date_str}\n"
                lab_c += f"{_('Delivery Date')}: {delivery_date_str}\n"
                lab_c += f"{_('Doctor Name')}: {doctor_name}\n"
                lab_c += "-"*40 + "\n"
                for i, ex in enumerate(exams):
                    lab_c += f"#{i+1} ({ex.exam_type}):\n"
                    lab_c += f"  L: {ex.sphere_os} / {ex.cylinder_os} x {ex.axis_os}\n"
                    lab_c += f"  R: {ex.sphere_od} / {ex.cylinder_od} x {ex.axis_od}\n"
                    lab_c += f"  IPD: {ex.ipd} | Lens: {ex.lens_info}\n"
                    lab_c += f"  Frame: {ex.frame_info} ({ex.frame_color})\n"
                lab_c += "\n"

            # 2. CUSTOMER COPY
            cust_c = f"--- {_('CUSTOMER COPY')} ---\n"
            cust_c += f"{shop_name}\n{shop_addr} | {shop_phone}\n"
            cust_c += f"{_('Invoice:')} {sale.invoice_no}\n"
            cust_c += f"{_('Date')}: {order_date_str}\n"
            cust_c += f"{_('Customer')}: {customer.name}\n"
            cust_c += "-"*40 + "\n"
            cust_c += f"{_('Item'):<25} {_('Qty'):>3} {_('Price'):>8} {_('Total'):>10}\n"
            cust_c += "-"*40 + "\n"
            cust_c += item_list_str
            if exams:
                cust_c += f"({_('Including prescription items')})\n"
            cust_c += "-"*40 + "\n"
            cust_c += f"{_('Total after discount')}: {sale.net_amount:>10.2f}\n"
            cust_c += f"{_('Amount Paid')}: {sale.amount_paid:>10.2f}\n"
            cust_c += f"{_('Remaining balance to be paid')}: {sale.net_amount - sale.amount_paid:>10.2f}\n"
            cust_c += "\n"

            # 3. SHOP COPY
            shop_c = f"--- {_('SHOP COPY')} ---\n"
            shop_c += f"{shop_name}\n{shop_addr} | {shop_phone}\n"
            shop_c += f"{_('Invoice:')} {sale.invoice_no} | {_('Customer')}: {customer.name}\n"
            shop_c += f"{_('Date')}: {order_date_str}\n"
            shop_c += f"{_('Doctor')}: {doctor_name} | {_('Phone')}: {customer.phone}\n"
            shop_c += "-"*40 + "\n"
            if exams:
                for i, ex in enumerate(exams):
                    shop_c += f"#{i+1} ({ex.exam_type}): L:{ex.sphere_os}/{ex.cylinder_os}x{ex.axis_os} R:{ex.sphere_od}/{ex.cylinder_od}x{ex.axis_od}\n"
                    shop_c += f"     IPD:{ex.ipd} | Lens:{ex.lens_info} | Frame:{ex.frame_info} ({ex.frame_color})\n"
                shop_c += "-"*40 + "\n"
            shop_c += f"{_('Items Summary')}:\n"
            shop_c += item_list_str
            shop_c += "-"*40 + "\n"
            shop_c += f"{_('Total')}: {sale.net_amount:>10.2f} | {_('Paid')}: {sale.amount_paid:>10.2f} | {_('Balance')}: {sale.net_amount - sale.amount_paid:>10.2f}\n"

            full_content = ""
            if lab_c: full_content += lab_c + "\n" + "="*50 + "\n\n"
            full_content += cust_c + "\n" + "="*50 + "\n\n" + shop_c
            
            preview = PrintPreviewDialog(full_content, self)
            if preview.exec():
                QMessageBox.information(self, _("Success"), _("Order printed successfully!"))
                self.reset_pos()
        finally: session.close()

    def reset_pos(self):
        self.current_customer = None
        self.current_sale = None
        self.selected_category = "Glasses"
        if hasattr(self, 'item_table'):
            self.item_table.setRowCount(0)
        self.c_name.clear(); self.c_phone.clear(); self.c_phone2.clear(); self.c_city.clear(); self.c_email.clear(); self.c_address.clear()
        self.doctor_name_input.clear()
        self.cust_table.setRowCount(0); self.exam_table.setRowCount(0)
        if hasattr(self, 'other_items_summary'):
            self.other_items_summary.hide()
        self.cost_input.setValue(0); self.discount_input.setValue(0); self.paid_input.setValue(0)
        self.print_btn.setEnabled(False)
        self.print_btn.setStyleSheet("background-color: #607d8b; color: white; font-size: 22px; font-weight: bold;")
        self.stack.setCurrentIndex(0)
        self.title_label.setText(_("Sales POS"))
