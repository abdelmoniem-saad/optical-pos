"""
Lensy POS - License Activation UI
Shows activation screen if software is not licensed.
"""

import flet as ft
from app.core.licensing import LicenseManager


def ActivationView(page: ft.Page, license_manager: LicenseManager, on_activated):
    """License activation view."""

    # Check current license status
    is_licensed, license_message = license_manager.is_licensed()

    license_key_input = ft.TextField(
        label="License Key",
        hint_text="XXXX-XXXX-XXXX-XXXX",
        width=350,
        text_size=18,
        text_align=ft.TextAlign.CENTER,
        capitalization=ft.TextCapitalization.CHARACTERS,
        autofocus=True,
    )

    licensee_name_input = ft.TextField(
        label="Business Name (Optional)",
        hint_text="Your Store Name",
        width=350,
    )

    status_text = ft.Text(
        value="",
        size=14,
        text_align=ft.TextAlign.CENTER,
    )

    activate_button = ft.ElevatedButton(
        "Activate License",
        width=350,
        height=50,
        style=ft.ButtonStyle(
            shape=ft.RoundedRectangleBorder(radius=10),
            color=ft.colors.WHITE,
            bgcolor=ft.colors.BLUE_700,
        ),
    )

    machine_id_text = ft.Text(
        f"Machine ID: {license_manager.machine_id}",
        size=11,
        color=ft.colors.GREY_500,
        selectable=True,
    )

    def format_license_key(e):
        """Auto-format license key as user types."""
        value = license_key_input.value.upper().replace("-", "").replace(" ", "")
        # Remove any non-alphanumeric characters
        value = ''.join(c for c in value if c.isalnum())
        # Add dashes every 4 characters
        formatted = '-'.join([value[i:i+4] for i in range(0, len(value), 4)])
        if formatted != license_key_input.value:
            license_key_input.value = formatted[:19]  # Max: XXXX-XXXX-XXXX-XXXX
            page.update()

    def handle_activate(e):
        license_key = license_key_input.value.strip()
        licensee_name = licensee_name_input.value.strip()

        if not license_key:
            status_text.value = "Please enter a license key."
            status_text.color = ft.colors.RED_700
            page.update()
            return

        if len(license_key.replace("-", "")) != 16:
            status_text.value = "Invalid license key format. Expected: XXXX-XXXX-XXXX-XXXX"
            status_text.color = ft.colors.RED_700
            page.update()
            return

        status_text.value = "Validating license..."
        status_text.color = ft.colors.BLUE_700
        activate_button.disabled = True
        page.update()

        success, message = license_manager.activate(license_key, licensee_name)

        if success:
            status_text.value = message
            status_text.color = ft.colors.GREEN_700
            page.update()

            # Wait a moment then proceed to main app
            import time
            time.sleep(1)
            on_activated()
        else:
            status_text.value = message
            status_text.color = ft.colors.RED_700
            activate_button.disabled = False
            page.update()

    license_key_input.on_change = format_license_key
    activate_button.on_click = handle_activate
    license_key_input.on_submit = handle_activate

    return ft.View(
        route="/activate",
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        vertical_alignment=ft.MainAxisAlignment.CENTER,
        bgcolor=ft.colors.SURFACE,
        controls=[
            ft.Container(
                content=ft.Column([
                    ft.Icon(
                        name=ft.icons.VERIFIED_USER_OUTLINED,
                        size=80,
                        color=ft.colors.BLUE_700,
                    ),
                    ft.Text(
                        "Lensy POS",
                        size=32,
                        weight=ft.FontWeight.BOLD,
                        text_align=ft.TextAlign.CENTER,
                    ),
                    ft.Text(
                        "Software Activation",
                        size=16,
                        color=ft.colors.GREY_600,
                    ),
                    ft.Divider(height=30, color=ft.colors.TRANSPARENT),
                    ft.Text(
                        "Enter your license key to activate the software.",
                        size=14,
                        text_align=ft.TextAlign.CENTER,
                    ),
                    ft.Divider(height=10, color=ft.colors.TRANSPARENT),
                    license_key_input,
                    licensee_name_input,
                    ft.Divider(height=10, color=ft.colors.TRANSPARENT),
                    status_text,
                    ft.Divider(height=10, color=ft.colors.TRANSPARENT),
                    activate_button,
                    ft.Divider(height=20, color=ft.colors.TRANSPARENT),
                    machine_id_text,
                    ft.Divider(height=10, color=ft.colors.TRANSPARENT),
                    ft.TextButton(
                        "Need a license? Contact sales@lensy.com",
                        url="mailto:sales@lensy.com",
                    ),
                ],
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                spacing=5,
                ),
                padding=40,
                border_radius=20,
                bgcolor=ft.colors.SURFACE_VARIANT,
                width=450,
            )
        ]
    )


def LicenseInfoDialog(page: ft.Page, license_manager: LicenseManager):
    """Dialog showing license information and deactivation option."""

    license_info = license_manager.get_license_info()
    is_licensed, status_msg = license_manager.is_licensed()

    def handle_deactivate(e):
        success, msg = license_manager.deactivate()
        if success:
            page.dialog.open = False
            page.update()
            # Restart app or go to activation
            page.go("/activate")
        else:
            # Show error
            pass

    dialog = ft.AlertDialog(
        title=ft.Text("License Information"),
        content=ft.Container(
            width=400,
            content=ft.Column([
                ft.Row([
                    ft.Icon(
                        ft.icons.CHECK_CIRCLE if is_licensed else ft.icons.ERROR,
                        color=ft.colors.GREEN_700 if is_licensed else ft.colors.RED_700,
                    ),
                    ft.Text(status_msg, size=14),
                ]),
                ft.Divider(),
                ft.Text(f"License Key: {license_info.get('license_key', 'N/A')}" if license_info else "Not activated", size=12),
                ft.Text(f"Licensed To: {license_info.get('licensee_name', 'N/A')}" if license_info else "", size=12),
                ft.Text(f"License Type: {license_info.get('license_type', 'N/A').title()}" if license_info else "", size=12),
                ft.Text(f"Expires: {license_info.get('expires_at', 'Never')[:10] if license_info and license_info.get('expires_at') else 'Never'}", size=12),
                ft.Divider(),
                ft.Text(f"Machine ID: {license_manager.machine_id}", size=10, color=ft.colors.GREY_500, selectable=True),
            ], spacing=8),
        ),
        actions=[
            ft.TextButton("Close", on_click=lambda e: setattr(page.dialog, 'open', False) or page.update()),
            ft.TextButton(
                "Deactivate",
                on_click=handle_deactivate,
                style=ft.ButtonStyle(color=ft.colors.RED_700),
            ) if is_licensed else ft.Container(),
        ],
    )

    return dialog

