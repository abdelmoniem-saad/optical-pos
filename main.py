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
            page.window_maximized = True
        except:
            pass

    # Session State - use page.data dict for session storage
    if not hasattr(page, 'data') or page.data is None:
        page.data = {}
    page.data["user"] = None

    # Initialize Repository
    repo = POSRepository()

    def on_login_success(user):
        page.data["user"] = user
        page.go("/")

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
        
        # Auth Guard
        user = page.data.get("user") if hasattr(page, 'data') and page.data else None
        if not user and page.route != "/login":
            page.go("/login")
            return

        # Routing Logic
        if page.route == "/login":
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
    
    # Initial Navigation - always start with login check
    page.go("/login")

# This is the entry point for `flet build web`
def web_main(page: ft.Page):
    main(page)

if __name__ == "__main__":
    # Get port from environment variable (for Render/Railway/etc.)
    port = int(os.environ.get("PORT", 8550))

    # Check if running on a server
    is_server = os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("FLY_APP_NAME")

    if is_server:
        # Run as web app on server
        ft.app(main, view=ft.AppView.WEB_BROWSER, port=port, host="0.0.0.0")
    else:
        # Run locally as desktop app
        ft.app(main, assets_dir="assets")

