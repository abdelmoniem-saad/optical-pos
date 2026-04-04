import flet as ft

from app.ui.components.design_helpers import (
    build_dialog,
    danger_button,
    icon_action,
    primary_button,
    refresh_action,
    secondary_button,
    standard_appbar,
)
from app.ui.components.ui_tokens import BUTTON_HEIGHT


def _noop(_e=None):
    return None


def test_primary_button_defaults():
    btn = primary_button("Save", on_click=_noop)
    assert isinstance(btn, ft.ElevatedButton)
    assert btn.height == BUTTON_HEIGHT


def test_danger_button_defaults():
    btn = danger_button("Delete", on_click=_noop)
    assert isinstance(btn, ft.ElevatedButton)
    assert btn.height == BUTTON_HEIGHT


def test_secondary_button_type():
    btn = secondary_button("Cancel", on_click=_noop)
    assert isinstance(btn, ft.TextButton)


def test_build_dialog_type():
    dialog = build_dialog("Test", ft.Text("Body"), [])
    assert isinstance(dialog, ft.AlertDialog)


def test_icon_action_type():
    btn = icon_action(ft.icons.REFRESH, on_click=_noop)
    assert isinstance(btn, ft.IconButton)


def test_refresh_action_type():
    btn = refresh_action(on_click=_noop)
    assert isinstance(btn, ft.IconButton)


def test_standard_appbar_type_and_back():
    bar = standard_appbar("Title", on_back=_noop)
    assert isinstance(bar, ft.AppBar)
    assert isinstance(bar.leading, ft.IconButton)


