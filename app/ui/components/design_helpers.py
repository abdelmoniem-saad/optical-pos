import flet as ft

from app.ui.components.ui_tokens import BUTTON_HEIGHT, SPACE_MD


def primary_button(label: str, on_click, icon=None, expand: bool = False):
    return ft.ElevatedButton(
        label,
        icon=icon,
        height=BUTTON_HEIGHT,
        on_click=on_click,
        style=ft.ButtonStyle(
            bgcolor=ft.colors.BLUE_700,
            color=ft.colors.WHITE,
            shape=ft.RoundedRectangleBorder(radius=10),
        ),
        expand=expand,
    )


def danger_button(label: str, on_click, icon=None, expand: bool = False):
    return ft.ElevatedButton(
        label,
        icon=icon,
        height=BUTTON_HEIGHT,
        on_click=on_click,
        style=ft.ButtonStyle(
            bgcolor=ft.colors.RED_700,
            color=ft.colors.WHITE,
            shape=ft.RoundedRectangleBorder(radius=10),
        ),
        expand=expand,
    )


def secondary_button(label: str, on_click=None, icon=None):
    return ft.TextButton(label, icon=icon, on_click=on_click)


def icon_action(icon, on_click=None, tooltip: str = None, icon_color=None):
    return ft.IconButton(
        icon=icon,
        on_click=on_click,
        tooltip=tooltip,
        icon_color=icon_color,
    )


def refresh_action(on_click=None, tooltip: str = "Refresh", icon_color=None):
    return icon_action(
        icon=ft.icons.REFRESH,
        on_click=on_click,
        tooltip=tooltip,
        icon_color=icon_color,
    )


def standard_appbar(title: str, on_back=None, actions=None):
    return ft.AppBar(
        title=ft.Text(title),
        bgcolor=ft.colors.BLUE_700,
        color=ft.colors.WHITE,
        leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=on_back) if on_back else None,
        actions=actions or [],
    )


def build_dialog(title: str, content, actions):
    return ft.AlertDialog(
        title=ft.Text(title),
        content=content,
        actions=actions,
        actions_padding=ft.padding.symmetric(horizontal=SPACE_MD, vertical=SPACE_MD),
    )


def close_dialog(page: ft.Page, dialog: ft.AlertDialog = None):
    try:
        if hasattr(page, "pop_dialog"):
            page.pop_dialog()
            return
        if hasattr(page, "close") and dialog is not None:
            page.close(dialog)
            return
        if dialog is not None:
            dialog.open = False
        page.update()
    except Exception as ex:
        print(f"[UI][DIALOG] close failed: {ex}", flush=True)


def open_dialog(page: ft.Page, dialog: ft.AlertDialog):
    try:
        if hasattr(page, "show_dialog"):
            page.show_dialog(dialog)
            return
        if hasattr(page, "open"):
            page.open(dialog)
            return

        # Legacy fallback (older Flet versions)
        page.dialog = dialog
        dialog.open = True
        page.update()
    except Exception as ex:
        print(f"[UI][DIALOG] open failed: {ex}", flush=True)
        raise
