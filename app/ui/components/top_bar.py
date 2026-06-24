import flet as ft
import subprocess
import os
import traceback
from app.core.i18n import _
from app.core.search import search_all
from app.ui.components.design_helpers import close_dialog as close_dialog_safe, open_dialog
from app.ui.components.feedback import show_error, show_info
from app.ui.components.ui_tokens import (
    BODY_SIZE,
    BRAND_PRIMARY,
    BRAND_PRIMARY_BG,
    BRAND_PRIMARY_DARK,
    BRAND_PRIMARY_FAINT,
    BRAND_PRIMARY_LIGHT,
    INPUT_HEIGHT,
    ON_PRIMARY,
    SPACE_MD,
    SPACE_SM,
    SUCCESS,
    SUCCESS_BG,
    SUCCESS_LIGHT,
    TEXT_FAINT,
    TEXT_MUTED,
    TOPBAR_HEIGHT,
    TOPBAR_ICON_SIZE,
    WARNING,
    WARNING_BG,
    WARNING_LIGHT,
)
import flet as ft  # noqa: F811  (kept for tokens that resolve at import time)


def create_top_bar(page: ft.Page, repo, current_route: str = "/", on_navigate=None):
    """
    Create a persistent top bar with:
    - Quick navigation buttons
    - Calculator (opens system calculator)
    - Global search
    """

    navigate = on_navigate or page.go

    def safe_money(value, default="0.00"):
        try:
            return f"{float(value or 0):.2f}"
        except Exception:
            return default

    def show_search_error(message):
        show_error(page, message)

    # --- Open System Calculator ---
    def open_calculator(e):
        """Open the system's built-in calculator."""
        try:
            if os.name == 'nt':  # Windows
                subprocess.Popen('calc.exe')
            elif os.path.exists('/usr/bin/gnome-calculator'):  # Linux with GNOME
                subprocess.Popen(['gnome-calculator'])
            elif os.path.exists('/usr/bin/kcalc'):  # Linux with KDE
                subprocess.Popen(['kcalc'])
            else:  # Mac or other
                subprocess.Popen(['open', '-a', 'Calculator'])
        except Exception as ex:
            show_error(page, f"{_('Error')}: {str(ex)}")

    # --- Quick Search with Dialog ---
    def show_search_results(e=None):
        try:
            term = (search_field.value or "").strip()
            print(f"[SEARCH] Triggered, term='{term}'", flush=True)

            if len(term) < 2:
                show_info(page, _("Type at least 2 characters to search."))
                return

            results = search_all(repo, term)
            matching_customers = results["customers"]
            matching_products = results["products"]
            matching_sales = results["sales"]

            results_content = ft.Column([], spacing=5, scroll=ft.ScrollMode.AUTO)

            def go_to_and_close(route):
                search_dialog.open = False
                search_field.value = ""
                page.update()
                navigate(route)

            # Add Customers section
            if matching_customers:
                results_content.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.PEOPLE, color=BRAND_PRIMARY, size=18),
                            ft.Text(_("Customers"), weight=ft.FontWeight.BOLD, color=BRAND_PRIMARY)
                        ]),
                        padding=ft.padding.only(bottom=5)
                    )
                )
                for c in matching_customers:
                    cid = c.get("id")
                    click_cb = (lambda ev, customer_id=cid: go_to_and_close(f"/prescription/{customer_id}")) if cid else (lambda ev: go_to_and_close("/customers"))
                    results_content.controls.append(
                        ft.Container(
                            ft.ListTile(
                                leading=ft.Icon(ft.icons.PERSON, color=BRAND_PRIMARY_LIGHT),
                                title=ft.Text(str(c.get("name", "")), weight=ft.FontWeight.W_500),
                                subtitle=ft.Text(
                                    f"📱 {str(c.get('phone') or 'N/A')} | 📍 {str(c.get('city') or 'N/A')}",
                                    size=12,
                                ),
                                on_click=click_cb,
                            ),
                            bgcolor=BRAND_PRIMARY_BG,
                            border_radius=8,
                        )
                    )
                results_content.controls.append(ft.Divider(height=10))

            # Add Products section
            if matching_products:
                results_content.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.INVENTORY_2, color=SUCCESS, size=18),
                            ft.Text(_("Products"), weight=ft.FontWeight.BOLD, color=SUCCESS)
                        ]),
                        padding=ft.padding.only(bottom=5)
                    )
                )
                for p in matching_products:
                    results_content.controls.append(
                        ft.Container(
                            ft.ListTile(
                                leading=ft.Icon(ft.icons.INVENTORY_2, color=SUCCESS_LIGHT),
                                title=ft.Text(str(p.get("name", "")), weight=ft.FontWeight.W_500),
                                subtitle=ft.Text(
                                    f"SKU: {str(p.get('sku') or 'N/A')} | {_('Price')}: {safe_money(p.get('sale_price'))}",
                                    size=12,
                                ),
                                on_click=lambda ev: go_to_and_close("/inventory"),
                            ),
                            bgcolor=SUCCESS_BG,
                            border_radius=8,
                        )
                    )
                results_content.controls.append(ft.Divider(height=10))

            # Add Invoices section
            if matching_sales:
                results_content.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.RECEIPT_LONG, color=WARNING, size=18),
                            ft.Text(_("Invoices"), weight=ft.FontWeight.BOLD, color=WARNING)
                        ]),
                        padding=ft.padding.only(bottom=5)
                    )
                )
                # Resolve customer names for invoice subtitles. The search results
                # only contain matching customers, so fetch the full list here.
                all_customers = repo.get_customers() or []
                for s in matching_sales:
                    cust_name = _("Walk-in")
                    if s.get("customer_id"):
                        cust = next((c for c in all_customers if c.get("id") == s.get("customer_id")), None)
                        if cust:
                            cust_name = str(cust.get("name") or _("Walk-in"))
                    order_date = str(s.get("order_date") or "")
                    results_content.controls.append(
                        ft.Container(
                            ft.ListTile(
                                leading=ft.Icon(ft.icons.RECEIPT, color=WARNING_LIGHT),
                                title=ft.Text(f"#{str(s.get('invoice_no') or '')} - {cust_name}", weight=ft.FontWeight.W_500),
                                subtitle=ft.Text(
                                    f"{order_date[:10] if order_date else ''} | {safe_money(s.get('net_amount'))}",
                                    size=12,
                                ),
                                on_click=lambda ev: go_to_and_close("/history"),
                            ),
                            bgcolor=WARNING_BG,
                            border_radius=8,
                        )
                    )

            # No results
            if not matching_customers and not matching_products and not matching_sales:
                results_content.controls.append(
                    ft.Container(
                        ft.Column([
                            ft.Icon(ft.icons.SEARCH_OFF, size=50, color=TEXT_FAINT),
                            ft.Text(_("No results found"), size=16, color=TEXT_MUTED),
                            ft.Text(f'"{term}"', italic=True, color=TEXT_FAINT),
                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
                        padding=30,
                    )
                )

            search_dialog = ft.AlertDialog(
                title=ft.Row([
                    ft.Icon(ft.icons.SEARCH, color=BRAND_PRIMARY),
                    ft.Text(f"{_('Search Results')}: \"{term}\"", weight=ft.FontWeight.BOLD),
                ]),
                content=ft.Container(
                    results_content,
                    width=450,
                    height=400,
                ),
                actions=[
                    ft.TextButton(_("Close"), on_click=lambda ev: close_dialog_safe(page, search_dialog))
                ]
            )
            open_dialog(page, search_dialog)

        except Exception as ex:
            print(f"[SEARCH][ERROR] {ex}", flush=True)
            traceback.print_exc()
            show_search_error(f"{_('Search failed')}: {ex}")

    search_field = ft.TextField(
        hint_text=_("Search & Press Enter..."),
        prefix_icon=ft.icons.SEARCH,
        border_radius=20,
        height=INPUT_HEIGHT,
        text_size=BODY_SIZE,
        content_padding=ft.padding.only(left=10, right=10),
        on_submit=show_search_results,
        width=280,
    )

    search_button = ft.IconButton(
        icon=ft.icons.SEARCH,
        tooltip=_("Search"),
        icon_color=ON_PRIMARY,
        on_click=show_search_results,
    )

    # --- Navigation Buttons ---
    def nav_btn(icon, tooltip, route, is_active=False):
        return ft.IconButton(
            icon=icon,
            tooltip=tooltip,
            icon_size=TOPBAR_ICON_SIZE,
            icon_color=ON_PRIMARY if is_active else BRAND_PRIMARY_FAINT,
            bgcolor=BRAND_PRIMARY_DARK if is_active else None,
            style=ft.ButtonStyle(padding=ft.padding.all(10)),
            on_click=lambda e: navigate(route),
        )

    # --- Top Bar ---
    top_bar = ft.Container(
        content=ft.Row([
            # Logo/Home
            ft.Container(
                ft.Row([
                    ft.Icon(ft.icons.STORE, color=ON_PRIMARY, size=24),
                    ft.Text("Lensy POS", color=ON_PRIMARY, weight=ft.FontWeight.BOLD, size=18),
                ], spacing=8),
                on_click=lambda e: navigate("/"),
                padding=ft.padding.only(right=SPACE_MD),
            ),

            # Quick Nav Buttons
            nav_btn(ft.icons.DASHBOARD, _("Dashboard"), "/", current_route == "/"),
            nav_btn(ft.icons.SHOPPING_CART, _("POS"), "/pos", current_route == "/pos"),
            nav_btn(ft.icons.INVENTORY, _("Inventory"), "/inventory", current_route == "/inventory"),
            nav_btn(ft.icons.PEOPLE, _("Customers"), "/customers", current_route == "/customers"),
            nav_btn(ft.icons.SCIENCE, _("Lab"), "/lab", current_route == "/lab"),
            nav_btn(ft.icons.HISTORY, _("History"), "/history", current_route == "/history"),
            nav_btn(ft.icons.BAR_CHART, _("Reports"), "/reports", current_route == "/reports"),

            # Spacer
            ft.Container(expand=True),

            # Search Field
            search_field,
            search_button,

            # Calculator
            ft.IconButton(
                icon=ft.icons.CALCULATE,
                tooltip=_("Calculator"),
                icon_color=ON_PRIMARY,
                on_click=open_calculator,
            ),

            # Settings
            nav_btn(ft.icons.SETTINGS, _("Settings"), "/settings", current_route == "/settings"),

        ], spacing=2, alignment=ft.MainAxisAlignment.START),
        bgcolor=BRAND_PRIMARY,
        padding=ft.padding.symmetric(horizontal=SPACE_MD, vertical=SPACE_SM),
        height=TOPBAR_HEIGHT,
    )

    return top_bar




