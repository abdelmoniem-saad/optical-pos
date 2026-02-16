import flet as ft
from app.core.i18n import _


def LoginView(page: ft.Page, repo, on_login_success):
    """Login view - returns a ft.View"""

    username_input = ft.TextField(
        label=_("Username"),
        width=300,
        autofocus=True,
    )
    password_input = ft.TextField(
        label=_("Password"),
        password=True,
        can_reveal_password=True,
        width=300,
    )
    error_text = ft.Text(color=ft.colors.RED_700, size=14)

    login_button = ft.ElevatedButton(
        _("Login"),
        width=300,
        height=50,
        style=ft.ButtonStyle(
            shape=ft.RoundedRectangleBorder(radius=10),
            color=ft.colors.WHITE,
            bgcolor=ft.colors.BLUE_700
        )
    )

    def handle_login(e):
        error_text.value = _("Logging in...")
        error_text.color = ft.colors.BLUE_700
        login_button.disabled = True
        page.update()

        try:
            username = username_input.value.strip() if username_input.value else ""
            password = password_input.value if password_input.value else ""

            if not username or not password:
                error_text.value = _("Please enter both username and password.")
                error_text.color = ft.colors.RED_700
                login_button.disabled = False
                page.update()
                return

            user = repo.authenticate(username, password)

            if user:
                error_text.value = _("Success! Redirecting...")
                error_text.color = ft.colors.GREEN_700
                page.update()
                on_login_success(user)
            else:
                error_text.value = _("Invalid username or password.")
                error_text.color = ft.colors.RED_700
                login_button.disabled = False
                page.update()
        except Exception as ex:
            error_text.value = f"{_('Error')}: {str(ex)}"
            error_text.color = ft.colors.RED_700
            login_button.disabled = False
            page.update()

    login_button.on_click = handle_login
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
                    ft.Text(_("Lensy POS"), size=14, color=ft.colors.GREY_500),
                    ft.Divider(height=20, color=ft.colors.TRANSPARENT),
                    username_input,
                    password_input,
                    error_text,
                    login_button,
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                padding=40,
                border_radius=20,
                bgcolor=ft.colors.SURFACE_VARIANT,
                width=400,
            )
        ]
    )






