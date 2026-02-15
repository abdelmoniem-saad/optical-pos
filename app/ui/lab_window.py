# app/ui/lab_window.py
import datetime
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem, 
    QPushButton, QLabel, QHeaderView, QMessageBox, QGridLayout, QLineEdit, QComboBox
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import Sale, Customer, OrderExamination
from app.core.i18n import _
from app.core.permissions import has_permission
from app.core.state import state

class LabWindow(QWidget):
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
        header_layout = QGridLayout()
        back_btn = QPushButton(_("← Back to Dashboard"))
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header_layout.addWidget(back_btn, 0, 0, Qt.AlignLeft)

        title = QLabel(_("Lab Management"))
        title.setStyleSheet("font-size: 36px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        
        layout.addLayout(header_layout)

        # Search and Filter
        top_bar = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText(_("Search by Invoice or Customer ID..."))
        self.search_input.setMinimumHeight(65)
        self.search_input.setStyleSheet("font-size: 22px; padding: 10px;")
        self.search_input.textChanged.connect(self.load_data)
        top_bar.addWidget(self.search_input, 3)

        self.status_filter = QComboBox()
        # Display Arabic labels but keep canonical status codes as userData
        self.status_filter.addItem(_("All"), None)
        self.status_filter.addItem('لم يبدأ', 'Not Started')
        self.status_filter.addItem('قيد العمل', 'In Lab')
        self.status_filter.addItem('جاهز', 'Ready')
        self.status_filter.addItem('استلم', 'Received')
        self.status_filter.setMinimumHeight(65)
        self.status_filter.setStyleSheet("font-size: 20px;")
        top_bar.addWidget(self.status_filter, 1)
        
        layout.addLayout(top_bar)

        # Table
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels([_("Date"), _("Invoice"), _("Customer ID"), _("Lab Status"), _("Details"), _("Action")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setStyleSheet("font-size: 20px; font-weight: bold;")
        self.table.setStyleSheet("font-size: 20px;")
        layout.addWidget(self.table)

        self.setLayout(layout)

    def refresh_data(self):
        """Refresh all lab data - called automatically when sales change"""
        self.load_data()

    def load_data(self):
        query_text = self.search_input.text().strip() if hasattr(self, 'search_input') else ""
        status_val = self.status_filter.currentText() if hasattr(self, 'status_filter') else ""

        session = get_session(get_engine())
        try:
            from app.database.models import OrderExamination
            # Only show sales that have eye examinations
            query = session.query(Sale).join(Customer, isouter=True).join(OrderExamination)
            
            if query_text:
                query = query.filter(
                    (Sale.invoice_no.ilike(f"%{query_text}%")) |
                    (Sale.customer_id == int(query_text) if query_text.isdigit() else False)
                )
            
            # status_val is display label; map to canonical code if necessary
            status_code = self.status_filter.currentData() if hasattr(self, 'status_filter') else None
            if status_code:
                query = query.filter(Sale.lab_status == status_code)

            sales = query.order_by(Sale.order_date.desc()).all()

            if not hasattr(self, 'table'):
                return  # UI not ready yet

            self.table.setRowCount(0)

            for row_idx, s in enumerate(sales):
                self.table.insertRow(row_idx)
                # Display date as dd/mm/yyyy م HH:MM
                self.table.setItem(row_idx, 0, QTableWidgetItem(s.order_date.strftime("%d/%m/%Y م %H:%M") if s.order_date else ""))
                self.table.setItem(row_idx, 1, QTableWidgetItem(s.invoice_no or ""))
                self.table.setItem(row_idx, 2, QTableWidgetItem(str(s.customer_id) if s.customer_id else "N/A"))
                
                # Display localized status label while keeping canonical codes in DB
                status_map = {
                    'Not Started': 'لم يبدأ',
                    'In Lab': 'قيد العمل',
                    'Ready': 'جاهز',
                    'Received': 'استلم'
                }
                status_code = s.lab_status or 'Not Started'
                status_label = status_map.get(status_code, status_code)
                status_item = QTableWidgetItem(status_label)
                if status_code == 'Ready':
                    status_item.setForeground(Qt.blue)
                elif status_code == 'In Lab':
                    status_item.setForeground(Qt.darkYellow)
                elif status_code == 'Received':
                    status_item.setForeground(Qt.green)
                self.table.setItem(row_idx, 3, status_item)
                
                view_btn = QPushButton(_("Print Lab Copy"))
                view_btn.clicked.connect(lambda checked, sid=s.id: self.print_lab_copy(sid))
                self.table.setCellWidget(row_idx, 4, view_btn)
                
                status_cb = QComboBox()
                status_cb.addItem('لم يبدأ', 'Not Started')
                status_cb.addItem('قيد العمل', 'In Lab')
                status_cb.addItem('جاهز', 'Ready')
                status_cb.addItem('استلم', 'Received')
                # set index by matching userData
                target_code = s.lab_status or 'Not Started'
                for i in range(status_cb.count()):
                    if status_cb.itemData(i) == target_code:
                        status_cb.setCurrentIndex(i)
                        break
                # emit canonical code when changed
                status_cb.currentIndexChanged.connect(lambda idx, sid=s.id, cb=status_cb: self.update_status(sid, cb.itemData(idx)))
                self.table.setCellWidget(row_idx, 5, status_cb)
        except Exception as e:
            import logging
            logger = logging.getLogger()
            logger.exception("Error loading lab data: %s", e)
        finally:
            session.close()

    def update_status(self, sale_id, new_status):
        session = get_session(get_engine())
        try:
            sale = session.query(Sale).get(sale_id)
            if sale:
                sale.lab_status = new_status
                if new_status == "Received":
                    sale.is_received = True
                    sale.receiving_date = datetime.datetime.utcnow()
                session.commit()
                state.sale_updated.emit(sale_id)
        except Exception as e:
            QMessageBox.critical(self, _("Error"), str(e))
        finally:
            session.close()

    def print_lab_copy(self, sale_id):
        session = get_session(get_engine())
        try:
            sale = session.query(Sale).get(sale_id)
            exams = session.query(OrderExamination).filter_by(sale_id=sale.id).all()
            
            # Lab copy should NOT show name or prices, but should have IDs
            content = f"طلب مختبر - فاتورة: {sale.invoice_no}\n"
            content += f"معرّف العميل: {sale.customer_id}\n"
            content += f"التاريخ: {sale.order_date.strftime('%d/%m/%Y م %H:%M')}\n"
            content += "-"*40 + "\n"
            for i, ex in enumerate(exams):
                content += f"المقاس #{i+1} ({ex.exam_type})\n"
                if ex.doctor_name:
                    content += f"  Doctor: {ex.doctor_name}\n"
                content += f"  L: SPH {ex.sphere_os} CYL {ex.cylinder_os} AXIS {ex.axis_os}\n"
                content += f"  R: SPH {ex.sphere_od} CYL {ex.cylinder_od} AXIS {ex.axis_od}\n"
                content += f"  IPD: {ex.ipd}\n"
                content += f"  Lens: {ex.lens_info}\n"
                content += f"  Frame: {ex.frame_info} ({ex.frame_color})\n"
                content += "."*20 + "\n"
            content += "-"*40 + "\n"
            content += "خاص للمختبر فقط\n"

            from app.ui.pos_window import PrintPreviewDialog
            preview = PrintPreviewDialog(content, self)
            preview.exec()
        finally:
            session.close()

