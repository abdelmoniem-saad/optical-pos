import flet as ft
import subprocess
import os
import traceback
from app.core.i18n import _
from app.ui.components.design_helpers import close_dialog as close_dialog_safe, open_dialog
from app.ui.components.feedback import show_error, show_info
from app.ui.components.ui_tokens import (
    BODY_SIZE,
    INPUT_HEIGHT,
    SPACE_MD,
    SPACE_SM,
    TOPBAR_HEIGHT,
    TOPBAR_ICON_SIZE,
)


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

            term_lower = term.lower()
            results_content = ft.Column([], spacing=5, scroll=ft.ScrollMode.AUTO)

            # Search customers
            customers = repo.get_customers() or []
            matching_customers = [
                c for c in customers
                if term_lower in str(c.get("name", "")).lower()
                or term_lower in str(c.get("phone") or "").lower()
            ][:5]

            # Search products
            products = repo.get_inventory() or []
            matching_products = [
                p for p in products
                if term_lower in str(p.get("name", "")).lower()
                or term_lower in str(p.get("sku") or "").lower()
            ][:5]

            # Search invoices
            sales = repo.get_sales() or []
            matching_sales = [
                s for s in sales if term_lower in str(s.get("invoice_no", "")).lower()
            ][:5]
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
                            ft.Icon(ft.icons.PEOPLE, color=ft.colors.BLUE_700, size=18),
                            ft.Text(_("Customers"), weight=ft.FontWeight.BOLD, color=ft.colors.BLUE_700)
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
                                leading=ft.Icon(ft.icons.PERSON, color=ft.colors.BLUE_500),
                                title=ft.Text(str(c.get("name", "")), weight=ft.FontWeight.W_500),
                                subtitle=ft.Text(
                                    f"📱 {str(c.get('phone') or 'N/A')} | 📍 {str(c.get('city') or 'N/A')}",
                                    size=12,
                                ),
                                on_click=click_cb,
                            ),
                            bgcolor=ft.colors.BLUE_50,
                            border_radius=8,
                        )
                    )
                results_content.controls.append(ft.Divider(height=10))

            # Add Products section
            if matching_products:
                results_content.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.INVENTORY_2, color=ft.colors.GREEN_700, size=18),
                            ft.Text(_("Products"), weight=ft.FontWeight.BOLD, color=ft.colors.GREEN_700)
                        ]),
                        padding=ft.padding.only(bottom=5)
                    )
                )
                for p in matching_products:
                    results_content.controls.append(
                        ft.Container(
                            ft.ListTile(
                                leading=ft.Icon(ft.icons.INVENTORY_2, color=ft.colors.GREEN_500),
                                title=ft.Text(str(p.get("name", "")), weight=ft.FontWeight.W_500),
                                subtitle=ft.Text(
                                    f"SKU: {str(p.get('sku') or 'N/A')} | {_('Price')}: {safe_money(p.get('sale_price'))}",
                                    size=12,
                                ),
                                on_click=lambda ev: go_to_and_close("/inventory"),
                            ),
                            bgcolor=ft.colors.GREEN_50,
                            border_radius=8,
                        )
                    )
                results_content.controls.append(ft.Divider(height=10))

            # Add Invoices section
            if matching_sales:
                results_content.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.RECEIPT_LONG, color=ft.colors.ORANGE_700, size=18),
                            ft.Text(_("Invoices"), weight=ft.FontWeight.BOLD, color=ft.colors.ORANGE_700)
                        ]),
                        padding=ft.padding.only(bottom=5)
                    )
                )
                for s in matching_sales:
                    cust_name = _("Walk-in")
                    if s.get("customer_id"):
                        cust = next((c for c in customers if c.get("id") == s.get("customer_id")), None)
                        if cust:
                            cust_name = str(cust.get("name") or _("Walk-in"))
                    order_date = str(s.get("order_date") or "")
                    results_content.controls.append(
                        ft.Container(
                            ft.ListTile(
                                leading=ft.Icon(ft.icons.RECEIPT, color=ft.colors.ORANGE_500),
                                title=ft.Text(f"#{str(s.get('invoice_no') or '')} - {cust_name}", weight=ft.FontWeight.W_500),
                                subtitle=ft.Text(
                                    f"{order_date[:10] if order_date else ''} | {safe_money(s.get('net_amount'))}",
                                    size=12,
                                ),
                                on_click=lambda ev: go_to_and_close("/history"),
                            ),
                            bgcolor=ft.colors.ORANGE_50,
                            border_radius=8,
                        )
                    )

            # No results
            if not matching_customers and not matching_products and not matching_sales:
                results_content.controls.append(
                    ft.Container(
                        ft.Column([
                            ft.Icon(ft.icons.SEARCH_OFF, size=50, color=ft.colors.GREY_400),
                            ft.Text(_("No results found"), size=16, color=ft.colors.GREY_600),
                            ft.Text(f'"{term}"', italic=True, color=ft.colors.GREY_500),
                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
                        padding=30,
                    )
                )

            search_dialog = ft.AlertDialog(
                title=ft.Row([
                    ft.Icon(ft.icons.SEARCH, color=ft.colors.BLUE_700),
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
        icon_color=ft.colors.WHITE,
        on_click=show_search_results,
    )

    # --- Navigation Buttons ---
    def nav_btn(icon, tooltip, route, is_active=False):
        return ft.IconButton(
            icon=icon,
            tooltip=tooltip,
            icon_size=TOPBAR_ICON_SIZE,
            icon_color=ft.colors.WHITE if is_active else ft.colors.BLUE_200,
            bgcolor=ft.colors.BLUE_900 if is_active else None,
            style=ft.ButtonStyle(padding=ft.padding.all(10)),
            on_click=lambda e: navigate(route),
        )

    # --- Top Bar ---
    top_bar = ft.Container(
        content=ft.Row([
            # Logo/Home
            ft.Container(
                ft.Row([
                    ft.Icon(ft.icons.STORE, color=ft.colors.WHITE, size=24),
                    ft.Text("Lensy POS", color=ft.colors.WHITE, weight=ft.FontWeight.BOLD, size=18),
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
                icon_color=ft.colors.WHITE,
                on_click=open_calculator,
            ),

            # Settings
            nav_btn(ft.icons.SETTINGS, _("Settings"), "/settings", current_route == "/settings"),

        ], spacing=2, alignment=ft.MainAxisAlignment.START),
        bgcolor=ft.colors.BLUE_700,
        padding=ft.padding.symmetric(horizontal=SPACE_MD, vertical=SPACE_SM),
        height=TOPBAR_HEIGHT,
    )

    return top_bar




