import flet as ft
from app.core.i18n import _

def CustomersView(page: ft.Page, repo):
    cust_list = ft.ListView(expand=True, spacing=5)

    def load_customers(term=""):
        cust_list.controls.clear()
        customers = repo.get_customers()
        sales = repo.get_sales()

        if term:
            term = term.lower()
            customers = [c for c in customers if
                term in c.get("name", "").lower() or
                term in (c.get("phone") or "").lower() or
                term in (c.get("city") or "").lower() or
                term in (c.get("email") or "").lower()]

        if not customers:
            cust_list.controls.append(
                ft.ListTile(title=ft.Text(_("No customers found"), italic=True, color=ft.colors.GREY_700))
            )
        else:
            for c in customers:
                # Count orders for this customer
                order_count = len([s for s in sales if s.get("customer_id") == c.get("id")])
                total_spent = sum(float(s.get("net_amount", 0)) for s in sales if s.get("customer_id") == c.get("id"))
                balance = sum(float(s.get("net_amount", 0)) - float(s.get("amount_paid", 0)) for s in sales if s.get("customer_id") == c.get("id"))

                balance_color = ft.colors.RED_700 if balance > 0 else ft.colors.GREEN_700

                cust_list.controls.append(
                    ft.Card(
                        content=ft.Container(
                            content=ft.Column([
                                ft.ListTile(
                                    leading=ft.Icon(ft.icons.PERSON, size=40),
                                    title=ft.Text(c.get("name", "Unknown"), weight=ft.FontWeight.BOLD),
                                    subtitle=ft.Text(f"📱 {c.get('phone', 'N/A')} | 📍 {c.get('city', 'N/A')}"),
                                    trailing=ft.PopupMenuButton(
                                        items=[
                                            ft.PopupMenuItem(text=_("View Prescriptions"), icon=ft.icons.ASSIGNMENT, on_click=lambda e, cid=c["id"]: page.go(f"/prescription/{cid}")),
                                            ft.PopupMenuItem(text=_("Edit"), icon=ft.icons.EDIT, on_click=lambda e, cust=c: show_customer_dialog(cust)),
                                            ft.PopupMenuItem(text=_("New Order"), icon=ft.icons.SHOPPING_CART, on_click=lambda e: page.go("/pos")),
                                            ft.PopupMenuItem(),  # Divider
                                            ft.PopupMenuItem(text=_("Delete"), icon=ft.icons.DELETE, on_click=lambda e, cust=c: confirm_delete_customer(cust)),
                                        ]
                                    )
                                ),
                                ft.Row([
                                    ft.Container(
                                        ft.Column([
                                            ft.Text(str(order_count), size=18, weight=ft.FontWeight.BOLD),
                                            ft.Text(_("Orders"), size=10)
                                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                        expand=True
                                    ),
                                    ft.Container(
                                        ft.Column([
                                            ft.Text(f"{total_spent:.0f}", size=18, weight=ft.FontWeight.BOLD),
                                            ft.Text(_("Total Spent"), size=10)
                                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                        expand=True
                                    ),
                                    ft.Container(
                                        ft.Column([
                                            ft.Text(f"{balance:.0f}", size=18, weight=ft.FontWeight.BOLD, color=balance_color),
                                            ft.Text(_("Balance"), size=10)
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

    def show_customer_dialog(cust=None):
        def save_customer(e):
            if not name_field.value:
                page.snack_bar = ft.SnackBar(ft.Text(_("Name is required")))
                page.snack_bar.open = True
                page.update()
                return

            data = {
                "name": name_field.value,
                "phone": phone_field.value,
                "phone2": phone2_field.value,
                "city": city_field.value,
                "email": email_field.value,
                "address": addr_field.value,
            }
            if cust:
                repo.update_customer(cust["id"], data)
                page.snack_bar = ft.SnackBar(ft.Text(_("Customer updated successfully")))
            else:
                repo.add_customer(data)
                page.snack_bar = ft.SnackBar(ft.Text(_("Customer added successfully")))

            dialog.open = False
            page.snack_bar.open = True
            load_customers(search_input.value)
            page.update()

        name_field = ft.TextField(label=_("Name") + " *", value=cust.get("name", "") if cust else "", autofocus=True)
        phone_field = ft.TextField(label=_("Mobile Phone"), value=cust.get("phone", "") if cust else "")
        phone2_field = ft.TextField(label=_("Second Number"), value=cust.get("phone2", "") if cust else "")
        city_field = ft.TextField(label=_("City Name"), value=cust.get("city", "") if cust else "")
        email_field = ft.TextField(label=_("Email"), value=cust.get("email", "") if cust else "")
        addr_field = ft.TextField(label=_("Address"), value=cust.get("address", "") if cust else "", multiline=True, min_lines=2)

        dialog = ft.AlertDialog(
            title=ft.Text(_("Edit Customer") if cust else _("New Customer")),
            content=ft.Container(
                ft.Column([name_field, phone_field, phone2_field, city_field, email_field, addr_field], tight=True, spacing=10),
                width=400
            ),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(_("Save"), on_click=save_customer),
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    def confirm_delete_customer(cust):
        """Show confirmation dialog before deleting a customer."""
        def do_delete(e):
            repo.delete_customer(cust["id"])
            dialog.open = False
            page.snack_bar = ft.SnackBar(ft.Text(_("Customer deleted successfully")))
            page.snack_bar.open = True
            load_customers(search_input.value)
            page.update()

        dialog = ft.AlertDialog(
            title=ft.Text(_("Delete Customer")),
            content=ft.Column([
                ft.Icon(ft.icons.WARNING, color=ft.colors.RED_700, size=50),
                ft.Text(f"{_('Are you sure you want to delete')} \"{cust.get('name', '')}\"?"),
                ft.Text(_("This action cannot be undone."), color=ft.colors.RED_700, size=12),
            ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(
                    _("Delete"),
                    bgcolor=ft.colors.RED_700,
                    color=ft.colors.WHITE,
                    on_click=do_delete
                ),
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    search_input = ft.TextField(
        label=_("Search by name, phone, city or email..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_change=lambda e: load_customers(e.control.value)
    )

    load_customers()

    return ft.View(
        "/customers",
        [
            ft.AppBar(
                title=ft.Text(_("Customer Management")),
                bgcolor=ft.colors.BLUE_700,
                color=ft.colors.WHITE,
                leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(
                content=ft.Column([
                    ft.Row([
                        ft.Text(_("Customers"), size=25, weight=ft.FontWeight.BOLD),
                        ft.ElevatedButton(_("+ Add Customer"), icon=ft.icons.PERSON_ADD, on_click=lambda _: show_customer_dialog()),
                    ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                    search_input,
                    cust_list,
                ], expand=True),
                padding=20,
                expand=True,
            )
        ],
    )

