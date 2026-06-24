"""Step 4 — cart, pricing, and payment summary."""

import flet as ft

from app.core.i18n import _
from app.ui.components.feedback import show_error
from app.ui.components.ui_tokens import (
    BORDER,
    BRAND_PRIMARY,
    DANGER,
    ON_PRIMARY,
    SUCCESS,
    TEXT_FAINT,
)


def build_cart_step(controller):
    """Render Step 4 (cart + payment)."""
    controller.current_step = 4
    page = controller._page

    customer_name = (
        controller.selected_customer.get("name", _("Walk-in"))
        if controller.selected_customer
        else _("Walk-in")
    )

    product_search = ft.TextField(
        label=_("Quick add by SKU or name..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_submit=lambda e: add_product_to_cart(controller, e.control.value),
    )

    controller.cart_table = ft.DataTable(
        columns=[
            ft.DataColumn(ft.Text(_("Product"))),
            ft.DataColumn(ft.Text(_("Qty")), numeric=True),
            ft.DataColumn(ft.Text(_("Price")), numeric=True),
            ft.DataColumn(ft.Text(_("Total")), numeric=True),
            ft.DataColumn(ft.Text("")),
        ],
        rows=[],
    )

    controller.use_custom_price = ft.Checkbox(
        label=_("Use Custom Price"),
        value=False,
        on_change=lambda e: on_custom_price_toggle(controller, e),
    )

    initial_gross = sum(item["total_price"] for item in controller.cart_items)

    controller.custom_price_input = ft.TextField(
        label=_("Custom Gross Total"),
        value=str(initial_gross),
        width=150,
        disabled=True,
        on_change=lambda _e: on_totals_change(controller),
    )

    controller.discount_input = ft.TextField(
        label=_("Discount"),
        value=str(controller.totals["discount"]),
        width=150,
        on_change=lambda _e: on_totals_change(controller),
    )

    controller.paid_input = ft.TextField(
        label=_("Amount Paid"),
        value=str(controller.totals["amount_paid"]),
        width=150,
        on_change=lambda _e: on_totals_change(controller),
    )

    controller.totals_display = ft.Column([], horizontal_alignment=ft.CrossAxisAlignment.END)

    update_cart_display(controller)
    update_totals_display(controller)

    controller.content_area.content = ft.Column([
        ft.Row([ft.Text(f"{_('Step 4: Cart & Payment')} - {customer_name}", size=28, weight=ft.FontWeight.BOLD)]),
        ft.Text(f"{_('Invoice')}: {controller.invoice_no}", size=14, color=BRAND_PRIMARY, weight=ft.FontWeight.BOLD),
        ft.Divider(),
        ft.Row([
            product_search,
            ft.IconButton(ft.icons.ADD, on_click=lambda e: add_product_to_cart(controller, product_search.value), tooltip=_("Add")),
            ft.ElevatedButton(_("Add More Items"), icon=ft.icons.SHOPPING_CART, on_click=lambda _: controller.show_step_3()),
        ]),
        ft.Text(_("Shopping Cart:"), size=16, weight=ft.FontWeight.BOLD),
        ft.Container(content=controller.cart_table, border=ft.border.all(1, BORDER), border_radius=5),
        ft.Divider(),
        ft.ResponsiveRow([
            ft.Container(
                ft.Column([
                    ft.Text(_("Pricing"), size=16, weight=ft.FontWeight.BOLD),
                    ft.Row([controller.use_custom_price, controller.custom_price_input]),
                    ft.Text(_("Use custom price for special deals or negotiations"), size=11, color=TEXT_FAINT, italic=True),
                    ft.Divider(height=10),
                    controller.discount_input,
                    controller.paid_input,
                ]),
                col=6,
            ),
            ft.Container(controller.totals_display, col=6),
        ]),
        ft.Divider(),
        ft.Row([
            ft.ElevatedButton(
                _("← Back"),
                icon=ft.icons.ARROW_BACK,
                on_click=lambda _: (
                    controller.show_step_2()
                    if controller.selected_category in ["Frame", "ContactLens"]
                    else controller.show_step_1()
                ),
            ),
            ft.ElevatedButton(_("Clear Cart"), icon=ft.icons.DELETE_SWEEP, on_click=lambda _: controller.clear_cart()),
            ft.ElevatedButton(
                _("Finish Checkout →"),
                icon=ft.icons.CHECK_CIRCLE,
                bgcolor=SUCCESS,
                color=ON_PRIMARY,
                on_click=lambda _: controller.finish_order(),
            ),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
    ], scroll=ft.ScrollMode.AUTO, spacing=10)
    page.update()


def add_product_to_cart(controller, search_term):
    """Add a product to the cart by SKU/name (Quick add field)."""
    page = controller._page
    if not search_term:
        return

    product = controller.repo.find_product_by_name_or_sku(search_term)
    if not product:
        show_error(page, f"{_('Product not found')}: {search_term}")
        return

    existing = next((item for item in controller.cart_items if item["product_id"] == product["id"]), None)
    if existing:
        existing["qty"] += 1
        existing["total_price"] = existing["qty"] * existing["unit_price"]
    else:
        controller.cart_items.append({
            "product_id": product["id"],
            "name": product.get("name", ""),
            "qty": 1,
            "unit_price": float(product.get("sale_price", 0)),
            "total_price": float(product.get("sale_price", 0)),
        })

    update_cart_display(controller)
    update_totals_display(controller)
    page.update()


def update_cart_display(controller):
    """Re-render the cart-table rows from controller.cart_items."""
    controller.cart_table.rows.clear()

    def make_remove_callback(itm):
        def remove_item(_e):
            controller.cart_items.remove(itm)
            update_cart_display(controller)
            update_totals_display(controller)
            controller._page.update()
        return remove_item

    def make_qty_change_callback(itm):
        def change_qty(_e, delta):
            itm["qty"] = max(1, itm["qty"] + delta)
            itm["total_price"] = itm["qty"] * itm["unit_price"]
            update_cart_display(controller)
            update_totals_display(controller)
            controller._page.update()
        return change_qty

    for item in controller.cart_items:
        qty_control = ft.Row([
            ft.IconButton(ft.icons.REMOVE, on_click=lambda e, i=item: make_qty_change_callback(i)(e, -1)),
            ft.Text(str(item["qty"]), weight=ft.FontWeight.BOLD),
            ft.IconButton(ft.icons.ADD, on_click=lambda e, i=item: make_qty_change_callback(i)(e, 1)),
        ], tight=True)

        controller.cart_table.rows.append(
            ft.DataRow(cells=[
                ft.DataCell(ft.Text(item["name"])),
                ft.DataCell(qty_control),
                ft.DataCell(ft.Text(f"{item['unit_price']:.2f}")),
                ft.DataCell(ft.Text(f"{item['total_price']:.2f}")),
                ft.DataCell(ft.IconButton(ft.icons.DELETE, icon_color=DANGER, on_click=make_remove_callback(item))),
            ])
        )


def on_custom_price_toggle(controller, e):
    """Enable/disable the custom-price input and recompute totals."""
    page = controller._page
    controller.custom_price_input.disabled = not e.control.value
    if e.control.value:
        gross = sum(item["total_price"] for item in controller.cart_items)
        controller.custom_price_input.value = str(gross)
    update_totals_display(controller)
    page.update()


def on_totals_change(controller):
    """Re-parse discount/amount-paid inputs and refresh totals."""
    try:
        controller.totals["discount"] = max(0.0, float(controller.discount_input.value or 0))
        controller.totals["amount_paid"] = max(0.0, float(controller.paid_input.value or 0))
    except ValueError:
        pass
    update_totals_display(controller)


def update_totals_display(controller):
    """Recompute gross/net/balance and rebuild the totals column."""
    page = controller._page

    if hasattr(controller, "use_custom_price") and controller.use_custom_price.value:
        try:
            gross = max(0.0, float(controller.custom_price_input.value or 0))
        except ValueError:
            gross = sum(item["total_price"] for item in controller.cart_items)
    else:
        gross = sum(item["total_price"] for item in controller.cart_items)
        if hasattr(controller, "custom_price_input"):
            controller.custom_price_input.value = str(gross)

    controller.totals["gross_total"] = gross
    controller.totals["discount"] = min(controller.totals["discount"], gross)
    controller.totals["net_amount"] = max(0.0, gross - controller.totals["discount"])
    controller.totals["amount_paid"] = min(controller.totals["amount_paid"], controller.totals["net_amount"])
    controller.totals["balance"] = controller.totals["net_amount"] - controller.totals["amount_paid"]

    if hasattr(controller, "discount_input"):
        controller.discount_input.value = f"{controller.totals['discount']:.2f}"
    if hasattr(controller, "paid_input"):
        controller.paid_input.value = f"{controller.totals['amount_paid']:.2f}"
    if hasattr(controller, "custom_price_input"):
        controller.custom_price_input.value = f"{controller.totals['gross_total']:.2f}"

    controller.totals_display.controls.clear()

    items_total = sum(item["total_price"] for item in controller.cart_items)
    if hasattr(controller, "use_custom_price") and controller.use_custom_price.value and items_total != gross:
        controller.totals_display.controls.append(
            ft.Row([
                ft.Text(_("Items Total"), color=TEXT_FAINT),
                ft.Text(
                    f"{items_total:.2f}",
                    color=TEXT_FAINT,
                    style=ft.TextStyle(decoration=ft.TextDecoration.LINE_THROUGH),
                ),
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN)
        )

    controller.totals_display.controls.extend([
        ft.Row([ft.Text(_("Gross Total"), weight=ft.FontWeight.BOLD), ft.Text(f"{controller.totals['gross_total']:.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ft.Row([ft.Text(_("Discount"), weight=ft.FontWeight.BOLD), ft.Text(f"- {controller.totals['discount']:.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ft.Divider(height=10),
        ft.Row([
            ft.Text(_("Net Amount"), size=18, weight=ft.FontWeight.BOLD),
            ft.Text(f"{controller.totals['net_amount']:.2f}", size=18, weight=ft.FontWeight.BOLD, color=SUCCESS),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ft.Row([ft.Text(_("Amount Paid"), weight=ft.FontWeight.BOLD), ft.Text(f"{controller.totals['amount_paid']:.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ft.Divider(height=10),
        ft.Row([
            ft.Text(_("Remaining Balance"), size=18, weight=ft.FontWeight.BOLD),
            ft.Text(
                f"{controller.totals['balance']:.2f}",
                size=18,
                weight=ft.FontWeight.BOLD,
                color=DANGER if controller.totals['balance'] > 0 else SUCCESS,
            ),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
    ])
    page.update()
