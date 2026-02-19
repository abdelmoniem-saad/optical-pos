import flet as ft
import os
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
    # Base Configuration
    page.title = "Lensy POS"
    page.theme_mode = ft.ThemeMode.LIGHT
    page.padding = 0
    page.spacing = 0
    
    # Check if running on server/web
    is_web = os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("FLY_APP_NAME")

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

    def wrap_with_top_bar(view_content, route):
        """Wrap a view with the top bar."""
        top_bar = create_top_bar(page, repo, route)

        # If view_content is a View, extract its controls
        if isinstance(view_content, ft.View):
            # Get controls excluding the AppBar (we'll use top_bar instead)
            controls = [c for c in view_content.controls if not isinstance(c, ft.AppBar)]
            return ft.View(
                route,
                [
                    top_bar,
                    ft.Container(
                        content=ft.Column(controls, expand=True, spacing=0),
                        expand=True,
                    )
                ],
                padding=0,
                spacing=0,
            )
        return view_content

    def route_change(e):
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
            page.views.append(wrap_with_top_bar(DashboardView(page, repo), "/"))
        elif page.route == "/inventory":
            page.views.append(wrap_with_top_bar(InventoryView(page, repo), "/inventory"))
        elif page.route == "/customers":
            page.views.append(wrap_with_top_bar(CustomersView(page, repo), "/customers"))
        elif page.route.startswith("/prescription/"):
            cust_id = page.route.split("/")[-1]
            page.views.append(wrap_with_top_bar(PrescriptionView(page, repo, cust_id), page.route))
        elif page.route == "/pos":
            page.views.append(wrap_with_top_bar(POSView(page, repo), "/pos"))
        elif page.route == "/lab":
            page.views.append(wrap_with_top_bar(LabView(page, repo), "/lab"))
        elif page.route == "/staff":
            page.views.append(wrap_with_top_bar(StaffView(page, repo), "/staff"))
        elif page.route == "/settings":
            page.views.append(wrap_with_top_bar(SettingsView(page, repo), "/settings"))
        elif page.route == "/history":
            page.views.append(wrap_with_top_bar(HistoryView(page, repo), "/history"))
        elif page.route == "/reports":
            page.views.append(wrap_with_top_bar(ReportsView(page, repo), "/reports"))

        page.update()

    def view_pop(e):
        if len(page.views) > 1:
            page.views.pop()
            top_view = page.views[-1]
            page.go(top_view.route)

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

# This is the entry point for `flet build web`
def web_main(page: ft.Page):
    main(page)

if __name__ == "__main__":
    import sys

    # Get port from environment variable (for Render/Railway/etc.)
    port = int(os.environ.get("PORT", 10000))

    # Check if running on a server
    is_server = os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("FLY_APP_NAME")

    if is_server:
        print(f"Starting Flet web server on 0.0.0.0:{port}...", flush=True)
        sys.stdout.flush()
        # Run as web app on server
        ft.app(
            target=main,
            view=ft.AppView.WEB_BROWSER,
            port=port,
            host="0.0.0.0",
            upload_dir="uploads"
        )
    else:
        # Run locally as desktop app
        ft.app(target=main, assets_dir="assets")

