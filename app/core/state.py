# app/core/state.py
from PySide6.QtCore import QObject, Signal

class AppState(QObject):
    # Product signals
    product_added = Signal(int)     # product_id
    product_updated = Signal(int)   # product_id
    product_deleted = Signal(int)   # product_id

    # Sale signals
    sale_added = Signal(int)        # sale_id
    sale_updated = Signal(int)      # sale_id

    # Customer signals
    customer_added = Signal(int)    # customer_id
    customer_updated = Signal(int)  # customer_id
    customer_deleted = Signal(int)  # customer_id

    # Prescription signals
    prescription_added = Signal(int)    # prescription_id
    prescription_updated = Signal(int)  # prescription_id

    # Optical metadata signals (lens types, frame types, colors, contact lens types)
    metadata_changed = Signal(str)  # table or model name, e.g. 'LensType', 'FrameType', 'ContactLensType'

    # General refresh signal - triggers all data reloads
    refresh_all = Signal()

# Singleton instance
state = AppState()

