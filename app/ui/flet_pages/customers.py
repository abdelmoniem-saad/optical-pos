import flet as ft
from app.core.i18n import _
from app.ui.components.design_helpers import (
    build_dialog,
    danger_button,
    open_dialog,
    primary_button,
    refresh_action,
    secondary_button,
    standard_appbar,
)
from app.ui.components.feedback import show_error, show_success
from app.ui.components.ui_sync import UIEventTopic, publish_ui_event
from app.ui.components.ui_tokens import INPUT_HEIGHT, SPACE_LG, SPACE_MD, TITLE_SIZE

def CustomersView(page: ft.Page, repo):
    cust_list = ft.ListView(expand=True, spacing=SPACE_MD)
    summary_text = ft.Text("", color=ft.colors.GREY_700)

    balance_filter = ft.Dropdown(
        label=_("Balance"),
        value="All",
        width=190,
        options=[
            ft.dropdown.Option("All", _("All Customers")),
            ft.dropdown.Option("WithBalance", _("With Balance")),
            ft.dropdown.Option("NoBalance", _("No Balance")),
        ],
    )

    def load_customers(term=""):
        cust_list.controls.clear()
        customers = repo.get_customers()
        sales = repo.get_sales()

        sales_stats = {}
        for s in sales:
            cid = s.get("customer_id")
            if not cid:
                continue
            stat = sales_stats.setdefault(cid, {"orders": 0, "spent": 0.0, "balance": 0.0})
            net = float(s.get("net_amount", 0) or 0)
            paid = float(s.get("amount_paid", 0) or 0)
            stat["orders"] += 1
            stat["spent"] += net
            stat["balance"] += net - paid

        if term:
            term = term.lower()
            customers = [c for c in customers if
                term in c.get("name", "").lower() or
                term in (c.get("phone") or "").lower() or
                term in (c.get("city") or "").lower() or
                term in (c.get("email") or "").lower()]

        if balance_filter.value == "WithBalance":
            customers = [c for c in customers if sales_stats.get(c.get("id"), {}).get("balance", 0) > 0]
        elif balance_filter.value == "NoBalance":
            customers = [c for c in customers if sales_stats.get(c.get("id"), {}).get("balance", 0) <= 0]

        total_balance = sum(sales_stats.get(c.get("id"), {}).get("balance", 0.0) for c in customers)
        summary_text.value = f"{_('Customers')}: {len(customers)} | {_('Total Balance')}: {total_balance:.2f}"

        if not customers:
            cust_list.controls.append(
                ft.ListTile(title=ft.Text(_("No customers found"), italic=True, color=ft.colors.GREY_700))
            )
        else:
            for c in customers:
                # Count orders for this customer
                customer_stat = sales_stats.get(c.get("id"), {"orders": 0, "spent": 0.0, "balance": 0.0})
                order_count = customer_stat["orders"]
                total_spent = customer_stat["spent"]
                balance = customer_stat["balance"]

                balance_color = ft.colors.RED_700 if balance > 0 else ft.colors.GREEN_700

                cust_list.controls.append(
                    ft.Card(
                        content=ft.Container(
                            content=ft.Column([
                                ft.ListTile(
                                    leading=ft.Icon(ft.icons.PERSON, size=40),
                                    title=ft.Text(c.get("name", "Unknown"), weight=ft.FontWeight.BOLD, size=16),
                                    subtitle=ft.Text(f"📱 {c.get('phone', 'N/A')} | 📍 {c.get('city', 'N/A')}", size=13),
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
                            padding=14
                        )
                    )
                )
        page.update()

    def show_customer_dialog(cust=None):
        def save_customer(e):
            if not name_field.value:
                show_error(page, _("Name is required"))
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
                msg = _("Customer updated successfully")
            else:
                repo.add_customer(data)
                msg = _("Customer added successfully")

            dialog.open = False
            publish_ui_event(page, UIEventTopic.CUSTOMERS)
            load_customers(search_input.value)
            show_success(page, msg)

        name_field = ft.TextField(label=_("Name") + " *", value=cust.get("name", "") if cust else "", autofocus=True)
        phone_field = ft.TextField(label=_("Mobile Phone"), value=cust.get("phone", "") if cust else "")
        phone2_field = ft.TextField(label=_("Second Number"), value=cust.get("phone2", "") if cust else "")
        city_field = ft.TextField(label=_("City Name"), value=cust.get("city", "") if cust else "")
        email_field = ft.TextField(label=_("Email"), value=cust.get("email", "") if cust else "")
        addr_field = ft.TextField(label=_("Address"), value=cust.get("address", "") if cust else "", multiline=True, min_lines=2)

        dialog = build_dialog(
            _("Edit Customer") if cust else _("New Customer"),
            ft.Container(
                ft.Column([name_field, phone_field, phone2_field, city_field, email_field, addr_field], tight=True, spacing=10),
                width=400,
            ),
            [],
        )
        dialog.actions = [
            secondary_button(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
            primary_button(_("Save"), on_click=save_customer),
        ]
        open_dialog(page, dialog)

    def confirm_delete_customer(cust):
        """Show confirmation dialog before deleting a customer."""
        # Check if customer has orders
        sales = repo.get_sales()
        customer_orders = [s for s in sales if s.get("customer_id") == cust.get("id")]

        if customer_orders:
            dialog = build_dialog(
                _("Cannot Delete Customer"),
                ft.Column([
                    ft.Icon(ft.icons.WARNING, color=ft.colors.ORANGE_700, size=50),
                    ft.Text(f"\"{cust.get('name', '')}\" {_('has')} {len(customer_orders)} {_('order(s)')}."),
                    ft.Text(_("Delete or reassign the orders first."), color=ft.colors.ORANGE_700, size=12),
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
                [],
            )
            dialog.actions = [secondary_button(_("OK"), on_click=lambda e: setattr(dialog, "open", False) or page.update())]
            open_dialog(page, dialog)
            return

        def do_delete(e):
            repo.delete_customer(cust["id"])
            dialog.open = False
            publish_ui_event(page, UIEventTopic.CUSTOMERS)
            load_customers(search_input.value)
            show_success(page, _("Customer deleted successfully"))

        dialog = build_dialog(
            _("Delete Customer"),
            ft.Column([
                ft.Icon(ft.icons.WARNING, color=ft.colors.RED_700, size=50),
                ft.Text(f"{_('Are you sure you want to delete')} \"{cust.get('name', '')}\"?"),
                ft.Text(_("This action cannot be undone."), color=ft.colors.RED_700, size=12),
            ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
            [],
        )
        dialog.actions = [
            secondary_button(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
            danger_button(_("Delete"), on_click=do_delete),
        ]
        open_dialog(page, dialog)

    search_input = ft.TextField(
        label=_("Search by name, phone, city or email..."),
        prefix_icon=ft.icons.SEARCH,
        height=INPUT_HEIGHT,
        text_size=15,
        expand=True,
        on_change=lambda e: load_customers(e.control.value)
    )
    balance_filter.on_change = lambda e: load_customers(search_input.value)

    load_customers()

    return ft.View(
        "/customers",
        [
            standard_appbar(_("Customer Management"), on_back=lambda _: page.go("/")),
            ft.Container(
                content=ft.Column([
                    ft.Row([
                        ft.Text(_("Customers"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
                        ft.Row([
                            refresh_action(on_click=lambda _: load_customers(search_input.value), tooltip=_("Refresh")),
                            primary_button(_("+ Add Customer"), on_click=lambda _: show_customer_dialog(), icon=ft.icons.PERSON_ADD),
                        ]),
                    ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
                    ft.Row([search_input, balance_filter]),
                    summary_text,
                    ft.Divider(height=SPACE_LG),
                    cust_list,
                ], expand=True, spacing=SPACE_MD),
                padding=24,
                expand=True,
            )
        ],
    )






