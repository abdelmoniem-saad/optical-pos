"""POS keyboard shortcuts.

Registered on the page's ``on_keyboard_event``; falls through to any
previously installed handler when the active route is not /pos.

Bindings:
  - F2          focus the quick-add search input (or paid input as a fallback)
  - F4          focus the paid input (Step 4 only)
  - Ctrl+Enter  finish the order (Step 4 only)
  - Ctrl+Backspace  clear the cart (Step 4 only)
  - Esc         go back one step
"""

import flet as ft

from app.core.i18n import _
from app.ui.components.feedback import show_info


def register_pos_shortcuts(page: ft.Page, controller):
    """Wire the POS shortcuts onto ``page.on_keyboard_event``.

    Preserves any previously installed handler so non-POS routes keep
    behaving as before.
    """
    previous_handler = getattr(page, "on_keyboard_event", None)

    def handle_key(e: ft.KeyboardEvent):
        if page.route != "/pos":
            if callable(previous_handler):
                previous_handler(e)
            return

        key = (e.key or "").upper()
        ctrl = bool(getattr(e, "ctrl", False))

        if key == "F2":
            target = getattr(controller, "add_item_search", None) or getattr(controller, "paid_input", None)
            if target is not None:
                target.focus()
                page.update()
            return

        if key == "F4":
            paid = getattr(controller, "paid_input", None)
            if paid is not None:
                paid.focus()
                page.update()
            return

        if ctrl and key == "ENTER" and controller.current_step == 4:
            controller.finish_order()
            return

        if ctrl and key == "BACKSPACE" and controller.current_step == 4:
            controller.clear_cart()
            show_info(page, _("Cart cleared"))
            return

        if key == "ESCAPE":
            if controller.current_step == 4:
                if controller.selected_category in ["Frame", "ContactLens"]:
                    controller.show_step_2()
                else:
                    controller.show_step_1()
            elif controller.current_step == 3:
                controller.show_step_2()
            elif controller.current_step == 2:
                controller.show_step_1()
            elif controller.current_step == 1:
                controller.show_step_0()

    page.on_keyboard_event = handle_key
