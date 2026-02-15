# app/ui/invoice_detail_dialog.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, 
    QTextEdit, QTableWidget, QTableWidgetItem, QHeaderView, QGroupBox, QMessageBox
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import Sale, OrderExamination
from app.core.i18n import _

class InvoiceDetailDialog(QDialog):
    def __init__(self, sale_id, parent=None):
        super().__init__(parent)
        self.sale_id = sale_id
        self.setWindowTitle(_("Invoice Details"))
        self.setMinimumSize(900, 800)
        self.init_ui()
        self.load_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(30, 30, 30, 30)
        layout.setSpacing(20)

        self.info_label = QLabel()
        self.info_label.setStyleSheet("font-size: 24px; font-weight: bold; color: #1976d2;")
        layout.addWidget(self.info_label)

        # Examinations Table
        self.exam_group = QGroupBox(_("Eye Examinations"))
        self.exam_group.setStyleSheet("font-size: 22px; font-weight: bold;")
        exam_layout = QVBoxLayout(self.exam_group)
        self.exam_table = QTableWidget(0, 10)
        self.exam_table.setLayoutDirection(Qt.LeftToRight)
        self.exam_table.setHorizontalHeaderLabels([
            _("Exam Type"), "L.SPH", "L.CYL", "L.AXIS", "R.SPH", "R.CYL", "R.AXIS", "IPD", _("Lens Specifications"), _("Frame")
        ])
        self.exam_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.exam_table.setStyleSheet("font-size: 20px;")
        self.exam_table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.exam_table.setMinimumHeight(250)
        exam_layout.addWidget(self.exam_table)
        layout.addWidget(self.exam_group)

        # Other Items Table
        self.items_group = QGroupBox(_("Other Items"))
        self.items_group.setStyleSheet("font-size: 22px; font-weight: bold;")
        items_layout = QVBoxLayout(self.items_group)
        self.items_table = QTableWidget(0, 4)
        self.items_table.setHorizontalHeaderLabels([_("Item"), _("Price"), _("Qty"), _("Total")])
        self.items_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.items_table.setStyleSheet("font-size: 20px;")
        self.items_table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.items_table.setMinimumHeight(200)
        items_layout.addWidget(self.items_table)
        layout.addWidget(self.items_group)

        # Totals
        fin_group = QGroupBox(_("Order Details"))
        fin_group.setStyleSheet("font-size: 22px; font-weight: bold;")
        fin_layout = QVBoxLayout(fin_group)
        self.totals_label = QLabel()
        self.totals_label.setStyleSheet("font-size: 24px; font-weight: bold; color: #2e7d32;")
        fin_layout.addWidget(self.totals_label)
        layout.addWidget(fin_group)

        # Buttons
        btns = QHBoxLayout()
        btns.setSpacing(15)
        
        self.print_btn = QPushButton(_("Print"))
        self.print_btn.setMinimumHeight(70)
        self.print_btn.setStyleSheet("background-color: #2e7d32; color: white; font-weight: bold; font-size: 22px; border-radius: 10px;")
        self.print_btn.clicked.connect(self.print_invoice)
        btns.addWidget(self.print_btn)

        self.receive_btn = QPushButton(_("Mark as Received"))
        self.receive_btn.setMinimumHeight(70)
        self.receive_btn.setStyleSheet("background-color: #f57c00; color: white; font-weight: bold; font-size: 22px; border-radius: 10px;")
        self.receive_btn.setVisible(False)
        btns.addWidget(self.receive_btn)

        close_btn = QPushButton(_("Close"))
        close_btn.setMinimumHeight(70)
        close_btn.setStyleSheet("font-size: 22px; border-radius: 10px;")
        close_btn.clicked.connect(self.accept)
        btns.addWidget(close_btn)
        
        layout.addLayout(btns)
        self.setLayout(layout)

    def load_data(self):
        session = get_session(get_engine())
        try:
            sale = session.query(Sale).get(self.sale_id)
            if not sale: return

            info = f"{_('Invoice:')} {sale.invoice_no} | "
            info += f"{_('Date')}: {sale.order_date.strftime('%d/%m/%Y م %H:%M')} | "
            info += f"{_('Customer')}: {sale.customer.name if sale.customer else _('N/A')}\n"
            status_text = _("Received") if sale.is_received else _("Pending")
            info += f"{_('Status')}: {status_text}"
            if sale.delivery_date:
                info += f" | {_('Delivery Date')}: {sale.delivery_date.strftime('%d/%m/%Y')}"
            if sale.doctor_name:
                info += f" | {_('Doctor Name')}: {sale.doctor_name}"

            self.info_label.setText(info)

            exams = session.query(OrderExamination).filter_by(sale_id=self.sale_id).all()
            self.exam_table.setRowCount(0)
            if not exams:
                self.exam_group.hide()
            else:
                self.exam_group.show()
                for row, ex in enumerate(exams):
                    self.exam_table.insertRow(row)
                    self.exam_table.setItem(row, 0, QTableWidgetItem(ex.exam_type or ""))
                    self.exam_table.setItem(row, 1, QTableWidgetItem(ex.sphere_os or ""))
                    self.exam_table.setItem(row, 2, QTableWidgetItem(ex.cylinder_os or ""))
                    self.exam_table.setItem(row, 3, QTableWidgetItem(ex.axis_os or ""))
                    self.exam_table.setItem(row, 4, QTableWidgetItem(ex.sphere_od or ""))
                    self.exam_table.setItem(row, 5, QTableWidgetItem(ex.cylinder_od or ""))
                    self.exam_table.setItem(row, 6, QTableWidgetItem(ex.axis_od or ""))
                    self.exam_table.setItem(row, 7, QTableWidgetItem(ex.ipd or ""))
                    self.exam_table.setItem(row, 8, QTableWidgetItem(ex.lens_info or ""))
                    self.exam_table.setItem(row, 9, QTableWidgetItem(f"{ex.frame_info or ''} ({ex.frame_color or ''})"))

            from app.database.models import SaleItem
            items = session.query(SaleItem).filter_by(sale_id=self.sale_id).all()
            self.items_table.setRowCount(0)
            if not items:
                self.items_group.hide()
            else:
                self.items_group.show()
                for row, itm in enumerate(items):
                    self.items_table.insertRow(row)
                    self.items_table.setItem(row, 0, QTableWidgetItem(itm.product.name))
                    self.items_table.setItem(row, 1, QTableWidgetItem(f"{itm.unit_price:.2f}"))
                    self.items_table.setItem(row, 2, QTableWidgetItem(str(itm.qty)))
                    self.items_table.setItem(row, 3, QTableWidgetItem(f"{itm.total_price:.2f}"))

            totals = f"{_('Gross Total')}: {sale.total_amount:.2f} | "
            totals += f"{_('Discount')}: {sale.discount:.2f}\n"
            totals += f"{_('Total after discount')}: {sale.net_amount:.2f} | "
            totals += f"{_('Amount Paid')}: {sale.amount_paid:.2f} | "
            remaining = sale.net_amount - sale.amount_paid
            totals += f"{_('Remaining balance to be paid')}: {remaining:.2f}"
            self.totals_label.setText(totals)

            if not sale.is_received:
                self.receive_btn.setVisible(True)
                # Correct lambda to use parent method properly
                self.receive_btn.clicked.connect(self.handle_receive)

        finally:
            session.close()

    def handle_receive(self):
        if hasattr(self.parent(), 'mark_as_received'):
            self.parent().mark_as_received(self.sale_id)
            self.accept()

    def print_invoice(self):
        session = get_session(get_engine())
        try:
            sale = session.query(Sale).get(self.sale_id)
            from app.ui.pos_window import PrintPreviewDialog
            from app.database.db_manager import get_setting
            from app.database.models import SaleItem
            
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
            preview.exec()
        finally:
            session.close()

