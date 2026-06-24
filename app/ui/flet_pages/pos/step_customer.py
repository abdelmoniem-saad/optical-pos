"""Step 1 — customer selection (search-as-you-type, pick existing, or create new)."""

import flet as ft

from app.core.i18n import _
from app.ui.components.feedback import show_error, show_success
from app.ui.components.ui_tokens import (
    BORDER,
    BRAND_PRIMARY,
    BRAND_PRIMARY_BG,
    BUTTON_HEIGHT,
    INPUT_HEIGHT,
    ON_PRIMARY,
    SPACE_MD,
    SUCCESS,
    SURFACE,
    TEXT_FAINT,
    TEXT_MUTED,
    TITLE_SIZE,
    WARNING,
)


def build_customer_step(controller):
    """Render Step 1 (customer selection)."""
    controller.current_step = 1
    page = controller._page

    controller.c_name = ft.TextField(label=_("Name") + " *", expand=True, autofocus=True, height=INPUT_HEIGHT, text_size=15)
    controller.c_phone = ft.TextField(label=_("Mobile Phone"), expand=True, height=INPUT_HEIGHT, text_size=15)
    controller.c_phone2 = ft.TextField(label=_("Second Number"), expand=True, height=INPUT_HEIGHT, text_size=15)
    controller.c_city = ft.TextField(label=_("City Name"), expand=True, height=INPUT_HEIGHT, text_size=15)
    controller.c_email = ft.TextField(label=_("Email"), expand=True, height=INPUT_HEIGHT, text_size=15)
    controller.c_address = ft.TextField(label=_("Address"), expand=True, height=INPUT_HEIGHT, text_size=15)

    def on_field_change(_e):
        perform_customer_search(controller)

    for field in (controller.c_name, controller.c_phone, controller.c_phone2, controller.c_city):
        field.on_change = on_field_change

    controller.customer_results = ft.ListView(expand=True, spacing=5)

    nav_buttons = ft.Container(
        content=ft.Row([
            ft.ElevatedButton(_("← Back"), icon=ft.icons.ARROW_BACK, height=BUTTON_HEIGHT, on_click=lambda _: controller.show_step_0()),
            ft.ElevatedButton(
                _("Walk-in (No Customer) →"),
                icon=ft.icons.PERSON_OFF,
                height=BUTTON_HEIGHT,
                bgcolor=WARNING,
                color=ON_PRIMARY,
                on_click=lambda _: controller.go_to_next_step(None),
            ),
            ft.ElevatedButton(
                _("Continue with Customer →"),
                icon=ft.icons.ARROW_FORWARD,
                height=BUTTON_HEIGHT,
                bgcolor=SUCCESS,
                color=ON_PRIMARY,
                on_click=lambda _: validate_and_proceed_customer(controller),
            ),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        padding=ft.padding.only(top=10),
        bgcolor=SURFACE,
        border_radius=12,
    )

    controller.content_area.content = ft.Column([
        ft.Text(_("Step 1: Customer Selection"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
        ft.Text(_("Enter customer information or select from search results below."), color=TEXT_MUTED),
        ft.Divider(height=SPACE_MD),

        ft.ResponsiveRow([
            ft.Container(controller.c_name, col={"xs": 12, "md": 6}),
            ft.Container(controller.c_phone, col={"xs": 12, "md": 6}),
            ft.Container(controller.c_phone2, col={"xs": 12, "md": 6}),
            ft.Container(controller.c_city, col={"xs": 12, "md": 6}),
        ]),

        ft.Text(_("Matching Customers:"), size=14, weight=ft.FontWeight.BOLD),
        ft.Container(
            content=controller.customer_results,
            border=ft.border.all(1, BORDER),
            border_radius=12,
            padding=8,
            height=240,
        ),
        nav_buttons,
    ], spacing=SPACE_MD, expand=True)

    controller.customer_results.controls.append(
        ft.Container(
            ft.Text(_("Start typing to search for existing customers..."), italic=True, color=TEXT_FAINT),
            padding=20,
        )
    )
    page.update()


def perform_customer_search(controller):
    """Search customers by name/phone/city; populate the results list."""
    page = controller._page
    controller.customer_results.controls.clear()

    terms = []
    for field in (controller.c_name, controller.c_phone, controller.c_city):
        if field.value and field.value.strip():
            terms.append(field.value.strip())

    if not terms:
        controller.customer_results.controls.append(
            ft.Container(
                ft.Text(_("Start typing to search for existing customers..."), italic=True, color=TEXT_FAINT),
                padding=20,
            )
        )
        page.update()
        return

    customers = controller.repo.search_customers(" ".join(terms))

    seen_ids = set()
    unique_customers = []
    for c in customers:
        cid = c.get("id")
        if cid and cid not in seen_ids:
            seen_ids.add(cid)
            unique_customers.append(c)
    customers = unique_customers[:10]

    if not customers:
        controller.customer_results.controls.append(
            ft.Container(
                ft.Column([
                    ft.Icon(ft.icons.PERSON_ADD, size=40, color=TEXT_FAINT),
                    ft.Text(_("No matching customers found."), color=TEXT_MUTED),
                    ft.Text(_("A new customer will be created when you continue."), italic=True, size=12, color=TEXT_FAINT),
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=5),
                padding=20,
            )
        )
    else:
        for c in customers:
            controller.customer_results.controls.append(
                ft.ListTile(
                    leading=ft.Icon(ft.icons.PERSON, color=BRAND_PRIMARY),
                    title=ft.Text(c.get("name", _("Unknown")), weight=ft.FontWeight.BOLD),
                    subtitle=ft.Text(f"📱 {c.get('phone', 'N/A')} | 📍 {c.get('city', 'N/A')}"),
                    trailing=ft.Icon(ft.icons.TOUCH_APP, color=SUCCESS),
                    on_click=lambda e, cust=c: select_existing_customer(controller, cust),
                    bgcolor=BRAND_PRIMARY_BG,
                )
            )
    page.update()


def select_existing_customer(controller, customer):
    """User clicked an existing customer in the results list."""
    page = controller._page
    controller.c_name.value = customer.get("name", "")
    controller.c_phone.value = customer.get("phone", "")
    controller.c_phone2.value = customer.get("phone2", "")
    controller.c_city.value = customer.get("city", "")
    controller.c_email.value = customer.get("email", "")
    controller.c_address.value = customer.get("address", "")
    controller.selected_customer = customer
    page.update()
    show_success(page, f"✓ {_('Selected')}: {customer.get('name')}")


def validate_and_proceed_customer(controller):
    """Validate the form and proceed; creates a new customer if necessary."""
    page = controller._page
    name = controller.c_name.value.strip() if controller.c_name.value else ""
    if not name:
        show_error(page, _("Please enter customer name."))
        return

    if not controller.selected_customer or controller.selected_customer.get("name") != name:
        customer_data = {
            "name": name,
            "phone": controller.c_phone.value.strip() if controller.c_phone.value else "",
            "phone2": controller.c_phone2.value.strip() if controller.c_phone2.value else "",
            "city": controller.c_city.value.strip() if controller.c_city.value else "",
            "email": controller.c_email.value.strip() if controller.c_email.value else "",
            "address": controller.c_address.value.strip() if controller.c_address.value else "",
        }
        controller.selected_customer = controller.repo.add_customer(customer_data)

    controller.go_to_next_step(controller.selected_customer)
