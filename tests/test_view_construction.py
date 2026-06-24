"""Smoke-construct every flet_pages view with stub page+repo.

Catches Flet API drift (renamed kwargs, restructured controls) at test
time without needing a running app. The compat shim in app/flet_compat
loads via tests/conftest.py before this runs.
"""

import flet as ft
import pytest


class FakeRepo:
    """Minimal repo stub. Returns sensible empty values for the methods
    that the views call during construction."""

    backend = "local"
    backend_mode = "auto"
    supabase = None

    def __getattr__(self, name):
        def stub(*args, **kwargs):
            if name.startswith(("get_", "search_")) or name == "find_product_by_name_or_sku":
                return []
            if name == "get_product_stock":
                return 0
            if name == "get_next_invoice_no":
                return "000001"
            if name == "get_setting":
                return ""
            if name == "generate_sku":
                return "SKU000"
            if name == "has_permission":
                return (True, None)
            return None

        return stub


class FakePage:
    """Minimal Flet page stub. Just enough state for view factories."""

    route = "/"
    views = []
    overlay = []
    on_keyboard_event = None
    on_route_change = None
    on_view_pop = None
    on_error = None
    theme = None
    dark_theme = None
    theme_mode = None
    padding = 0
    spacing = 0
    title = ""

    def __init__(self):
        self.data = {"user": {"id": "1", "username": "admin", "role": {"name": "Admin"}}}
        self.window = type("w", (), {"maximized": False})()

    def update(self):
        pass

    def update_async(self):
        pass

    def go(self, route):
        pass

    def show_dialog(self, dialog):
        pass

    def open(self, dialog):
        pass

    def close(self, dialog):
        pass

    def pop_dialog(self):
        pass


@pytest.fixture
def page():
    return FakePage()


@pytest.fixture
def repo():
    return FakeRepo()


def test_view_positional_order_compat():
    """Regression: ft.View positional args were reversed in Flet 0.80+
    (now ``View(controls, route, ...)``, was ``View(route, controls, ...)``).
    The codebase passes ``ft.View("/route", [controls...])`` in many places.
    The compat shim swaps these. If this test fails, the View shim broke
    and all post-login screens will render blank because controls becomes
    a string and route becomes a list.
    """
    import flet as ft

    v = ft.View("/login", [ft.Text("hello"), ft.Text("world")])
    assert v.route == "/login", f"route should be '/login', got {v.route!r}"
    assert isinstance(v.controls, list), f"controls should be a list, got {type(v.controls).__name__}"
    assert len(v.controls) == 2, f"controls should have 2 items, got {len(v.controls)}"


def test_dashboard_view_has_route_and_controls(page, repo):
    """Regression for the blank-screen bug: a view's .route must be the route
    string and .controls must contain the actual controls list."""
    from app.ui.flet_pages.dashboard import DashboardView
    v = DashboardView(page, repo)
    assert v.route == "/", f"DashboardView.route should be '/', got {v.route!r}"
    assert isinstance(v.controls, list) and len(v.controls) > 0, (
        f"DashboardView.controls should be a non-empty list, got {v.controls!r}"
    )


def test_dashboard_view_constructs(page, repo):
    from app.ui.flet_pages.dashboard import DashboardView
    DashboardView(page, repo)


def test_inventory_view_constructs(page, repo):
    from app.ui.flet_pages.inventory import InventoryView
    InventoryView(page, repo)


def test_customers_view_constructs(page, repo):
    from app.ui.flet_pages.customers import CustomersView
    CustomersView(page, repo)


def test_prescriptions_view_constructs(page, repo):
    from app.ui.flet_pages.prescriptions import PrescriptionView
    PrescriptionView(page, repo, "1")


def test_login_view_constructs(page, repo):
    from app.ui.flet_pages.login import LoginView
    LoginView(page, repo, lambda user: None)


def test_pos_view_constructs(page, repo):
    from app.ui.flet_pages.pos import POSView
    POSView(page, repo)


def test_lab_view_constructs(page, repo):
    from app.ui.flet_pages.lab import LabView
    LabView(page, repo)


def test_staff_view_constructs(page, repo):
    from app.ui.flet_pages.staff import StaffView
    StaffView(page, repo)


def test_settings_view_constructs(page, repo):
    from app.ui.flet_pages.settings import SettingsView
    SettingsView(page, repo)


def test_history_view_constructs(page, repo):
    from app.ui.flet_pages.history import HistoryView
    HistoryView(page, repo)


def test_reports_view_constructs(page, repo):
    from app.ui.flet_pages.reports import ReportsView
    ReportsView(page, repo)
