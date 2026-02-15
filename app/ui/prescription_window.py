# app/ui/prescription_window.py
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem, 
    QPushButton, QLabel, QHeaderView, QMessageBox, QGroupBox, QFormLayout, 
    QLineEdit, QTextEdit, QGridLayout, QFileDialog, QComboBox
)
from PySide6.QtCore import Qt, QDateTime, QUrl
from PySide6.QtGui import QDesktopServices
import os
import shutil
from app.database.db_manager import get_engine, get_session
from app.database.models import Prescription
from app.core.i18n import _

class PrescriptionWindow(QWidget):
    def __init__(self, customer):
        super().__init__()
        self.customer = customer
        self.setWindowTitle(f"{_('Prescriptions')} - {customer.name}")
        self.setMinimumSize(1100, 850)
        self.attached_image_path = None
        self.init_ui()
        self.load_data()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(15)
        
        header_layout = QHBoxLayout()
        header = QLabel(f"{_('Prescriptions')} - {self.customer.name}")
        header.setStyleSheet("font-size: 24px; font-weight: bold; color: #1976d2;")
        header_layout.addWidget(header)
        header_layout.addStretch()
        
        # Add a refresh button
        refresh_btn = QPushButton(_("Refresh"))
        refresh_btn.clicked.connect(self.load_data)
        header_layout.addWidget(refresh_btn)
        layout.addLayout(header_layout)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels([_("Date"), _("Doctor"), _("Type"), _("Source"), _("Action")])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.horizontalHeader().setStyleSheet("font-size: 18px; font-weight: bold;")
        self.table.setStyleSheet("font-size: 18px;")
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.itemSelectionChanged.connect(self.on_prescription_selected)
        layout.addWidget(self.table)

        # New Prescription Form (Table Style)
        form_group = QGroupBox(_("Add Eye Examination"))
        form_group.setStyleSheet("font-size: 18px; font-weight: bold;")
        form_layout = QVBoxLayout()
        form_layout.setSpacing(15)
        
        table_controls = QHBoxLayout()
        add_row_btn = QPushButton("+")
        add_row_btn.setFixedSize(35, 35)
        add_row_btn.setStyleSheet("font-size: 20px; font-weight: bold; background-color: #4caf50; color: white; border-radius: 17px;")
        add_row_btn.clicked.connect(self.add_exam_row)
        table_controls.addStretch()
        table_controls.addWidget(add_row_btn)
        
        clear_rows_btn = QPushButton(_("Clear Table"))
        clear_rows_btn.clicked.connect(self.clear_exam_table)
        table_controls.addWidget(clear_rows_btn)
        form_layout.addLayout(table_controls)

        self.exam_table = QTableWidget(0, 8)
        self.exam_table.setLayoutDirection(Qt.LeftToRight)
        self.exam_table.setHorizontalHeaderLabels([
             _("Type"), "L.SPH", "L.CYL", "L.AXIS", "R.SPH", "R.CYL", "R.AXIS", "IPD"
        ])
        self.exam_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.exam_table.setMinimumHeight(200)
        
        # Initialize with one row
        self.add_exam_row()
            
        form_layout.addWidget(self.exam_table)

        # Other fields
        other_form = QFormLayout()
        other_form.setSpacing(10)
        i_style = "font-size: 16px; height: 35px; font-weight: normal;"
        self.doctor_input = QLineEdit()
        self.doctor_input.setStyleSheet(i_style)
        self.notes_input = QTextEdit()
        self.notes_input.setStyleSheet("font-size: 16px; font-weight: normal;")
        self.notes_input.setMaximumHeight(80)
        
        lbl_doctor = QLabel(_("Doctor Name") + ":"); lbl_doctor.setStyleSheet("font-size: 16px; font-weight: bold;")
        lbl_notes = QLabel(_("Notes") + ":"); lbl_notes.setStyleSheet("font-size: 16px; font-weight: bold;")
        
        other_form.addRow(lbl_doctor, self.doctor_input)
        other_form.addRow(lbl_notes, self.notes_input)
        
        # Image attachment
        img_hb = QHBoxLayout()
        self.attach_btn = QPushButton(_("Attach Examination Picture"))
        self.attach_btn.setMinimumHeight(40)
        self.attach_btn.setStyleSheet("font-size: 14px; font-weight: normal;")
        self.attach_btn.clicked.connect(self.attach_image)
        
        self.view_img_btn = QPushButton(_("View Attached Image"))
        self.view_img_btn.setMinimumHeight(40)
        self.view_img_btn.setStyleSheet("font-size: 14px; font-weight: bold; background-color: #0288d1; color: white;")
        self.view_img_btn.setVisible(False)
        self.view_img_btn.clicked.connect(self.view_current_image)
        
        self.image_label = QLabel(_("No image attached"))
        self.image_label.setStyleSheet("font-size: 14px; color: gray; font-weight: normal;")
        
        img_hb.addWidget(self.attach_btn)
        img_hb.addWidget(self.view_img_btn)
        img_hb.addWidget(self.image_label)
        
        lbl_attach = QLabel(_("Attachment") + ":"); lbl_attach.setStyleSheet("font-size: 16px; font-weight: bold;")
        other_form.addRow(lbl_attach, img_hb)

        form_layout.addLayout(other_form)

        save_btn = QPushButton(_("Save Prescription"))
        save_btn.setMinimumHeight(60)
        save_btn.setStyleSheet("font-size: 20px; font-weight: bold; background-color: #2e7d32; color: white;")
        save_btn.clicked.connect(self.save_rx)
        form_layout.addWidget(save_btn)

        form_group.setLayout(form_layout)
        layout.addWidget(form_group)

        self.setLayout(layout)

    def add_exam_row(self):
        from PySide6.QtGui import QIntValidator
        row = self.exam_table.rowCount()
        self.exam_table.insertRow(row)
        
        type_cb = QComboBox()
        type_cb.addItems([_("Distance"), _("Reading"), _("Contact Lenses")])
        type_cb.setEditable(True)
        if row == 0: type_cb.setCurrentText(_("Distance"))
        elif row == 1: type_cb.setCurrentText(_("Reading"))
        self.exam_table.setCellWidget(row, 0, type_cb)
        
        for i in range(1, 8):
            le = QLineEdit(); le.setAlignment(Qt.AlignCenter)
            if i in [3, 6, 7]: # AXIS and IPD
                le.setValidator(QIntValidator(0, 360))
            self.exam_table.setCellWidget(row, i, le)

    def clear_exam_table(self):
        self.exam_table.setRowCount(0)

    def load_data(self):
        session = get_session(get_engine())
        try:
            from app.database.models import Prescription, OrderExamination, Sale
            rxs = session.query(Prescription).filter_by(customer_id=self.customer.id).all()
            pos_exams = session.query(OrderExamination).join(Sale).filter(Sale.customer_id == self.customer.id).all()
            
            # Group POS exams by Sale
            pos_groups = {}
            for ex in pos_exams:
                if ex.sale_id not in pos_groups:
                    pos_groups[ex.sale_id] = []
                pos_groups[ex.sale_id].append(ex)

            all_records = []
            for rx in rxs:
                all_records.append({
                    'id': rx.id,
                    'date': rx.created_at,
                    'doctor': rx.doctor_name,
                    'type': rx.type,
                    'notes': rx.notes,
                    'source': 'Manual',
                    'data': rx
                })
            
            for sale_id, exams in pos_groups.items():
                first = exams[0]
                all_records.append({
                    'id': sale_id,
                    'date': first.sale.order_date,
                    'doctor': f"{_('POS Order')} #{first.sale.invoice_no}",
                    'type': f"{len(exams)} {_('Exams')}",
                    'notes': "",
                    'source': 'POS',
                    'data': exams
                })
            
            all_records.sort(key=lambda x: x['date'], reverse=True)
            
            self.table.setRowCount(0)
            self.records = all_records
            for row, rec in enumerate(all_records):
                self.table.insertRow(row)
                # Display date as dd/mm/yyyy
                date_str = rec['date'].strftime("%d/%m/%Y") if rec['date'] else ""
                self.table.setItem(row, 0, QTableWidgetItem(date_str))
                self.table.setItem(row, 1, QTableWidgetItem(rec['doctor']))
                self.table.setItem(row, 2, QTableWidgetItem(rec['type']))
                self.table.setItem(row, 3, QTableWidgetItem(rec['source']))
                
                view_btn = QPushButton(_("View"))
                view_btn.clicked.connect(lambda checked, r=rec: self.show_record_details(r))
                self.table.setCellWidget(row, 4, view_btn)
                
        finally:
            session.close()

    def show_record_details(self, rec):
        self.clear_exam_table()
        data_list = rec['data']
        is_pos = rec['source'] == 'POS'
        
        if is_pos:
            # data_list is a list of OrderExamination
            for i, data in enumerate(data_list):
                self.add_exam_row()
                self.exam_table.cellWidget(i, 0).setCurrentText(data.exam_type or "")
                self.exam_table.cellWidget(i, 1).setText(data.sphere_os or "")
                self.exam_table.cellWidget(i, 2).setText(data.cylinder_os or "")
                self.exam_table.cellWidget(i, 3).setText(data.axis_os or "")
                self.exam_table.cellWidget(i, 4).setText(data.sphere_od or "")
                self.exam_table.cellWidget(i, 5).setText(data.cylinder_od or "")
                self.exam_table.cellWidget(i, 6).setText(data.axis_od or "")
                self.exam_table.cellWidget(i, 7).setText(data.ipd or "")
            
            self.doctor_input.setText(data_list[0].sale.doctor_name or f"{_('POS Order')} #{data_list[0].sale.invoice_no}")
            notes = ""
            for i, data in enumerate(data_list):
                notes += f"Exam {i+1} ({data.exam_type}): Lens: {data.lens_info}, Frame: {data.frame_info}\n"
            self.notes_input.setPlainText(notes)
            
            img_path = data_list[0].image_path
        else:
            # Manual Prescription
            data = data_list
            self.add_exam_row()
            self.exam_table.cellWidget(0, 0).setCurrentText(data.type or "")
            self.exam_table.cellWidget(0, 1).setText(data.sphere_os or "")
            self.exam_table.cellWidget(0, 2).setText(data.cylinder_os or "")
            self.exam_table.cellWidget(0, 3).setText(data.axis_os or "")
            self.exam_table.cellWidget(0, 4).setText(data.sphere_od or "")
            self.exam_table.cellWidget(0, 5).setText(data.cylinder_od or "")
            self.exam_table.cellWidget(0, 6).setText(data.axis_od or "")
            self.exam_table.cellWidget(0, 7).setText(data.ipd_od or "")
            self.doctor_input.setText(data.doctor_name or "")
            self.notes_input.setPlainText(data.notes or "")
            img_path = data.image_path
            
        if img_path and os.path.exists(img_path):
            self.image_label.setText(os.path.basename(img_path))
            self.view_img_btn.setVisible(True)
            self.current_view_image_path = img_path
        else:
            self.image_label.setText(_("No image attached"))
            self.view_img_btn.setVisible(False)
            self.current_view_image_path = None

    def on_prescription_selected(self):
        pass

    def save_rx(self):
        # Ensure uploads directory exists
        if not os.path.exists("uploads"):
            os.makedirs("uploads")

        final_image_path = None
        if self.attached_image_path:
            filename = f"rx_{self.customer.id}_{int(QDateTime.currentDateTime().toMSecsSinceEpoch()/1000)}{os.path.splitext(self.attached_image_path)[1]}"
            dest = os.path.join("uploads", filename)
            try:
                shutil.copy(self.attached_image_path, dest)
                final_image_path = dest
            except Exception as e:
                QMessageBox.warning(self, _("Warning"), f"Failed to copy image: {e}")

        session = get_session(get_engine())
        try:
            from app.database.models import Prescription
            # Save all rows from exam_table as separate prescriptions
            for row in range(self.exam_table.rowCount()):
                rx = Prescription(
                    customer_id=self.customer.id,
                    type=self.exam_table.cellWidget(row, 0).currentText(),
                    sphere_os=self.exam_table.cellWidget(row, 1).text(),
                    cylinder_os=self.exam_table.cellWidget(row, 2).text(),
                    axis_os=self.exam_table.cellWidget(row, 3).text(),
                    sphere_od=self.exam_table.cellWidget(row, 4).text(),
                    cylinder_od=self.exam_table.cellWidget(row, 5).text(),
                    axis_od=self.exam_table.cellWidget(row, 6).text(),
                    ipd_od=self.exam_table.cellWidget(row, 7).text(),
                    ipd_os=self.exam_table.cellWidget(row, 7).text(),
                    doctor_name=self.doctor_input.text(),
                    image_path=final_image_path,
                    notes=self.notes_input.toPlainText()
                )
                session.add(rx)
            
            session.commit()
            QMessageBox.information(self, _("Success"), _("Prescription saved successfully!"))
            self.load_data()
            self.clear_form()
        except Exception as e:
            session.rollback()
            QMessageBox.critical(self, _("Error"), str(e))
        finally:
            session.close()

    def clear_form(self):
        self.clear_exam_table()
        self.add_exam_row()
        self.doctor_input.clear(); self.notes_input.clear()
        self.attached_image_path = None
        self.current_view_image_path = None
        self.image_label.setText(_("No image attached"))
        self.view_img_btn.setVisible(False)

    def attach_image(self):
        file_path, _filter = QFileDialog.getOpenFileName(self, _("Select Image"), "", "Images (*.png *.jpg *.jpeg *.bmp)")
        if file_path:
            self.attached_image_path = file_path
            self.image_label.setText(os.path.basename(file_path))

    def view_current_image(self):
        if hasattr(self, 'current_view_image_path') and self.current_view_image_path:
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.current_view_image_path))
        elif self.attached_image_path:
            QDesktopServices.openUrl(QUrl.fromLocalFile(self.attached_image_path))
