# app/ui/optical_settings_window.py
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, 
    QTableWidget, QTableWidgetItem, QHeaderView, QInputDialog, QMessageBox, QTabWidget
)
from PySide6.QtCore import Qt
from app.database.db_manager import get_engine, get_session
from app.database.models import LensType, FrameType, FrameColor, ContactLensType
from app.core.i18n import _
from app.core.state import state

class OpticalSettingsWindow(QWidget):
    def __init__(self, user, back_callback):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
        self.tab_data = {}  # Store references to tabs for refresh
        self.init_ui()
        # Connect to metadata changes to refresh data
        state.metadata_changed.connect(self.refresh_data)

    def refresh_data(self, metadata_type=None):
        """Refresh all tab data from database"""
        try:
            for model_class, table in self.tab_data.items():
                self.load_tab_data(model_class, table)
        except Exception as e:
            import logging
            logging.exception(f"Error refreshing optical settings: {e}")


    def init_ui(self):
        # Use Arabic title (measurements table remains in English per requirement)
        self.setWindowTitle("إعدادات المتجر البصري")
        self.setMinimumSize(1000, 750)
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(15)

        # Header
        header = QHBoxLayout()
        back_btn = QPushButton("← رجوع")
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header.addWidget(back_btn)
        
        title = QLabel("إعدادات خاصة بالعدسات والإطارات")
        title.setStyleSheet("font-size: 24px; font-weight: bold;")
        header.addWidget(title, 1, Qt.AlignCenter)
        layout.addLayout(header)

        self.tabs = QTabWidget()
        self.tabs.setStyleSheet("QTabBar::tab { height: 40px; font-size: 16px; min-width: 150px; }")
        
        # Tabs for Lens Types, Contact Lenses, Frame Types, Colors
        # Keep tab labels Arabic and consistent
        self.init_tab(self.tabs, 'عدسات', LensType)
        self.init_tab(self.tabs, 'عدسات لاصقة', ContactLensType)
        self.init_tab(self.tabs, 'فريمات', FrameType)
        self.init_tab(self.tabs, 'ألوان الإطار', FrameColor)

        layout.addWidget(self.tabs)
        self.setLayout(layout)

    def init_tab(self, parent_tabs, label, model_class):
        tab = QWidget()
        ly = QVBoxLayout()
        ly.setContentsMargins(15, 15, 15, 15)
        ly.setSpacing(15)
        
        table = QTableWidget(0, 1)
        # Use Arabic header for the name column
        table.setHorizontalHeaderLabels(["الاسم"])
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        table.horizontalHeader().setStyleSheet("font-size: 18px; font-weight: bold;")
        table.setStyleSheet("font-size: 18px;")
        ly.addWidget(table)
        
        btns = QHBoxLayout()
        # Button labels in Arabic
        add_btn = QPushButton(f"إضافة {label}")
        add_btn.setMinimumHeight(50)
        add_btn.setStyleSheet("font-size: 16px; font-weight: bold; background-color: #2e7d32; color: white;")
        add_btn.clicked.connect(lambda: self.add_entry(model_class, table))
        btns.addWidget(add_btn)
        
        del_btn = QPushButton("حذف المحدد")
        del_btn.setMinimumHeight(50)
        del_btn.setStyleSheet("font-size: 16px; background-color: #d32f2f; color: white;")
        del_btn.clicked.connect(lambda: self.delete_entry(model_class, table))
        btns.addWidget(del_btn)
        
        ly.addLayout(btns)
        tab.setLayout(ly)
        parent_tabs.addTab(tab, label)
        
        # Store reference for refresh capability
        self.tab_data[model_class] = table

        # Load data
        self.load_tab_data(model_class, table)

    def load_tab_data(self, model_class, table):
        session = get_session(get_engine())
        try:
            items = session.query(model_class).all()
            table.setRowCount(0)
            for row, item in enumerate(items):
                table.insertRow(row)
                table.setItem(row, 0, QTableWidgetItem(item.name))
        finally:
            session.close()

    def add_entry(self, model_class, table):
        # Use Arabic prompt for adding
        name, ok = QInputDialog.getText(self, "إضافة عنصر", "الاسم:")
        if ok and name:
            session = get_session(get_engine())
            try:
                item = model_class(name=name)
                session.add(item)
                session.commit()
                self.load_tab_data(model_class, table)
                try:
                    state.metadata_changed.emit(model_class.__name__)
                except Exception:
                    pass
            except Exception as e:
                session.rollback()
                QMessageBox.critical(self, "خطأ", str(e))
            finally:
                session.close()

    def delete_entry(self, model_class, table):
        row = table.currentRow()
        if row < 0: return
        name = table.item(row, 0).text()
        
        # Arabic confirmation prompt
        if QMessageBox.question(self, "تأكيد الحذف", f"حذف {name}?", QMessageBox.Yes | QMessageBox.No) == QMessageBox.Yes:
            session = get_session(get_engine())
            try:
                item = session.query(model_class).filter_by(name=name).first()
                if item:
                    session.delete(item)
                    session.commit()
                    self.load_tab_data(model_class, table)
                    try:
                        state.metadata_changed.emit(model_class.__name__)
                    except Exception:
                        pass
            except Exception as e:
                session.rollback()
                QMessageBox.critical(self, "خطأ", str(e))
            finally:
                session.close()
