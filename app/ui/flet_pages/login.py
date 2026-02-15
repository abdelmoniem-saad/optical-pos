import flet as ft
from app.core.i18n import _


def LoginView(page: ft.Page, repo, on_login_success):
    """Login view - returns a ft.View"""

    username_input = ft.TextField(
        label=_("Username"),
        width=300,
    )
    password_input = ft.TextField(
        label=_("Password"),
        password=True,
        can_reveal_password=True,
        width=300,
    )
    error_text = ft.Text(color=ft.colors.RED_700)

    def handle_login(e):
        username = username_input.value
        password = password_input.value

        if not username or not password:
            error_text.value = _("Please enter both username and password.")
            page.update()
            return

        # Attempt to authenticate
        user = repo.authenticate(username, password)
        if user:
            on_login_success(user)
        else:
            error_text.value = _("Invalid username or password.")
            page.update()

    # Set up on_submit after handle_login is defined
    username_input.on_submit = lambda _: password_input.focus()
    password_input.on_submit = handle_login

    return ft.View(
        route="/login",
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        vertical_alignment=ft.MainAxisAlignment.CENTER,
        controls=[
            ft.Container(
                content=ft.Column([
                    ft.Text(_("Welcome"), size=40, weight=ft.FontWeight.BOLD, text_align=ft.TextAlign.CENTER),
                    ft.Divider(height=20, color=ft.colors.TRANSPARENT),
                    username_input,
                    password_input,
                    error_text,
                    ft.ElevatedButton(
                        _("Login"),
                        width=300,
                        height=50,
                        on_click=handle_login,
                        style=ft.ButtonStyle(
                            shape=ft.RoundedRectangleBorder(radius=10),
                            color=ft.colors.WHITE,
                            bgcolor=ft.colors.BLUE_700
                        )
                    ),
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                padding=40,
                border_radius=20,
                bgcolor=ft.colors.SURFACE_VARIANT,
                width=400,
            )
        ]
    )



