import flet as ft
from app.core.i18n import _
from app.ui.components.design_helpers import (
    build_dialog,
    danger_button,
    open_dialog,
    primary_button,
    secondary_button,
    standard_appbar,
)
from app.ui.components.feedback import show_error, show_success
from app.ui.components.ui_tokens import BUTTON_HEIGHT, INPUT_HEIGHT, SPACE_LG, SPACE_MD, TITLE_SIZE

def SettingsView(page: ft.Page, repo):
    
    # Check if licensing is enabled
    license_manager = page.data.get("license_manager") if hasattr(page, 'data') and page.data else None

    # --- Shop Settings Tab ---
    def create_shop_settings():
        shop_name = ft.TextField(label=_("Shop Name"), value=repo.get_setting("shop_name", "Lensy Optical"), expand=True, height=INPUT_HEIGHT)
        shop_address = ft.TextField(label=_("Address"), value=repo.get_setting("store_address", ""), expand=True, multiline=True, min_lines=2)
        shop_phone = ft.TextField(label=_("Phone"), value=repo.get_setting("store_phone", ""), expand=True, height=INPUT_HEIGHT)
        currency = ft.TextField(label=_("Currency"), value=repo.get_setting("currency", "EGP"), width=120, height=INPUT_HEIGHT)

        def save_settings(e):
            repo.set_setting("shop_name", shop_name.value)
            repo.set_setting("store_address", shop_address.value)
            repo.set_setting("store_phone", shop_phone.value)
            repo.set_setting("currency", currency.value)
            show_success(page, _("Settings saved successfully!"))

        return ft.Column([
            ft.Text(_("Shop Information"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            shop_name,
            shop_address,
            ft.Row([shop_phone, currency]),
            primary_button(_("Save Settings"), on_click=save_settings, icon=ft.icons.SAVE),
        ], spacing=SPACE_MD, expand=True)

    # --- License & Updates Tab ---
    def create_license_tab():
        from app.core.licensing import APP_VERSION

        # Version info
        version_text = ft.Text(f"Version: {APP_VERSION}", size=16)

        # License info section
        license_status_icon = ft.Icon(ft.icons.CHECK_CIRCLE, color=ft.colors.GREEN_700, size=24)
        license_status_text = ft.Text("Checking license...", size=14)
        license_details = ft.Column([], spacing=5)

        # Update info section
        update_status_text = ft.Text("", size=14)
        update_button = ft.ElevatedButton(
            _("Check for Updates"),
            icon=ft.icons.SYSTEM_UPDATE,
            height=BUTTON_HEIGHT,
            disabled=False,
        )
        download_button = ft.ElevatedButton(
            _("Download Update"),
            icon=ft.icons.DOWNLOAD,
            height=BUTTON_HEIGHT,
            visible=False,
            bgcolor=ft.colors.GREEN_700,
            color=ft.colors.WHITE,
        )
        release_notes_text = ft.Text("", size=12, color=ft.colors.GREY_600)

        def refresh_license_info():
            if license_manager:
                is_licensed, license_msg = license_manager.is_licensed()
                license_info = license_manager.get_license_info()

                if is_licensed:
                    license_status_icon.name = ft.icons.CHECK_CIRCLE
                    license_status_icon.color = ft.colors.GREEN_700
                    license_status_text.value = license_msg
                    license_status_text.color = ft.colors.GREEN_700
                else:
                    license_status_icon.name = ft.icons.ERROR
                    license_status_icon.color = ft.colors.RED_700
                    license_status_text.value = license_msg
                    license_status_text.color = ft.colors.RED_700

                license_details.controls.clear()
                if license_info:
                    license_details.controls.extend([
                        ft.Text(f"License Key: {license_info.get('license_key', 'N/A')[:20]}...", size=12, selectable=True),
                        ft.Text(f"Type: {license_info.get('license_type', 'standard').title()}", size=12),
                        ft.Text(f"Expires: {license_info.get('expires_at', 'Never')[:10] if license_info.get('expires_at') else 'Never'}", size=12),
                    ])
                license_details.controls.append(
                    ft.Text(f"Machine ID: {license_manager.machine_id}", size=10, color=ft.colors.GREY_500, selectable=True)
                )
            else:
                license_status_icon.name = ft.icons.INFO
                license_status_icon.color = ft.colors.GREY_500
                license_status_text.value = "Licensing not enabled"
                license_status_text.color = ft.colors.GREY_500

            page.update()

        def check_for_updates(e):
            update_button.disabled = True
            update_status_text.value = "Checking for updates..."
            update_status_text.color = ft.colors.BLUE_700
            page.update()

            if license_manager:
                update_info = license_manager.check_for_updates()

                if update_info.get("update_available"):
                    update_status_text.value = f"New version available: {update_info['latest_version']}"
                    update_status_text.color = ft.colors.GREEN_700
                    download_button.visible = True
                    download_button.data = update_info.get("download_url")

                    if update_info.get("release_notes"):
                        release_notes_text.value = f"Release Notes:\n{update_info['release_notes']}"

                    if update_info.get("is_mandatory"):
                        update_status_text.value += " (MANDATORY)"
                        update_status_text.color = ft.colors.ORANGE_700
                else:
                    update_status_text.value = f"You are running the latest version ({update_info['current_version']})"
                    update_status_text.color = ft.colors.GREEN_700
                    download_button.visible = False
            else:
                # Check without license manager
                update_status_text.value = f"Current version: {APP_VERSION}"
                update_status_text.color = ft.colors.GREY_600

            update_button.disabled = False
            page.update()

        def download_update(e):
            if e.control.data:
                download_button.disabled = True
                update_status_text.value = "Starting download..."
                page.update()

                success, msg = license_manager.download_update(e.control.data)
                if success:
                    update_status_text.value = msg
                    update_status_text.color = ft.colors.GREEN_700
                else:
                    update_status_text.value = msg
                    update_status_text.color = ft.colors.RED_700

                download_button.disabled = False
                page.update()

        def deactivate_license(e):
            def confirm_deactivate(e):
                if license_manager:
                    success, msg = license_manager.deactivate()
                    if success:
                        confirm_dialog.open = False
                        page.update()
                        page.go("/activate")
                    else:
                        show_error(page, msg)

            confirm_dialog = build_dialog(
                _("Deactivate License"),
                ft.Text(_("This will deactivate the license on this machine. You can reactivate on another machine.")),
                [],
            )
            confirm_dialog.actions = [
                secondary_button(_("Cancel"), on_click=lambda e: setattr(confirm_dialog, "open", False) or page.update()),
                danger_button(_("Deactivate"), on_click=confirm_deactivate),
            ]
            open_dialog(page, confirm_dialog)

        update_button.on_click = check_for_updates
        download_button.on_click = download_update

        # Initialize license info
        refresh_license_info()

        return ft.Column([
            ft.Text(_("License & Updates"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
            ft.Divider(),

            # License Section
            ft.Container(
                content=ft.Column([
                    ft.Row([
                        license_status_icon,
                        license_status_text,
                    ]),
                    license_details,
                    ft.Row([
                        ft.TextButton(_("Refresh"), icon=ft.icons.REFRESH, on_click=lambda e: refresh_license_info()),
                        ft.TextButton(_("Deactivate License"), icon=ft.icons.LOGOUT, on_click=deactivate_license) if license_manager else ft.Container(),
                    ]),
                ], spacing=10),
                padding=SPACE_MD,
                border=ft.border.all(1, ft.colors.GREY_300),
                border_radius=10,
            ),

            ft.Divider(height=SPACE_LG),

            # Updates Section
            ft.Text(_("Software Updates"), size=16, weight=ft.FontWeight.BOLD),
            ft.Container(
                content=ft.Column([
                    version_text,
                    ft.Row([update_button, download_button]),
                    update_status_text,
                    release_notes_text,
                ], spacing=10),
                padding=SPACE_MD,
                border=ft.border.all(1, ft.colors.GREY_300),
                border_radius=10,
            ),
        ], spacing=SPACE_MD)

    # --- Backup Tab ---
    def create_backup_tab():
        def export_data(e):
            import json
            data = repo.get_all_data_export()
            # In a real app, you'd save to a file
            show_success(page, _("Data exported (check console)"))
            print(json.dumps(data, indent=2, default=str))

        def reset_data(e):
            def confirm_reset(e):
                import os
                from app.config import LOCAL_JSON_DB
                if os.path.exists(LOCAL_JSON_DB):
                    os.remove(LOCAL_JSON_DB)
                repo._ensure_local_db()
                confirm_dialog.open = False
                show_success(page, _("Data reset successfully. Please restart the app."))

            confirm_dialog = build_dialog(
                _("Confirm Reset"),
                ft.Text(_("This will delete ALL data. Are you sure?")),
                [],
            )
            confirm_dialog.actions = [
                secondary_button(_("Cancel"), on_click=lambda e: setattr(confirm_dialog, "open", False) or page.update()),
                danger_button(_("Reset"), on_click=confirm_reset),
            ]
            open_dialog(page, confirm_dialog)

        return ft.Column([
            ft.Text(_("Backup & Data"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            primary_button(_("Export Data (JSON)"), on_click=export_data, icon=ft.icons.DOWNLOAD),
            ft.Divider(height=30),
            ft.Text(_("Danger Zone"), color=ft.colors.RED_700, weight=ft.FontWeight.BOLD),
            danger_button(_("Reset All Data"), on_click=reset_data, icon=ft.icons.DELETE_FOREVER),
        ], spacing=SPACE_MD)

    tabs = ft.Tabs(
        selected_index=0,
        tabs=[
            ft.Tab(text=_("Shop Settings"), icon=ft.icons.STORE, content=ft.Container(create_shop_settings(), padding=24)),
            ft.Tab(text=_("License & Updates"), icon=ft.icons.VERIFIED_USER, content=ft.Container(create_license_tab(), padding=24)),
            ft.Tab(text=_("Backup"), icon=ft.icons.BACKUP, content=ft.Container(create_backup_tab(), padding=24)),
        ],
        expand=True
    )

    return ft.View(
        "/settings",
        [
            standard_appbar(_("Settings"), on_back=lambda _: page.go("/")),
            ft.Container(content=tabs, expand=True, padding=SPACE_MD)
        ]
    )






