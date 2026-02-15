import flet as ft
from app.core.i18n import _
import datetime

def ReportsView(page: ft.Page, repo):

    # Get all data
    def get_report_data():
        sales = repo.get_sales()
        customers = repo.get_customers()
        products = repo.get_inventory()

        total_revenue = sum(float(s.get("net_amount", 0)) for s in sales)
        total_paid = sum(float(s.get("amount_paid", 0)) for s in sales)
        remaining_balance = total_revenue - total_paid

        # Today's sales
        today = datetime.date.today().isoformat()
        today_sales = [s for s in sales if s.get("order_date", "").startswith(today)]
        today_revenue = sum(float(s.get("net_amount", 0)) for s in today_sales)

        # This month's sales
        month_start = datetime.date.today().replace(day=1).isoformat()
        month_sales = [s for s in sales if s.get("order_date", "") >= month_start]
        month_revenue = sum(float(s.get("net_amount", 0)) for s in month_sales)

        # Lab stats
        lab_sales = [s for s in sales if s.get("lab_status")]
        pending_lab = len([s for s in lab_sales if s.get("lab_status") in ["Not Started", "In Lab"]])
        ready_lab = len([s for s in lab_sales if s.get("lab_status") == "Ready"])

        # Low stock products (less than 5)
        low_stock = [p for p in products if p.get("stock_qty", 0) < 5]

        # Top customers by total spent
        customer_totals = {}
        for s in sales:
            cid = s.get("customer_id")
            if cid:
                customer_totals[cid] = customer_totals.get(cid, 0) + float(s.get("net_amount", 0))

        top_customers = sorted(customer_totals.items(), key=lambda x: x[1], reverse=True)[:5]
        top_customer_data = []
        for cid, total in top_customers:
            cust = next((c for c in customers if c.get("id") == cid), None)
            if cust:
                top_customer_data.append({"name": cust.get("name", ""), "total": total})

        return {
            "total_revenue": total_revenue,
            "total_paid": total_paid,
            "remaining_balance": remaining_balance,
            "order_count": len(sales),
            "customer_count": len(customers),
            "product_count": len(products),
            "today_revenue": today_revenue,
            "today_orders": len(today_sales),
            "month_revenue": month_revenue,
            "month_orders": len(month_sales),
            "pending_lab": pending_lab,
            "ready_lab": ready_lab,
            "low_stock": low_stock,
            "top_customers": top_customer_data
        }

    data = get_report_data()

    def stat_card(title, value, subtitle="", icon=ft.icons.INFO, color=ft.colors.BLUE_700):
        return ft.Card(
            content=ft.Container(
                ft.Column([
                    ft.ListTile(
                        leading=ft.Icon(icon, color=color, size=40),
                        title=ft.Text(str(value), size=28, weight=ft.FontWeight.BOLD),
                        subtitle=ft.Text(title, size=14),
                    ),
                    ft.Text(subtitle, size=12, color=ft.colors.GREY_700) if subtitle else ft.Container()
                ]),
                padding=10
            ),
            col={"xs": 12, "sm": 6, "md": 4, "lg": 3}
        )

    # Summary stats row
    summary_cards = ft.ResponsiveRow([
        stat_card(_("Total Revenue"), f"{data['total_revenue']:.0f}", icon=ft.icons.ATTACH_MONEY, color=ft.colors.GREEN_700),
        stat_card(_("Total Paid"), f"{data['total_paid']:.0f}", icon=ft.icons.PAYMENTS, color=ft.colors.TEAL_700),
        stat_card(_("Balance Due"), f"{data['remaining_balance']:.0f}", icon=ft.icons.MONEY_OFF, color=ft.colors.RED_700 if data['remaining_balance'] > 0 else ft.colors.GREEN_700),
        stat_card(_("Total Orders"), data['order_count'], icon=ft.icons.SHOPPING_BAG, color=ft.colors.BLUE_700),
        stat_card(_("Today's Revenue"), f"{data['today_revenue']:.0f}", f"{data['today_orders']} orders", ft.icons.TODAY, ft.colors.ORANGE_700),
        stat_card(_("This Month"), f"{data['month_revenue']:.0f}", f"{data['month_orders']} orders", ft.icons.CALENDAR_MONTH, ft.colors.PURPLE_700),
        stat_card(_("Pending Lab"), data['pending_lab'], icon=ft.icons.HOURGLASS_EMPTY, color=ft.colors.ORANGE_700),
        stat_card(_("Ready for Pickup"), data['ready_lab'], icon=ft.icons.CHECK_CIRCLE, color=ft.colors.GREEN_700),
    ], spacing=10, run_spacing=10)

    # Low stock alert
    low_stock_list = ft.Column([], spacing=5)
    if data['low_stock']:
        for p in data['low_stock'][:10]:
            low_stock_list.controls.append(
                ft.ListTile(
                    leading=ft.Icon(ft.icons.WARNING, color=ft.colors.ORANGE_700),
                    title=ft.Text(p.get("name", ""), size=14),
                    subtitle=ft.Text(f"SKU: {p.get('sku', '')}"),
                    trailing=ft.Text(f"{p.get('stock_qty', 0)} left", color=ft.colors.RED_700, weight=ft.FontWeight.BOLD),
                    dense=True
                )
            )
    else:
        low_stock_list.controls.append(ft.Text(_("All products in stock"), color=ft.colors.GREEN_700))

    # Top customers
    top_customers_list = ft.Column([], spacing=5)
    if data['top_customers']:
        for i, c in enumerate(data['top_customers'], 1):
            top_customers_list.controls.append(
                ft.ListTile(
                    leading=ft.Container(
                        ft.Text(str(i), color=ft.colors.WHITE, weight=ft.FontWeight.BOLD),
                        bgcolor=ft.colors.BLUE_700,
                        border_radius=15,
                        width=30,
                        height=30,
                        alignment=ft.alignment.center
                    ),
                    title=ft.Text(c["name"], size=14),
                    trailing=ft.Text(f"{c['total']:.0f}", weight=ft.FontWeight.BOLD, color=ft.colors.GREEN_700),
                    dense=True
                )
            )
    else:
        top_customers_list.controls.append(ft.Text(_("No customer data"), italic=True))

    return ft.View(
        "/reports",
        [
            ft.AppBar(
                title=ft.Text(_("Reports & Analytics")),
                bgcolor=ft.colors.BLUE_700,
                color=ft.colors.WHITE,
                leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(
                content=ft.Column([
                    ft.Text(_("Business Reports"), size=28, weight=ft.FontWeight.BOLD),
                    ft.Divider(),

                    # Summary Cards
                    summary_cards,

                    ft.Divider(height=30),

                    # Two column layout for lists
                    ft.ResponsiveRow([
                        ft.Container(
                            ft.Column([
                                ft.Text(_("Low Stock Alert"), size=18, weight=ft.FontWeight.BOLD, color=ft.colors.ORANGE_700),
                                ft.Container(
                                    low_stock_list,
                                    border=ft.Border.all(1, ft.colors.ORANGE_200),
                                    border_radius=10,
                                    padding=10,
                                    bgcolor=ft.colors.ORANGE_50
                                )
                            ]),
                            col={"xs": 12, "md": 6}
                        ),
                        ft.Container(
                            ft.Column([
                                ft.Text(_("Top Customers"), size=18, weight=ft.FontWeight.BOLD, color=ft.colors.BLUE_700),
                                ft.Container(
                                    top_customers_list,
                                    border=ft.Border.all(1, ft.colors.BLUE_200),
                                    border_radius=10,
                                    padding=10,
                                    bgcolor=ft.colors.BLUE_50
                                )
                            ]),
                            col={"xs": 12, "md": 6}
                        ),
                    ], spacing=20),

                ], spacing=15, scroll=ft.ScrollMode.AUTO),
                padding=20,
                expand=True
            )
        ]
    )



