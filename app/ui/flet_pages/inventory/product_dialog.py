"""Add / edit product modal."""

import flet as ft

from app.core.i18n import _
from app.ui.components.design_helpers import (
    build_dialog,
    close_dialog as close_dialog_safe,
    open_dialog,
    primary_button,
    secondary_button,
)
from app.ui.components.feedback import show_error, show_success
from app.ui.components.ui_sync import UIEventTopic, publish_ui_event


def show_product_dialog(page: ft.Page, repo, item=None, on_saved=None):
    """Open the product add/edit dialog.

    Args:
        page:     Flet page (used for dialog open/update).
        repo:     POSRepository.
        item:     Existing product dict for edit, or None for new.
        on_saved: Optional callback invoked after a successful save (typically
                  the inventory list reload).
    """

    name_field = ft.TextField(label=_("Name"), value=item.get("name", "") if item else "", expand=True)
    sku_field = ft.TextField(
        label=_("SKU"),
        value=item.get("sku", "") if item else repo.generate_sku("Other"),
        width=150,
    )
    barcode_field = ft.TextField(label=_("Barcode"), value=item.get("barcode", "") if item else "", width=150)

    def update_sku():
        if not item:
            sku_field.value = repo.generate_sku(cat_dropdown.value)
            page.update()

    cat_dropdown = ft.Dropdown(
        label=_("Category"),
        value=item.get("category", "Other") if item else "Other",
        options=[
            ft.dropdown.Option("Frame", _("Frame")),
            ft.dropdown.Option("Sunglasses", _("Sunglasses")),
            ft.dropdown.Option("Accessory", _("Accessory")),
            ft.dropdown.Option("ContactLens", _("Contact Lens")),
            ft.dropdown.Option("Other", _("Other")),
        ],
        width=150,
        on_change=lambda e: update_sku(),
    )

    price_field = ft.TextField(
        label=_("Sale Price"),
        value=str(item.get("sale_price", 0)) if item else "0.00",
        width=120,
    )
    cost_field = ft.TextField(
        label=_("Cost Price"),
        value=str(item.get("cost_price", 0)) if item else "0.00",
        width=120,
    )
    qty_field = ft.TextField(
        label=_("Initial Stock"),
        value="0",
        input_filter=ft.NumbersOnlyInputFilter(),
        width=100,
        visible=not item,  # only relevant for new products
    )

    try:
        frame_types = repo.get_frame_types() or []
    except Exception:
        frame_types = []
    try:
        frame_colors = repo.get_frame_colors() or []
    except Exception:
        frame_colors = []

    frame_type_field = ft.Dropdown(
        label=_("Frame Type"),
        value=item.get("frame_type", "") if item else "",
        options=[ft.dropdown.Option(ft_["name"], ft_["name"]) for ft_ in frame_types],
        width=150,
    )
    frame_color_field = ft.Dropdown(
        label=_("Frame Color"),
        value=item.get("frame_color", "") if item else "",
        options=[ft.dropdown.Option(fc["name"], fc["name"]) for fc in frame_colors],
        width=150,
    )

    dialog = build_dialog(
        _("Edit Product") if item else _("New Product"),
        ft.Container(
            ft.Column([
                ft.Row([name_field]),
                ft.Row([sku_field, barcode_field, cat_dropdown]),
                ft.Row([price_field, cost_field, qty_field]),
                ft.Row([frame_type_field, frame_color_field]),
            ], tight=True, spacing=10),
            width=500,
        ),
        [],
    )

    def save_product(_e):
        try:
            data = {
                "name": name_field.value,
                "sku": sku_field.value,
                "category": cat_dropdown.value,
                "sale_price": float(price_field.value or 0),
                "cost_price": float(cost_field.value or 0),
                "barcode": barcode_field.value,
                "frame_type": frame_type_field.value,
                "frame_color": frame_color_field.value,
            }

            if item:
                repo.update_inventory_item(item["id"], data)
            else:
                data["stock_qty"] = int(qty_field.value or 0)
                repo.add_inventory_item(data)

            publish_ui_event(page, UIEventTopic.INVENTORY)
            close_dialog_safe(page, dialog)
            if on_saved:
                on_saved()
            show_success(page, _("Product saved successfully!"))
        except Exception as ex:
            show_error(page, f"{_('Error')}: {str(ex)}")

    dialog.actions = [
        secondary_button(_("Cancel"), on_click=lambda e: close_dialog_safe(page, dialog)),
        primary_button(_("Save"), on_click=save_product),
    ]

    open_dialog(page, dialog)
