# Apply Flet compatibility patches FIRST before any other imports
import app.flet_compat  # noqa: F401 - patches ft.colors, ft.icons, etc.

import flet as ft
import os
import traceback

from app.config import IS_SERVER
from app.database.repository import POSRepository
from app.ui.flet_pages.dashboard import DashboardView
from app.ui.flet_pages.inventory import InventoryView
from app.ui.flet_pages.customers import CustomersView
from app.ui.flet_pages.prescriptions import PrescriptionView
from app.ui.flet_pages.login import LoginView
from app.ui.flet_pages.pos import POSView
from app.ui.flet_pages.lab import LabView
from app.ui.flet_pages.staff import StaffView
from app.ui.flet_pages.settings import SettingsView
from app.ui.flet_pages.history import HistoryView
from app.ui.flet_pages.reports import ReportsView
from app.ui.components.top_bar import create_top_bar

# Licensing - can be disabled for development
ENABLE_LICENSING = os.environ.get("ENABLE_LICENSING", "false").lower() == "true"

def main(page: ft.Page):
    print("[BOOT] main() started", flush=True)

    no_transition_theme = ft.Theme(
        page_transitions=ft.PageTransitionsTheme(
            android=ft.PageTransitionTheme.NONE,
            ios=ft.PageTransitionTheme.NONE,
            linux=ft.PageTransitionTheme.NONE,
            macos=ft.PageTransitionTheme.NONE,
            windows=ft.PageTransitionTheme.NONE,
        )
    )

    def on_page_error(e):
        # Surface event-handler errors that would otherwise look like "button does nothing".
        try:
            print(f"[PAGE][ERROR] {getattr(e, 'data', e)}", flush=True)
        except Exception:
            print("[PAGE][ERROR] Unknown page error", flush=True)
        traceback.print_exc()

    page.on_error = on_page_error

    # Base Configuration
    page.title = "Lensy POS"
    page.theme = no_transition_theme
    page.dark_theme = no_transition_theme
    page.theme_mode = ft.ThemeMode.LIGHT
    page.padding = 0
    page.spacing = 0
    
    # Check if running on server/web
    is_web = IS_SERVER

    # Open in fullscreen/maximized mode (only for desktop)
    if not is_web:
        try:
            page.window.maximized = True
        except:
            pass

    # Session State - use page.data dict for session storage
    if not hasattr(page, 'data') or page.data is None:
        page.data = {}
    page.data["user"] = None

    # Initialize Repository
    repo = POSRepository()

    section_shell = ft.View(route="/", controls=[], padding=0, spacing=0)

    # Initialize License Manager (for desktop builds)
    license_manager = None
    if ENABLE_LICENSING and not is_web:
        try:
            from app.core.licensing import LicenseManager
            license_manager = LicenseManager(repo.supabase)
            page.data["license_manager"] = license_manager
        except Exception as e:
            print(f"[LICENSE] Failed to initialize: {e}")

    def on_login_success(user):
        page.data["user"] = user
        page.go("/")

    def on_license_activated():
        """Called when license is successfully activated."""
        page.go("/login")

    section_builders = {
        "/": lambda: DashboardView(page, repo),
        "/inventory": lambda: InventoryView(page, repo),
        "/customers": lambda: CustomersView(page, repo),
        "/pos": lambda: POSView(page, repo),
        "/lab": lambda: LabView(page, repo),
        "/staff": lambda: StaffView(page, repo),
        "/settings": lambda: SettingsView(page, repo),
        "/history": lambda: HistoryView(page, repo),
        "/reports": lambda: ReportsView(page, repo),
    }

    def navigate(route: str):
        if route in section_builders and page.data.get("user"):
            render_section(route)
            return
        page.go(route)

    def wrap_with_top_bar(view_content, route):
        """Wrap a view with the top bar."""
        top_bar = create_top_bar(page, repo, route, on_navigate=navigate)

        # If view_content is a View, extract its controls
        if isinstance(view_content, ft.View):
            # Get controls excluding the AppBar (we'll use top_bar instead)
            controls = [c for c in view_content.controls if not isinstance(c, ft.AppBar)]
            return ft.View(
                route,
                [
                    top_bar,
                    ft.Container(
                        content=ft.Container(
                            key=f"route-shell-{route}",
                            content=ft.Column(controls, expand=True, spacing=0),
                            expand=True,
                        ),
                        expand=True,
                    )
                ],
                padding=0,
                spacing=0,
            )
        return view_content

    def render_section(route: str):
        builder = section_builders.get(route)
        if not builder:
            return False

        wrapped = wrap_with_top_bar(builder(), route)
        section_shell.route = route
        section_shell.controls = wrapped.controls
        section_shell.padding = wrapped.padding
        section_shell.spacing = wrapped.spacing

        if not page.views or page.views[-1] is not section_shell:
            page.views.clear()
            page.views.append(section_shell)

        page.route = route
        page.update()
        return True

    def route_change(e):
        try:
            print(f"[ROUTE] route_change -> {page.route}", flush=True)
            page.views.clear()

            # License Guard (for desktop builds with licensing enabled)
            if license_manager and page.route != "/activate":
                is_licensed, license_msg = license_manager.is_licensed()
                if not is_licensed:
                    from app.ui.flet_pages.activation import ActivationView
                    page.views.append(ActivationView(page, license_manager, on_license_activated))
                    page.update()
                    return

            # Auth Guard
            user = page.data.get("user") if hasattr(page, 'data') and page.data else None
            if not user and page.route != "/login" and page.route != "/activate":
                page.go("/login")
                return

            # Routing Logic
            if page.route == "/activate":
                if license_manager:
                    from app.ui.flet_pages.activation import ActivationView
                    page.views.append(ActivationView(page, license_manager, on_license_activated))
                else:
                    page.go("/login")
            elif page.route == "/login":
                page.views.append(LoginView(page, repo, on_login_success))
            elif page.route == "/":
                render_section("/")
                return
            elif page.route == "/inventory":
                render_section("/inventory")
                return
            elif page.route == "/customers":
                render_section("/customers")
                return
            elif page.route.startswith("/prescription/"):
                cust_id = page.route.split("/")[-1]
                page.views.append(wrap_with_top_bar(PrescriptionView(page, repo, cust_id), page.route))
            elif page.route == "/pos":
                render_section("/pos")
                return
            elif page.route == "/lab":
                render_section("/lab")
                return
            elif page.route == "/staff":
                render_section("/staff")
                return
            elif page.route == "/settings":
                render_section("/settings")
                return
            elif page.route == "/history":
                render_section("/history")
                return
            elif page.route == "/reports":
                render_section("/reports")
                return
            else:
                page.go("/login")
                return

            page.update()
        except Exception as ex:
            print(f"[ROUTE] Failed to render route '{page.route}': {ex}", flush=True)
            page.views.clear()
            page.views.append(
                ft.View(
                    route="/error",
                    controls=[
                        ft.Container(
                            expand=True,
                            alignment=ft.Alignment(0, 0),
                            content=ft.Column(
                                [
                                    ft.Text("Startup error", size=22, weight=ft.FontWeight.BOLD),
                                    ft.Text(str(ex), selectable=True),
                                ],
                                tight=True,
                                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                            ),
                        )
                    ],
                )
            )
            page.update()

    def view_pop(e):
        if len(page.views) > 1:
            page.views.pop()
            top_view = page.views[-1]
            page.go(top_view.route or "/login")

    page.on_route_change = route_change
    page.on_view_pop = view_pop

    # Initial Navigation - check license first (for desktop), then login
    if license_manager:
        is_licensed, _ = license_manager.is_licensed()
        if not is_licensed:
            page.go("/activate")
        else:
            page.go("/login")
    else:
        page.go("/login")

    # Fallback: in some desktop/runtime combinations, go() may not trigger
    # immediate first render; force one so app never starts as a blank window.
    if not page.views:
        route_change(None)

# This is the entry point for `flet build web`
def web_main(page: ft.Page):
    main(page)

if __name__ == "__main__":
    import sys

    def launch_flet(target, **kwargs):
        """Launch app across Flet versions.

        Newer Flet prefers run(); older versions only provide app().
        """
        is_web_mode = kwargs.get("view") == ft.AppView.WEB_BROWSER

        # Desktop startup is more reliable with app() across mixed local installs.
        if not is_web_mode and hasattr(ft, "app"):
            print("[BOOT] Launching with ft.app() [desktop compatibility]", flush=True)
            return ft.app(target=target, **kwargs)

        if hasattr(ft, "run"):
            print("[BOOT] Launching with ft.run()", flush=True)
            return ft.run(target, **kwargs)

        print("[BOOT] Launching with ft.app()", flush=True)
        return ft.app(target=target, **kwargs)

    # Get port from environment variable (for Render/Railway/etc.)
    port = int(os.environ.get("PORT", 10000))

    # Check if running on a server
    is_server = IS_SERVER

    if is_server:
        print(f"Starting Flet web server on 0.0.0.0:{port}...", flush=True)
        sys.stdout.flush()
        # Run as web app on server
        launch_flet(
            main,
            view=ft.AppView.WEB_BROWSER,
            port=port,
            host="0.0.0.0",
            upload_dir="uploads"
        )
    else:
        # Run locally as desktop app
        launch_flet(main, assets_dir="assets")
