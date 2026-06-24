"""POS feature module.

Package layout:
  - controller.py            - _POSController class + POSView factory
  - keyboard.py              - keyboard-shortcut registry (F2/F4/Ctrl+Enter/Esc)
  - step_category.py         - Step 0 (category grid)
  - step_customer.py         - Step 1 (customer search/select/create)
  - step_examination.py      - Step 2 (order details + exam rows + past Rx drawer)
  - step_additional_items.py - Step 3 (add accessories)
  - step_cart.py             - Step 4 (cart, pricing, totals, payment)
  - receipt.py               - post-checkout receipt-preview dialog (shop/customer/lab)

main.py imports ``POSView`` via ``from app.ui.flet_pages.pos import
POSView``; that path stays stable across this internal split.
"""

from app.ui.flet_pages.pos.controller import POSView  # noqa: F401
