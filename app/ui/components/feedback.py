import flet as ft


def _show(page: ft.Page, message: str, bgcolor=None, duration: int = 2500):
    bar = ft.SnackBar(ft.Text(message), bgcolor=bgcolor, duration=duration)
    try:
        if hasattr(page, "show_dialog"):
            page.show_dialog(bar)
            return
        if hasattr(page, "open"):
            page.open(bar)
            return

        # Legacy fallback
        page.snack_bar = bar
        page.snack_bar.open = True
        page.update()
    except Exception as ex:
        print(f"[UI][SNACKBAR] show failed: {ex}", flush=True)


def show_success(page: ft.Page, message: str, duration: int = 2500):
    _show(page, message, bgcolor=ft.colors.GREEN_700, duration=duration)


def show_error(page: ft.Page, message: str, duration: int = 3500):
    _show(page, message, bgcolor=ft.colors.RED_700, duration=duration)


def show_info(page: ft.Page, message: str, duration: int = 2200):
    _show(page, message, bgcolor=ft.colors.BLUE_700, duration=duration)
