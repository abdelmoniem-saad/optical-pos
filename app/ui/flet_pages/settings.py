import flet as ft
from app.core.i18n import _

def SettingsView(page: ft.Page, repo):
    
    # --- Shop Settings Tab ---
    def create_shop_settings():
        shop_name = ft.TextField(label=_("Shop Name"), value=repo.get_setting("shop_name", "Lensy Optical"), expand=True)
        shop_address = ft.TextField(label=_("Address"), value=repo.get_setting("store_address", ""), expand=True, multiline=True, min_lines=2)
        shop_phone = ft.TextField(label=_("Phone"), value=repo.get_setting("store_phone", ""), expand=True)
        currency = ft.TextField(label=_("Currency"), value=repo.get_setting("currency", "EGP"), width=100)

        def save_settings(e):
            repo.set_setting("shop_name", shop_name.value)
            repo.set_setting("store_address", shop_address.value)
            repo.set_setting("store_phone", shop_phone.value)
            repo.set_setting("currency", currency.value)
            page.snack_bar = ft.SnackBar(ft.Text(_("Settings saved successfully!")))
            page.snack_bar.open = True
            page.update()

        return ft.Column([
            ft.Text(_("Shop Information"), size=20, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            shop_name,
            shop_address,
            ft.Row([shop_phone, currency]),
            ft.ElevatedButton(_("Save Settings"), icon=ft.Icons.SAVE, on_click=save_settings),
        ], spacing=15, expand=True)

    # --- Backup Tab ---
    def create_backup_tab():
        def export_data(e):
            import json
            data = repo._read_local()
            # In a real app, you'd save to a file
            page.snack_bar = ft.SnackBar(ft.Text(_("Data exported (check console)")))
            page.snack_bar.open = True
            print(json.dumps(data, indent=2, default=str))
            page.update()

        def reset_data(e):
            def confirm_reset(e):
                import os
                from app.config import LOCAL_JSON_DB
                if os.path.exists(LOCAL_JSON_DB):
                    os.remove(LOCAL_JSON_DB)
                repo._ensure_local_db()
                confirm_dialog.open = False
                page.snack_bar = ft.SnackBar(ft.Text(_("Data reset successfully. Please restart the app.")))
                page.snack_bar.open = True
                page.update()

            confirm_dialog = ft.AlertDialog(
                title=ft.Text(_("Confirm Reset")),
                content=ft.Text(_("This will delete ALL data. Are you sure?")),
                actions=[
                    ft.TextButton(_("Cancel"), on_click=lambda e: setattr(confirm_dialog, "open", False) or page.update()),
                    ft.ElevatedButton(_("Reset"), bgcolor=ft.Colors.RED_700, color=ft.Colors.WHITE, on_click=confirm_reset)
                ]
            )
            page.dialog = confirm_dialog
            confirm_dialog.open = True
            page.update()

        return ft.Column([
            ft.Text(_("Backup & Data"), size=20, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            ft.ElevatedButton(_("Export Data (JSON)"), icon=ft.Icons.DOWNLOAD, on_click=export_data),
            ft.Divider(height=30),
            ft.Text(_("Danger Zone"), color=ft.Colors.RED_700, weight=ft.FontWeight.BOLD),
            ft.ElevatedButton(
                _("Reset All Data"),
                icon=ft.Icons.DELETE_FOREVER,
                bgcolor=ft.Colors.RED_700,
                color=ft.Colors.WHITE,
                on_click=reset_data
            ),
        ], spacing=15)

    tabs = ft.Tabs(
        selected_index=0,
        tabs=[
            ft.Tab(text=_("Shop Settings"), icon=ft.Icons.STORE, content=ft.Container(create_shop_settings(), padding=20)),
            ft.Tab(text=_("Backup"), icon=ft.Icons.BACKUP, content=ft.Container(create_backup_tab(), padding=20)),
        ],
        expand=True
    )

    return ft.View(
        "/settings",
        [
            ft.AppBar(
                title=ft.Text(_("Settings")),
                bgcolor=ft.Colors.BLUE_700,
                color=ft.Colors.WHITE,
                leading=ft.IconButton(ft.Icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(content=tabs, expand=True, padding=10)
        ]
    )
