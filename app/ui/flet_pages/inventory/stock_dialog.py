"""Stock-adjustment modal — records a StockMovement and updates qty."""

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


def show_adjust_stock_dialog(page: ft.Page, repo, item, on_saved=None):
    """Open the stock-adjustment dialog for a product."""

    current_stock = item.get("stock_qty", 0)

    adjustment_field = ft.TextField(
        label=_("Adjustment (+/-)"),
        value="0",
        width=150,
        autofocus=True,
    )
    type_dropdown = ft.Dropdown(
        label=_("Movement Type"),
        value="adjustment",
        options=[
            ft.dropdown.Option("purchase", _("Purchase")),
            ft.dropdown.Option("adjustment", _("Adjustment")),
            ft.dropdown.Option("return", _("Return")),
            ft.dropdown.Option("initial", _("Initial Stock")),
        ],
        width=150,
    )
    ref_field = ft.TextField(label=_("Reference No."), width=150)
    note_field = ft.TextField(label=_("Note"), expand=True)

    dialog = build_dialog(
        f"{_('Adjust Stock')}: {item.get('name')}",
        ft.Container(
            ft.Column([
                ft.Text(f"{_('Current Stock')}: {current_stock}", size=16, weight=ft.FontWeight.BOLD),
                ft.Row([adjustment_field, type_dropdown]),
                ft.Row([ref_field, note_field]),
            ], tight=True, spacing=10),
            width=400,
        ),
        [],
    )

    def adjust_stock(_e):
        try:
            adjustment = int(adjustment_field.value or 0)
            if adjustment == 0:
                close_dialog_safe(page, dialog)
                return

            # Default the movement type by sign if user didn't override.
            default_type = "purchase" if adjustment > 0 else "sale"
            movement_type = type_dropdown.value or default_type

            repo.adjust_stock(
                item["id"],
                adjustment,
                movement_type,
                ref_no=ref_field.value or "",
                note=note_field.value or "",
            )

            publish_ui_event(page, UIEventTopic.INVENTORY)
            close_dialog_safe(page, dialog)
            if on_saved:
                on_saved()
            show_success(page, _("Stock adjusted successfully!"))
        except Exception as ex:
            show_error(page, f"{_('Error')}: {str(ex)}")

    dialog.actions = [
        secondary_button(_("Cancel"), on_click=lambda e: close_dialog_safe(page, dialog)),
        primary_button(_("Adjust"), on_click=adjust_stock),
    ]
    open_dialog(page, dialog)
