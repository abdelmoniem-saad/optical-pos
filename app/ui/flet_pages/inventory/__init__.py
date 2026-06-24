"""Inventory feature module.

Package layout:
  - view.py                - assembles the InventoryView (3 tabs: products,
                             suppliers, optical settings)
  - product_dialog.py      - add/edit product modal
  - stock_dialog.py        - stock-adjustment modal with movement record
  - supplier_dialog.py     - add/edit supplier modal
  - optical_settings_tab.py - lens types / frame types / frame colors panel

main.py imports ``InventoryView`` via ``from app.ui.flet_pages.inventory
import InventoryView``; that path stays stable across this internal split.
"""

from app.ui.flet_pages.inventory.view import InventoryView  # noqa: F401
