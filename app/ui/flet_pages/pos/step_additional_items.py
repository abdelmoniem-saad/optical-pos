"""Step 3 — add accessories or other products to the order (optional)."""

import flet as ft

from app.core.i18n import _
from app.ui.components.feedback import show_success
from app.ui.components.ui_tokens import (
    BORDER,
    ON_PRIMARY,
    SUCCESS,
    SURFACE,
    TEXT_MUTED,
    WARNING,
)


def build_additional_items_step(controller):
    """Render Step 3 (additional items search + add-to-cart list)."""
    controller.current_step = 3
    page = controller._page

    category_options = [
        ft.dropdown.Option("All", _("All Categories")),
        ft.dropdown.Option("Frame", _("Frames")),
        ft.dropdown.Option("Sunglasses", _("Sunglasses")),
        ft.dropdown.Option("Accessory", _("Accessories")),
        ft.dropdown.Option("Other", _("Others")),
    ]

    controller.add_item_category = ft.Dropdown(
        label=_("Category"),
        options=category_options,
        value="All",
        width=200,
        on_change=lambda _e: load_additional_products(controller),
    )

    controller.add_item_search = ft.TextField(
        label=_("Search products..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_change=lambda _e: load_additional_products(controller),
    )

    controller.additional_products_list = ft.ListView(expand=True, spacing=5)

    nav_buttons = ft.Container(
        content=ft.Row([
            ft.ElevatedButton(
                _("← Back to Examination"),
                icon=ft.icons.ARROW_BACK,
                on_click=lambda _: controller.show_step_2(),
            ),
            ft.ElevatedButton(
                _("Continue to Payment →"),
                icon=ft.icons.PAYMENT,
                bgcolor=SUCCESS,
                color=ON_PRIMARY,
                on_click=lambda _: controller.save_exams_and_proceed(),
            ),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        bgcolor=SURFACE,
        padding=15,
        border_radius=10,
    )

    controller.content_area.content = ft.Column([
        ft.Text(_("Step 3: Add More Items"), size=24, weight=ft.FontWeight.BOLD),
        ft.Text(_("Add accessories or other products to this order"), color=TEXT_MUTED),
        ft.Divider(height=10),
        ft.Row([controller.add_item_category, controller.add_item_search]),
        ft.Text(_("Available Products:"), size=14, weight=ft.FontWeight.BOLD),
        ft.Container(
            content=controller.additional_products_list,
            height=350,
            border=ft.border.all(1, BORDER),
            border_radius=8,
            padding=5,
        ),
        ft.Divider(height=10),
        nav_buttons,
    ], spacing=10, expand=True)

    load_additional_products(controller)
    page.update()


def load_additional_products(controller):
    """Refresh the additional-products list from the repo with current filters."""
    page = controller._page
    controller.additional_products_list.controls.clear()

    category = controller.add_item_category.value if controller.add_item_category.value != "All" else None
    search_term = controller.add_item_search.value or None

    products = controller.repo.get_inventory(category=category, search_term=search_term)

    for p in products:
        stock = p.get("stock_qty", 0)
        controller.additional_products_list.controls.append(
            ft.ListTile(
                leading=ft.Icon(ft.icons.INVENTORY_2),
                title=ft.Text(f"{p.get('name', 'Unknown')} ({p.get('sku', '')})"),
                subtitle=ft.Text(f"{_('Price')}: {p.get('sale_price', 0):.2f} | {_('Stock')}: {stock}"),
                trailing=ft.IconButton(
                    ft.icons.ADD_SHOPPING_CART,
                    tooltip=_("Add to Cart"),
                    on_click=lambda e, prod=p: add_product_to_cart_from_list(controller, prod),
                ),
            )
        )
    page.update()


def add_product_to_cart_from_list(controller, product):
    """Add a product to the cart (or increment qty)."""
    page = controller._page
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

    show_success(page, f"✓ {product.get('name')} {_('added to cart')}")
