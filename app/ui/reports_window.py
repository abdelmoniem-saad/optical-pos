# app/ui/reports_window.py
import datetime
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, QFrame, QGridLayout, QComboBox
)
from PySide6.QtCore import Qt, Signal
from app.database.db_manager import get_engine, get_session
from app.database.models import Sale, SaleItem, Product, User
from app.core.i18n import _

class ClickableStatCard(QFrame):
    clicked = Signal()
    def __init__(self, title, value, color, parent=None):
        super().__init__(parent)
        self.setStyleSheet(f"background-color: white; border-radius: 15px; border: 2px solid #ddd;")
        self.setMinimumHeight(200)
        self.setCursor(Qt.PointingHandCursor)
        
        vbox = QVBoxLayout(self)
        vbox.setContentsMargins(30, 30, 30, 30)
        
        t_label = QLabel(title)
        t_label.setStyleSheet("font-size: 28px; color: gray; border: none; font-weight: bold;")
        vbox.addWidget(t_label)
        
        self.value_label = QLabel(value)
        self.value_label.setStyleSheet(f"font-size: 64px; font-weight: bold; color: {color}; border: none;")
        vbox.addWidget(self.value_label)

    def mousePressEvent(self, event):
        self.clicked.emit()
        super().mousePressEvent(event)

class ReportsWindow(QWidget):
    nav_to_history_filtered = Signal(dict)
    
    def __init__(self, user, back_callback):
        super().__init__()
        self.user = user
        self.back_callback = back_callback
        self.init_ui()
        self.load_report()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(40, 40, 40, 40)
        layout.setSpacing(20)

        # Header
        header = QGridLayout()
        
        back_btn = QPushButton(_("← Back to Dashboard"))
        back_btn.setMinimumHeight(45)
        back_btn.setStyleSheet("font-size: 16px;")
        back_btn.clicked.connect(self.back_callback)
        header.addWidget(back_btn, 0, 0, Qt.AlignLeft)
        
        title = QLabel(_("Business Reports"))
        title.setStyleSheet("font-size: 42px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        header.addWidget(title, 0, 0, 1, 3, Qt.AlignCenter)
        
        layout.addLayout(header)

        # Filters
        filter_hb = QHBoxLayout()
        lbl_filter = QLabel(_("Filter:"))
        lbl_filter.setStyleSheet("font-size: 24px; font-weight: bold;")
        filter_hb.addWidget(lbl_filter)
        self.filter_cb = QComboBox()
        self.filter_cb.setMinimumHeight(60)
        self.filter_cb.setStyleSheet("font-size: 24px;")
        self.filter_cb.addItems([_("Today"), _("This Week"), _("This Month"), _("Per Worker")])
        self.filter_cb.currentIndexChanged.connect(self.load_report)
        filter_hb.addWidget(self.filter_cb)
        
        self.worker_cb = QComboBox()
        self.worker_cb.setMinimumHeight(60)
        self.worker_cb.setStyleSheet("font-size: 24px;")
        self.worker_cb.setVisible(False)
        self.worker_cb.currentIndexChanged.connect(self.load_report)
        filter_hb.addWidget(self.worker_cb)
        
        layout.addLayout(filter_hb)

        # Stats Grid
        grid = QGridLayout()
        grid.setSpacing(40)

        self.revenue_card = ClickableStatCard(_("Total Revenue"), "0.00", "#1976d2")
        grid.addWidget(self.revenue_card, 0, 0)

        self.sales_count_card = ClickableStatCard(_("Order Count"), "0", "#2e7d32")
        self.sales_count_card.clicked.connect(self.handle_order_count_click)
        grid.addWidget(self.sales_count_card, 0, 1)

        self.paid_card = ClickableStatCard(_("Total Paid"), "0.00", "#f57c00")
        grid.addWidget(self.paid_card, 1, 0)

        self.unpaid_card = ClickableStatCard(_("Remaining Balance"), "0.00", "#7b1fa2")
        grid.addWidget(self.unpaid_card, 1, 1)

        layout.addLayout(grid)
        layout.addStretch()

        self.setLayout(layout)
        self.load_workers()

    def refresh_data(self):
        """Refresh all reports data - called automatically when sales change"""
        self.load_report()

    def load_workers(self):
        session = get_session(get_engine())
        try:
            users = session.query(User).filter_by(is_active=True).all()
            self.worker_cb.clear()
            for u in users:
                self.worker_cb.addItem(u.full_name or u.username, u.id)
        finally:
            session.close()

    def load_report(self):
        filter_type = self.filter_cb.currentIndex()
        self.worker_cb.setVisible(filter_type == 3) # Worker is index 3 now
        
        session = get_session(get_engine())
        try:
            query = session.query(Sale)
            
            now = datetime.datetime.utcnow()
            if filter_type == 0: # Today
                start_date = datetime.datetime.combine(now.date(), datetime.time.min)
                query = query.filter(Sale.order_date >= start_date)
            elif filter_type == 1: # This Week
                start_date = datetime.datetime.combine(now.date() - datetime.timedelta(days=now.weekday()), datetime.time.min)
                query = query.filter(Sale.order_date >= start_date)
            elif filter_type == 2: # This Month
                start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                query = query.filter(Sale.order_date >= start_date)
            elif filter_type == 3: # Per Worker
                uid = self.worker_cb.currentData()
                if uid:
                    query = query.filter(Sale.user_id == uid)
            
            sales = query.all()
            
            total_rev = sum(s.net_amount for s in sales)
            total_paid = sum(s.amount_paid for s in sales)
            sales_count = len(sales)
            remaining = total_rev - total_paid

            self.revenue_card.value_label.setText(f"{total_rev:.2f}")
            self.sales_count_card.value_label.setText(str(sales_count))
            self.paid_card.value_label.setText(f"{total_paid:.2f}")
            self.unpaid_card.value_label.setText(f"{remaining:.2f}")

        finally:
            session.close()

    def handle_order_count_click(self):
        filter_type = self.filter_cb.currentIndex()
        now = datetime.datetime.utcnow()
        start_date = None
        user_id = None
        
        if filter_type == 0: # Today
            start_date = datetime.datetime.combine(now.date(), datetime.time.min)
        elif filter_type == 1: # Week
            start_date = datetime.datetime.combine(now.date() - datetime.timedelta(days=now.weekday()), datetime.time.min)
        elif filter_type == 2: # Month
            start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        elif filter_type == 3: # Worker
            user_id = self.worker_cb.currentData()

        filters = {
            'start_date': start_date,
            'user_id': user_id
        }
        self.nav_to_history_filtered.emit(filters)

