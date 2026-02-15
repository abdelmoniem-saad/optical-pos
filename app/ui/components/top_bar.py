import flet as ft
import subprocess
import os
from app.core.i18n import _


def create_top_bar(page: ft.Page, repo, current_route: str = "/"):
    """
    Create a persistent top bar with:
    - Quick navigation buttons
    - Calculator (opens system calculator)
    - Global search
    """

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
            page.snack_bar = ft.SnackBar(ft.Text(f"{_('Error')}: {str(ex)}"))
            page.snack_bar.open = True
            page.update()

    def close_dialog(dialog):
        dialog.open = False
        page.update()

    # --- Quick Search with Dialog ---
    def show_search_results(e):
        term = search_field.value
        if not term or len(term) < 2:
            return

        term_lower = term.lower()
        results_content = ft.Column([], spacing=5, scroll=ft.ScrollMode.AUTO)

        # Search customers
        customers = repo.get_customers()
        matching_customers = [c for c in customers if
            term_lower in c.get("name", "").lower() or
            term_lower in (c.get("phone") or "").lower()][:5]

        # Search products
        products = repo.get_inventory()
        matching_products = [p for p in products if
            term_lower in p.get("name", "").lower() or
            term_lower in (p.get("sku") or "").lower()][:5]

        # Search invoices
        sales = repo.get_sales()
        matching_sales = [s for s in sales if term_lower in s.get("invoice_no", "").lower()][:5]

        def go_to_and_close(route):
            search_dialog.open = False
            search_field.value = ""
            page.update()
            page.go(route)

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
                results_content.controls.append(
                    ft.Container(
                        ft.ListTile(
                            leading=ft.Icon(ft.icons.PERSON, color=ft.colors.BLUE_500),
                            title=ft.Text(c.get("name", ""), weight=ft.FontWeight.W_500),
                            subtitle=ft.Text(f"📱 {c.get('phone', 'N/A')} | 📍 {c.get('city', 'N/A')}", size=12),
                            on_click=lambda e, cid=c["id"]: go_to_and_close(f"/prescription/{cid}"),
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
                            title=ft.Text(p.get("name", ""), weight=ft.FontWeight.W_500),
                            subtitle=ft.Text(f"SKU: {p.get('sku', 'N/A')} | {_('Price')}: {p.get('sale_price', 0):.2f}", size=12),
                            on_click=lambda e: go_to_and_close("/inventory"),
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
                        cust_name = cust.get("name", _("Walk-in"))
                results_content.controls.append(
                    ft.Container(
                        ft.ListTile(
                            leading=ft.Icon(ft.icons.RECEIPT, color=ft.colors.ORANGE_500),
                            title=ft.Text(f"#{s.get('invoice_no', '')} - {cust_name}", weight=ft.FontWeight.W_500),
                            subtitle=ft.Text(f"{s.get('order_date', '')[:10] if s.get('order_date') else ''} | {float(s.get('net_amount', 0)):.2f}", size=12),
                            on_click=lambda e: go_to_and_close("/history"),
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
                ft.TextButton(_("Close"), on_click=lambda e: close_dialog(search_dialog))
            ]
        )
        page.dialog = search_dialog
        search_dialog.open = True
        page.update()

    search_field = ft.TextField(
        hint_text=_("Search & Press Enter..."),
        prefix_icon=ft.icons.SEARCH,
        border_radius=20,
        height=40,
        text_size=14,
        content_padding=ft.padding.only(left=10, right=10),
        on_submit=show_search_results,
        width=220,
    )

    # --- Navigation Buttons ---
    def nav_btn(icon, tooltip, route, is_active=False):
        return ft.IconButton(
            icon=icon,
            tooltip=tooltip,
            icon_color=ft.colors.WHITE if is_active else ft.colors.BLUE_200,
            bgcolor=ft.colors.BLUE_900 if is_active else None,
            on_click=lambda e: page.go(route),
        )

    # --- Top Bar ---
    top_bar = ft.Container(
        content=ft.Row([
            # Logo/Home
            ft.Container(
                ft.Row([
                    ft.Icon(ft.icons.STORE, color=ft.colors.WHITE, size=24),
                    ft.Text("Lensy POS", color=ft.colors.WHITE, weight=ft.FontWeight.BOLD, size=16),
                ], spacing=8),
                on_click=lambda e: page.go("/"),
                padding=ft.padding.only(right=15),
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
        padding=ft.padding.symmetric(horizontal=15, vertical=8),
    )

    return top_bar
