import flet as ft
from app.core.i18n import _

def HistoryView(page: ft.Page, repo):
    items_list = ft.ListView(expand=True, spacing=5)

    # Filter controls
    status_filter = ft.Dropdown(
        label=_("Status"),
        value="All",
        options=[
            ft.dropdown.Option("All", _("All")),
            ft.dropdown.Option("Not Started", _("Not Started")),
            ft.dropdown.Option("In Lab", _("In Lab")),
            ft.dropdown.Option("Ready", _("Ready")),
            ft.dropdown.Option("Received", _("Received")),
        ],
        width=150,
        on_change=lambda e: load_history(search_input.value)
    )

    payment_filter = ft.Dropdown(
        label=_("Payment"),
        value="All",
        options=[
            ft.dropdown.Option("All", _("All")),
            ft.dropdown.Option("Paid", _("Fully Paid")),
            ft.dropdown.Option("Partial", _("Partial")),
            ft.dropdown.Option("Unpaid", _("Unpaid")),
        ],
        width=150,
        on_change=lambda e: load_history(search_input.value)
    )

    def load_history(term=""):
        items_list.controls.clear()
        sales = repo.get_sales()
        customers = repo.get_customers()
        
        # Apply filters
        filtered_sales = sales

        # Text search
        if term:
            term = term.lower()
            filtered = []
            for s in filtered_sales:
                cust_name = ""
                if s.get("customer_id"):
                    cust = next((c for c in customers if c["id"] == s["customer_id"]), None)
                    if cust: cust_name = cust.get("name", "")

                if (term in s.get("invoice_no", "").lower() or
                    term in cust_name.lower() or
                    term in (s.get("doctor_name") or "").lower()):
                    filtered.append(s)
            filtered_sales = filtered

        # Status filter
        if status_filter.value != "All":
            filtered_sales = [s for s in filtered_sales if s.get("lab_status") == status_filter.value]

        # Payment filter
        if payment_filter.value != "All":
            if payment_filter.value == "Paid":
                filtered_sales = [s for s in filtered_sales if float(s.get("amount_paid", 0)) >= float(s.get("net_amount", 0))]
            elif payment_filter.value == "Partial":
                filtered_sales = [s for s in filtered_sales if 0 < float(s.get("amount_paid", 0)) < float(s.get("net_amount", 0))]
            elif payment_filter.value == "Unpaid":
                filtered_sales = [s for s in filtered_sales if float(s.get("amount_paid", 0)) == 0]

        if not filtered_sales:
            items_list.controls.append(
                ft.ListTile(title=ft.Text(_("No orders found"), italic=True, color=ft.Colors.GREY_700))
            )
        else:
            for s in sorted(filtered_sales, key=lambda x: x.get("order_date", ""), reverse=True):
                cust_name = _("Walk-in")
                if s.get("customer_id"):
                    cust = next((c for c in customers if c["id"] == s["customer_id"]), None)
                    if cust: cust_name = cust.get("name", "")

                net_amount = float(s.get('net_amount', 0))
                paid = float(s.get('amount_paid', 0))
                balance = net_amount - paid

                # Status colors
                status = s.get('lab_status', 'N/A')
                status_color = ft.Colors.GREY_500
                if status == "Ready": status_color = ft.Colors.GREEN_500
                elif status == "In Lab": status_color = ft.Colors.ORANGE_500
                elif status == "Not Started": status_color = ft.Colors.RED_500
                elif status == "Received": status_color = ft.Colors.BLUE_500

                # Payment indicator
                payment_color = ft.Colors.GREEN_700 if balance <= 0 else ft.Colors.RED_700

                items_list.controls.append(
                    ft.Card(
                        content=ft.Container(
                            content=ft.Column([
                                ft.ListTile(
                                    leading=ft.Icon(ft.icons.RECEIPT, color=status_color, size=35),
                                    title=ft.Text(f"#{s['invoice_no']} - {cust_name}", weight=ft.FontWeight.BOLD),
                                    subtitle=ft.Text(f"{s.get('order_date', '')[:16]} | {_('Doctor')}: {s.get('doctor_name', 'N/A')}"),
                                    trailing=ft.PopupMenuButton(
                                        items=[
                                            ft.PopupMenuItem(text=_("View Details"), icon=ft.icons.VISIBILITY, on_click=lambda e, sale=s: show_sale_details(sale)),
                                            ft.PopupMenuItem(text=_("Record Payment"), icon=ft.icons.PAYMENT, on_click=lambda e, sale=s: show_payment_dialog(sale)),
                                            ft.PopupMenuItem(text=_("Print"), icon=ft.icons.PRINT, on_click=lambda e, sale=s: print_receipt(sale)),
                                        ]
                                    )
                                ),
                                ft.Row([
                                    ft.Container(
                                        ft.Column([
                                            ft.Text(f"{net_amount:.2f}", size=16, weight=ft.FontWeight.BOLD),
                                            ft.Text(_("Total"), size=10)
                                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                        expand=True
                                    ),
                                    ft.Container(
                                        ft.Column([
                                            ft.Text(f"{paid:.2f}", size=16, weight=ft.FontWeight.BOLD, color=ft.Colors.GREEN_700),
                                            ft.Text(_("Paid"), size=10)
                                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                        expand=True
                                    ),
                                    ft.Container(
                                        ft.Column([
                                            ft.Text(f"{balance:.2f}", size=16, weight=ft.FontWeight.BOLD, color=payment_color),
                                            ft.Text(_("Balance"), size=10)
                                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                        expand=True
                                    ),
                                    ft.Container(
                                        ft.Column([
                                            ft.Container(
                                                ft.Text(status, size=12, color=ft.Colors.WHITE),
                                                bgcolor=status_color,
                                                padding=ft.padding.symmetric(horizontal=10, vertical=5),
                                                border_radius=15
                                            )
                                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                        expand=True
                                    ),
                                ], alignment=ft.MainAxisAlignment.SPACE_AROUND),
                            ]),
                            padding=10
                        )
                    )
                )
        page.update()

    def show_sale_details(sale):
        """Show sale details in a dialog."""
        customers = repo.get_customers()
        cust_name = _("Walk-in")
        if sale.get("customer_id"):
            cust = next((c for c in customers if c["id"] == sale["customer_id"]), None)
            if cust: cust_name = cust.get("name", "")

        # Get sale items
        sale_items = sale.get("sale_items", [])

        items_col = ft.Column([], spacing=5)
        for item in sale_items:
            items_col.controls.append(
                ft.Row([
                    ft.Text(item.get("name", f"Product {item.get('product_id', '')}"), expand=True),
                    ft.Text(f"x{item.get('qty', 0)}"),
                    ft.Text(f"{item.get('total_price', 0):.2f}")
                ])
            )

        if not sale_items:
            items_col.controls.append(ft.Text(_("No items"), italic=True))

        dialog = ft.AlertDialog(
            title=ft.Text(f"{_('Invoice')} #{sale.get('invoice_no', '')}"),
            content=ft.Container(
                ft.Column([
                    ft.Text(f"{_('Customer')}: {cust_name}", weight=ft.FontWeight.BOLD),
                    ft.Text(f"{_('Date')}: {sale.get('order_date', '')[:16]}"),
                    ft.Text(f"{_('Doctor')}: {sale.get('doctor_name', 'N/A')}"),
                    ft.Divider(),
                    ft.Text(_("Items:"), weight=ft.FontWeight.BOLD),
                    items_col,
                    ft.Divider(),
                    ft.Row([ft.Text(_("Total")), ft.Text(f"{sale.get('net_amount', 0):.2f}", weight=ft.FontWeight.BOLD)], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                    ft.Row([ft.Text(_("Paid")), ft.Text(f"{sale.get('amount_paid', 0):.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                    ft.Row([ft.Text(_("Balance")), ft.Text(f"{float(sale.get('net_amount', 0)) - float(sale.get('amount_paid', 0)):.2f}", color=ft.Colors.RED_700 if float(sale.get('net_amount', 0)) > float(sale.get('amount_paid', 0)) else ft.Colors.GREEN_700)], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                ], spacing=5),
                width=400
            ),
            actions=[ft.TextButton(_("Close"), on_click=lambda e: setattr(dialog, "open", False) or page.update())]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    def show_payment_dialog(sale):
        """Dialog to record additional payment."""
        current_paid = float(sale.get('amount_paid', 0))
        total = float(sale.get('net_amount', 0))
        remaining = total - current_paid

        def record_payment(e):
            try:
                new_payment = float(payment_field.value or 0)
                if new_payment <= 0:
                    return

                new_total_paid = current_paid + new_payment
                repo.update_sale_payment(sale["id"], new_total_paid)

                dialog.open = False
                page.snack_bar = ft.SnackBar(ft.Text(_("Payment recorded successfully")))
                page.snack_bar.open = True
                load_history(search_input.value)
                page.update()
            except Exception as ex:
                page.snack_bar = ft.SnackBar(ft.Text(f"{_('Error')}: {str(ex)}"))
                page.snack_bar.open = True
                page.update()

        payment_field = ft.TextField(
            label=_("Amount"),
            value=str(remaining) if remaining > 0 else "0",
            autofocus=True
        )

        dialog = ft.AlertDialog(
            title=ft.Text(_("Record Payment")),
            content=ft.Column([
                ft.Text(f"{_('Invoice')}: #{sale.get('invoice_no', '')}"),
                ft.Text(f"{_('Total')}: {total:.2f}"),
                ft.Text(f"{_('Already Paid')}: {current_paid:.2f}"),
                ft.Text(f"{_('Remaining')}: {remaining:.2f}", color=ft.Colors.RED_700 if remaining > 0 else ft.Colors.GREEN_700),
                ft.Divider(),
                payment_field
            ], tight=True, spacing=10),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(_("Record Payment"), on_click=record_payment)
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    def print_receipt(sale):
        """Print receipt for a sale."""
        customers = repo.get_customers()
        cust_name = _("Walk-in")
        if sale.get("customer_id"):
            cust = next((c for c in customers if c["id"] == sale["customer_id"]), None)
            if cust: cust_name = cust.get("name", "")

        shop_name = repo.get_setting("shop_name", "Optical Shop")

        receipt = f"""
{'='*40}
{shop_name}
{'='*40}
{_('Invoice')}: #{sale.get('invoice_no', '')}
{_('Date')}: {sale.get('order_date', '')[:16]}
{_('Customer')}: {cust_name}
{'-'*40}
{_('Total')}: {sale.get('net_amount', 0):.2f}
{_('Paid')}: {sale.get('amount_paid', 0):.2f}
{_('Balance')}: {float(sale.get('net_amount', 0)) - float(sale.get('amount_paid', 0)):.2f}
{'='*40}
"""
        print(receipt)
        page.snack_bar = ft.SnackBar(ft.Text(_("Receipt sent to printer")))
        page.snack_bar.open = True
        page.update()

    search_input = ft.TextField(
        label=_("Search by Invoice, Customer or Doctor..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_change=lambda e: load_history(e.control.value)
    )

    load_history()

    return ft.View(
        "/history",
        [
            ft.AppBar(
                title=ft.Text(_("Sales History")),
                bgcolor=ft.Colors.BLUE_700,
                color=ft.Colors.WHITE,
                leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(
                content=ft.Column([
                    ft.Text(_("Sales History & Invoices"), size=25, weight=ft.FontWeight.BOLD),
                    ft.Row([search_input, status_filter, payment_filter]),
                    items_list,
                ], expand=True),
                padding=20,
                expand=True
            )
        ]
    )
