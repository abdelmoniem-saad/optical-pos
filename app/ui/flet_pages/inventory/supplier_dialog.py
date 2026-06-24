"""Supplier add/edit modal.

Note: the underlying repo.add_metadata path currently only stores the
supplier *name*; the phone/email/address fields are accepted in the form
but not yet persisted by the repository. This is preserved from the
pre-decomposition behavior — fixing it is out of scope for the file split.
"""

import flet as ft

from app.core.i18n import _
from app.ui.components.design_helpers import (
    build_dialog,
    close_dialog as close_dialog_safe,
    open_dialog,
    primary_button,
    secondary_button,
)


def show_supplier_dialog(page: ft.Page, repo, supplier=None, on_saved=None):
    """Open the supplier add/edit dialog."""

    name_field = ft.TextField(label=_("Name"), value=supplier.get("name", "") if supplier else "")
    phone_field = ft.TextField(label=_("Phone"), value=supplier.get("phone", "") if supplier else "")
    email_field = ft.TextField(label=_("Email"), value=supplier.get("email", "") if supplier else "")
    address_field = ft.TextField(
        label=_("Address"),
        value=supplier.get("address", "") if supplier else "",
        multiline=True,
    )

    dialog = build_dialog(
        _("Supplier"),
        ft.Column([name_field, phone_field, email_field, address_field], tight=True),
        [],
    )

    def save_supplier(_e):
        if supplier:
            # Update path not yet supported by the repository; preserve existing no-op behavior.
            pass
        else:
            repo.add_metadata("suppliers", name_field.value)
        close_dialog_safe(page, dialog)
        if on_saved:
            on_saved()

    dialog.actions = [
        secondary_button(_("Cancel"), on_click=lambda e: close_dialog_safe(page, dialog)),
        primary_button(_("Save"), on_click=save_supplier),
    ]
    open_dialog(page, dialog)
