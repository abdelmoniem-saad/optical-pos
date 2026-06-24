"""POS controller — owns order state and dispatches to per-step view modules.

State lives on the controller instance (cart_items, totals, selected_*,
examinations, etc.). The per-step modules in this package take the
controller as an argument and mutate / read its attributes; they also
attach UI control references back to the controller (e.g. ``cart_table``,
``paid_input``) so that cross-step features like the keyboard shortcut
registry can find them.
"""

import datetime

import flet as ft

from app.core.i18n import _
from app.ui.components.design_helpers import standard_appbar
from app.ui.components.feedback import show_error
from app.ui.components.ui_sync import UIEventTopic, publish_ui_event

from app.ui.flet_pages.pos.keyboard import register_pos_shortcuts
from app.ui.flet_pages.pos.receipt import show_receipt_preview
from app.ui.flet_pages.pos.step_additional_items import build_additional_items_step
from app.ui.flet_pages.pos.step_cart import (
    build_cart_step,
    update_cart_display,
    update_totals_display,
)
from app.ui.flet_pages.pos.step_category import build_category_step
from app.ui.flet_pages.pos.step_customer import build_customer_step
from app.ui.flet_pages.pos.step_examination import (
    build_examination_step,
    save_exams_and_proceed,
)


def POSView(page: ft.Page, repo):
    """Public factory — main.py imports this."""
    pos = _POSController(page, repo)
    return pos.view


class _POSController:
    """
    Point of Sale (POS) System for Optical Shop.

    Flow:
      Step 0  Category selection (Glasses / Sunglasses / Contact Lenses / Accessories / Others)
      Step 1  Customer selection (search & select existing or create new)
      Step 2  Order & examination (Glasses / Contact Lenses; supports multiple exams)
      Step 3  Additional items (optional accessories / other products)
      Step 4  Cart summary + payment + checkout
      Receipt: shop / customer / lab copies after a successful save
    """

    def __init__(self, page: ft.Page, repo):
        self._page = page
        self.repo = repo

        # ---- order state ----
        self.current_step = 0
        self.selected_category = None
        self.selected_customer = None
        self.cart_items = []
        self.examinations = []
        self.examination_data = {}  # legacy field; preserved for compatibility
        self.totals = {
            "gross_total": 0.0,
            "discount": 0.0,
            "net_amount": 0.0,
            "amount_paid": 0.0,
            "balance": 0.0,
        }
        self.invoice_no = None
        self.order_date = datetime.date.today()
        self.delivery_date = datetime.date.today() + datetime.timedelta(days=3)
        self.doctor_name = ""

        # ---- view scaffolding ----
        self.app_bar = standard_appbar(_("Sales POS"), on_back=lambda _: self._page.go("/"))
        self.content_area = ft.Container(expand=True, padding=24)
        self.view = ft.View(
            route="/pos",
            padding=0,
            spacing=0,
            controls=[self.app_bar, self.content_area],
        )

        register_pos_shortcuts(self._page, self)
        self.show_step_0()

    # ---- step navigation ----

    def show_step_0(self):
        build_category_step(self)

    def start_with_category(self, category):
        self.selected_category = category
        self.show_step_1()

    def show_step_1(self):
        build_customer_step(self)

    def go_to_next_step(self, customer):
        """Called by the customer step after Walk-in / Continue."""
        self.selected_customer = customer
        self.invoice_no = self.repo.get_next_invoice_no()
        if self.selected_category in ["Frame", "ContactLens"]:
            self.show_step_2()
        else:
            self.show_step_4()

    def show_step_2(self):
        build_examination_step(self)

    def save_exams_and_proceed(self):
        """Called by Step 2's "Next: Payment" button (and by Step 3's continue)."""
        save_exams_and_proceed(self)

    def show_step_3(self):
        build_additional_items_step(self)

    def show_step_4(self):
        build_cart_step(self)

    # ---- cart operations ----

    def clear_cart(self):
        self.cart_items.clear()
        if hasattr(self, "cart_table"):
            update_cart_display(self)
        if hasattr(self, "totals_display"):
            update_totals_display(self)
        self._page.update()

    # ---- checkout ----

    def finish_order(self):
        """Validate stock, persist the sale, publish events, show the receipt dialog."""
        if not self.cart_items and not self.examinations:
            show_error(self._page, _("Cart is empty and no examinations. Cannot checkout."))
            return

        try:
            insufficient_items = []
            for item in self.cart_items:
                current_stock = self.repo.get_product_stock(item["product_id"])
                if current_stock < item["qty"]:
                    insufficient_items.append(
                        f"{item['name']} (need {item['qty']}, have {current_stock})"
                    )
            if insufficient_items:
                msg = _("Insufficient stock for") + ":\n" + "\n".join(insufficient_items)
                show_error(self._page, msg, duration=5000)
                return

            user = self._page.data.get("user") if hasattr(self._page, "data") and self._page.data else None
            user_id = user.get("id") if user else None

            sale_data = {
                "invoice_no": self.invoice_no,
                "customer_id": self.selected_customer.get("id") if self.selected_customer else None,
                "total_amount": self.totals["gross_total"],
                "discount": self.totals["discount"],
                "net_amount": self.totals["net_amount"],
                "amount_paid": self.totals["amount_paid"],
                "payment_method": "Cash",
                "user_id": user_id,
                "doctor_name": self.doctor_name,
                "lab_status": "Not Started" if self.examinations else None,
                "order_date": datetime.datetime.utcnow().isoformat(),
                "delivery_date": self.delivery_date.isoformat() if hasattr(self, "delivery_date") else None,
            }

            self.repo.add_sale(
                sale_data,
                self.cart_items,
                exam_data=None,
                examinations=self.examinations if self.examinations else None,
            )

            publish_ui_event(self._page, UIEventTopic.SALES)
            publish_ui_event(self._page, UIEventTopic.INVENTORY)
            if self.examinations:
                publish_ui_event(self._page, UIEventTopic.LAB)
            if self.selected_customer:
                publish_ui_event(self._page, UIEventTopic.CUSTOMERS)

            show_receipt_preview(self, sale_data)

        except Exception as ex:
            show_error(self._page, f"{_('Error saving order')}: {str(ex)}")

    def reset_pos(self):
        """Wipe the controller's order state and return to Step 0."""
        self.current_step = 0
        self.selected_category = None
        self.selected_customer = None
        self.cart_items.clear()
        self.examinations.clear()
        self.examination_data.clear()
        self.totals = {
            "gross_total": 0.0,
            "discount": 0.0,
            "net_amount": 0.0,
            "amount_paid": 0.0,
            "balance": 0.0,
        }
        self.invoice_no = None
        self.doctor_name = ""
        self.order_date = datetime.date.today()
        self.delivery_date = datetime.date.today() + datetime.timedelta(days=3)
        self.show_step_0()
