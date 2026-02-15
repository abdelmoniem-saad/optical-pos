import flet as ft
from app.core.i18n import _

def DashboardView(page: ft.Page, repo):
    """Dashboard view with stats, navigation, and global search."""

    # --- Get Stats Data ---
    def get_stats():
        try:
            sales = repo.get_sales()
            customers = repo.get_customers()
            products = repo.get_inventory()

            total_revenue = sum(float(s.get("net_amount", 0)) for s in sales)
            total_paid = sum(float(s.get("amount_paid", 0)) for s in sales)
            pending_orders = len([s for s in sales if s.get("lab_status") and s.get("lab_status") != "Received"])

            return {
                "revenue": total_revenue,
                "orders": len(sales),
                "customers": len(customers),
                "products": len(products),
                "pending": pending_orders,
                "balance": total_revenue - total_paid,
                "sales": sales,
                "all_customers": customers
            }
        except Exception as e:
            print(f"Error loading stats: {e}")
            return {
                "revenue": 0, "orders": 0, "customers": 0, "products": 0,
                "pending": 0, "balance": 0, "sales": [], "all_customers": []
            }

    stats = get_stats()

    # --- Navigation ---
    def navigate(route):
        page.go(route)

    # --- Logout ---
    def logout(e):
        if hasattr(page, 'data') and page.data:
            page.data["user"] = None
        page.go("/login")

    # --- User Info ---
    user = page.data.get("user") if hasattr(page, 'data') and page.data else None
    user_name = user.get("full_name") or user.get("username") if user else "User"

    # --- Stat Card Builder ---
    def stat_card(title, value, icon, color, route):
        return ft.Container(
            content=ft.Column([
                ft.Icon(icon, size=32, color=color),
                ft.Text(str(value), size=24, weight=ft.FontWeight.BOLD),
                ft.Text(title, size=11, color=ft.Colors.GREY_700, text_align=ft.TextAlign.CENTER)
            ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=5, alignment=ft.MainAxisAlignment.CENTER),
            padding=15,
            border_radius=10,
            bgcolor=ft.Colors.SURFACE_VARIANT,
            on_click=lambda e: navigate(route),
            col={"xs": 6, "sm": 4, "md": 2},
            height=120
        )

    # --- Recent Orders ---
    recent_orders_controls = []
    for s in sorted(stats["sales"], key=lambda x: x.get("order_date", ""), reverse=True)[:5]:
        cust_name = _("Walk-in")
        if s.get("customer_id"):
            cust = next((c for c in stats["all_customers"] if c.get("id") == s.get("customer_id")), None)
            if cust:
                cust_name = cust.get("name", _("Walk-in"))

        status = s.get("lab_status", "N/A")
        status_color = ft.Colors.GREY_500
        if status == "Ready": status_color = ft.Colors.GREEN_500
        elif status == "In Lab": status_color = ft.Colors.ORANGE_500
        elif status == "Not Started": status_color = ft.Colors.RED_500

        recent_orders_controls.append(
            ft.ListTile(
                leading=ft.Icon(ft.Icons.RECEIPT, color=status_color),
                title=ft.Text(f"#{s.get('invoice_no', '')} - {cust_name}", size=14),
                subtitle=ft.Text(f"{s.get('order_date', '')[:10] if s.get('order_date') else ''} | {float(s.get('net_amount', 0)):.2f}", size=12),
                trailing=ft.Container(
                    ft.Text(status, size=11, color=ft.Colors.WHITE),
                    bgcolor=status_color,
                    padding=ft.Padding.symmetric(horizontal=8, vertical=4),
                    border_radius=10
                ),
                dense=True,
                on_click=lambda e: navigate("/history")
            )
        )

    # --- Nav Buttons ---
    nav_items = [
        (_("POS (Sales)"), ft.Icons.SHOPPING_CART, "/pos", ft.Colors.GREEN_700),
        (_("Inventory"), ft.Icons.INVENTORY, "/inventory", ft.Colors.ORANGE_700),
        (_("Customers"), ft.Icons.PEOPLE, "/customers", ft.Colors.PURPLE_700),
        (_("Lab"), ft.Icons.SCIENCE, "/lab", ft.Colors.BLUE_700),
        (_("History"), ft.Icons.HISTORY, "/history", ft.Colors.TEAL_700),
        (_("Reports"), ft.Icons.BAR_CHART, "/reports", ft.Colors.INDIGO_700),
        (_("Staff"), ft.Icons.BADGE, "/staff", ft.Colors.BROWN_700),
        (_("Settings"), ft.Icons.SETTINGS, "/settings", ft.Colors.GREY_700),
    ]

    nav_buttons = ft.ResponsiveRow([
        ft.Container(
            ft.ElevatedButton(
                text=label,
                icon=icon,
                on_click=lambda e, r=route: navigate(r),
                height=70,
                style=ft.ButtonStyle(
                    shape=ft.RoundedRectangleBorder(radius=10),
                    bgcolor=color,
                    color=ft.Colors.WHITE
                )
            ),
            col={"xs": 6, "sm": 4, "md": 3}
        )
        for label, icon, route, color in nav_items
    ], spacing=10, run_spacing=10)

    # --- Build View ---
    return ft.View(
        "/",
        [
            ft.AppBar(
                title=ft.Text("Lensy POS - Dashboard"),
                bgcolor=ft.Colors.BLUE_700,
                color=ft.Colors.WHITE,
                actions=[
                    ft.Container(
                        ft.Text(f"{_('Welcome')}, {user_name}", color=ft.Colors.WHITE),
                        padding=ft.Padding.only(right=10)
                    ),
                    ft.IconButton(ft.Icons.LOGOUT, icon_color=ft.Colors.WHITE, tooltip=_("Logout"), on_click=logout)
                ]
            ),
            ft.Container(
                content=ft.Column([
                    # Stats Cards Row
                    ft.Text(_("Overview"), size=20, weight=ft.FontWeight.BOLD),
                    ft.ResponsiveRow([
                        stat_card(_("Revenue"), f"{stats['revenue']:.0f}", ft.Icons.ATTACH_MONEY, ft.Colors.GREEN_700, "/reports"),
                        stat_card(_("Orders"), stats["orders"], ft.Icons.SHOPPING_BAG, ft.Colors.BLUE_700, "/history"),
                        stat_card(_("Customers"), stats["customers"], ft.Icons.PEOPLE, ft.Colors.PURPLE_700, "/customers"),
                        stat_card(_("Products"), stats["products"], ft.Icons.INVENTORY_2, ft.Colors.ORANGE_700, "/inventory"),
                        stat_card(_("Pending Lab"), stats["pending"], ft.Icons.HOURGLASS_EMPTY, ft.Colors.RED_700, "/lab"),
                        stat_card(_("Balance Due"), f"{stats['balance']:.0f}", ft.Icons.MONEY_OFF, ft.Colors.AMBER_700, "/history"),
                    ], spacing=10, run_spacing=10),

                    ft.Divider(height=20),

                    # Quick Actions
                    ft.Text(_("Quick Actions"), size=20, weight=ft.FontWeight.BOLD),
                    nav_buttons,

                    ft.Divider(height=20),

                    # Recent Orders
                    ft.Text(_("Recent Orders"), size=20, weight=ft.FontWeight.BOLD),
                    ft.Container(
                        content=ft.Column(recent_orders_controls, spacing=0) if recent_orders_controls else ft.Container(
                            ft.Text(_("No recent orders yet. Start by creating a sale!"), italic=True, color=ft.Colors.GREY_500),
                            padding=20
                        ),
                        border=ft.Border.all(1, ft.Colors.GREY_300),
                        border_radius=10,
                        padding=5
                    )
                ], spacing=15, scroll=ft.ScrollMode.AUTO, expand=True),
                padding=20,
                expand=True
            )
        ],
        scroll=ft.ScrollMode.AUTO
    )
