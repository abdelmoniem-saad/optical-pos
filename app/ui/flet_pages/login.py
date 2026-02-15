import flet as ft
from app.core.auth import authenticate_user
from app.core.i18n import _

class LoginView(ft.View):
    def __init__(self, page: ft.Page, repo, on_login_success):
        super().__init__(
            route="/login",
            horizontal_alignment=ft.CrossAxisAlignment.CENTER,
            vertical_alignment=ft.MainAxisAlignment.CENTER,
        )
        self._page = page
        self.repo = repo
        self.on_login_success = on_login_success

        self.username_input = ft.TextField(
            label=_("Username"),
            width=300,
            on_submit=lambda _: self.password_input.focus()
        )
        self.password_input = ft.TextField(
            label=_("Password"),
            password=True,
            can_reveal_password=True,
            width=300,
            on_submit=self.handle_login
        )
        self.error_text = ft.Text(color=ft.Colors.RED_700)

        self.controls = [
            ft.Container(
                content=ft.Column([
                    ft.Text(_("Welcome"), size=40, weight=ft.FontWeight.BOLD, text_align=ft.TextAlign.CENTER),
                    ft.Divider(height=20, color=ft.Colors.TRANSPARENT),
                    self.username_input,
                    self.password_input,
                    self.error_text,
                    ft.ElevatedButton(
                        text=_("Login"),
                        width=300,
                        height=50,
                        on_click=self.handle_login,
                        style=ft.ButtonStyle(
                            shape=ft.RoundedRectangleBorder(radius=10),
                            color=ft.Colors.WHITE,
                            bgcolor=ft.Colors.BLUE_700
                        )
                    ),
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                padding=40,
                border_radius=20,
                bgcolor=ft.Colors.SURFACE_VARIANT,
                width=400,
            )
        ]

    def handle_login(self, e):
        username = self.username_input.value
        password = self.password_input.value

        if not username or not password:
            self.error_text.value = _("Please enter both username and password.")
            self._page.update()
            return

        # Attempt to authenticate
        user = self.repo.authenticate(username, password)
        if user:
            self.on_login_success(user)
        else:
            self.error_text.value = _("Invalid username or password.")
            self._page.update()
