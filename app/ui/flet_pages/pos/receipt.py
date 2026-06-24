"""Receipt preview dialog — shop / customer / lab copies after order checkout."""

import datetime

import flet as ft

from app.core.i18n import _
from app.ui.components.design_helpers import build_dialog, open_dialog, primary_button
from app.ui.components.feedback import show_success
from app.ui.components.ui_tokens import (
    BORDER,
    BRAND_PRIMARY,
    ON_PRIMARY,
    SUCCESS,
    WARNING,
)


def show_receipt_preview(controller, sale_data):
    """Show the post-checkout receipt-preview dialog.

    Uses values from the controller (cart_items, examinations, totals,
    invoice_no, doctor_name, selected_customer, repo for shop settings).
    """
    page = controller._page
    repo = controller.repo

    customer_name = (
        controller.selected_customer.get("name", _("Walk-in"))
        if controller.selected_customer
        else _("Walk-in")
    )
    customer_phone = controller.selected_customer.get("phone", "") if controller.selected_customer else ""
    shop_name = repo.get_setting("shop_name", "Optical Shop")
    shop_address = repo.get_setting("store_address", "")
    shop_phone = repo.get_setting("store_phone", "")
    currency = repo.get_setting("currency", "EGP")

    def _delivery_str():
        return (
            controller.delivery_date.strftime("%d/%m/%Y")
            if hasattr(controller, "delivery_date")
            else "N/A"
        )

    def build_shop_copy():
        lines = [
            f"{'='*44}",
            f"{'نسخة المحل - SHOP COPY':^44}",
            f"{'='*44}",
            f"{shop_name:^44}",
            f"{shop_address:^44}" if shop_address else "",
            f"{shop_phone:^44}" if shop_phone else "",
            f"{'='*44}",
            f"{_('Invoice')}: #{controller.invoice_no}",
            f"{_('Date')}: {datetime.datetime.now().strftime('%d/%m/%Y %H:%M')}",
            f"{_('Delivery Date')}: {_delivery_str()}",
            f"{'-'*44}",
            f"{_('Customer')}: {customer_name}",
            f"{_('Phone')}: {customer_phone}" if customer_phone else "",
            f"{_('Doctor')}: {controller.doctor_name}" if controller.doctor_name else "",
            f"{'-'*44}",
        ]

        if controller.cart_items:
            lines.append(f"{_('Items')}:")
            for item in controller.cart_items:
                lines.append(f"  {item['name'][:28]:<28} x{item['qty']} {item['total_price']:>8.2f}")

        if controller.examinations:
            lines.append(f"{'-'*44}")
            lines.append(f"{_('Examinations')}:")
            for i, exam in enumerate(controller.examinations, 1):
                lines.append(f"  [{i}] {exam.get('exam_type', 'N/A')}")
                lines.append(f"      OD: {exam.get('sphere_od', '-')}/{exam.get('cylinder_od', '-')}x{exam.get('axis_od', '-')}")
                lines.append(f"      OS: {exam.get('sphere_os', '-')}/{exam.get('cylinder_os', '-')}x{exam.get('axis_os', '-')}")
                lines.append(f"      IPD: {exam.get('ipd', '-')}")
                lines.append(f"      {_('Lens')}: {exam.get('lens_info', '-')}")
                lines.append(f"      {_('Frame')}: {exam.get('frame_info', '-')} ({exam.get('frame_color', '-')})")

        lines.extend([
            f"{'-'*44}",
            f"{_('Gross Total'):.<30} {controller.totals['gross_total']:>10.2f} {currency}",
            f"{_('Discount'):.<30} {controller.totals['discount']:>10.2f} {currency}",
            f"{_('Net Amount'):.<30} {controller.totals['net_amount']:>10.2f} {currency}",
            f"{_('Amount Paid'):.<30} {controller.totals['amount_paid']:>10.2f} {currency}",
            f"{_('Balance'):.<30} {controller.totals['balance']:>10.2f} {currency}",
            f"{'='*44}",
        ])
        return "\n".join([line for line in lines if line])

    def build_customer_copy():
        lines = [
            f"{'='*44}",
            f"{'نسخة العميل - CUSTOMER COPY':^44}",
            f"{'='*44}",
            f"{shop_name:^44}",
            f"{shop_address:^44}" if shop_address else "",
            f"{shop_phone:^44}" if shop_phone else "",
            f"{'='*44}",
            f"{_('Invoice')}: #{controller.invoice_no}",
            f"{_('Date')}: {datetime.datetime.now().strftime('%d/%m/%Y %H:%M')}",
            f"{_('Delivery Date')}: {_delivery_str()}",
            f"{'-'*44}",
            f"{_('Customer')}: {customer_name}",
            f"{_('Phone')}: {customer_phone}" if customer_phone else "",
            f"{'-'*44}",
        ]

        if controller.cart_items:
            lines.append(f"{_('Items')}:")
            for item in controller.cart_items:
                lines.append(f"  {item['name'][:28]:<28} x{item['qty']} {item['total_price']:>8.2f}")

        if controller.examinations:
            lines.append(f"{'-'*44}")
            lines.append(f"{_('Ordered Items')}:")
            for exam in controller.examinations:
                if exam.get('lens_info'):
                    lines.append(f"  {_('Lens')}: {exam.get('lens_info', '-')}")
                if exam.get('frame_info'):
                    lines.append(f"  {_('Frame')}: {exam.get('frame_info', '-')} ({exam.get('frame_color', '-')})")

        lines.extend([
            f"{'-'*44}",
            f"{_('Gross Total'):.<30} {controller.totals['gross_total']:>10.2f} {currency}",
            f"{_('Discount'):.<30} {controller.totals['discount']:>10.2f} {currency}",
            f"{_('Net Amount'):.<30} {controller.totals['net_amount']:>10.2f} {currency}",
            f"{_('Amount Paid'):.<30} {controller.totals['amount_paid']:>10.2f} {currency}",
            f"{_('Balance'):.<30} {controller.totals['balance']:>10.2f} {currency}",
            f"{'='*44}",
            f"{_('Thank you for your purchase!'):^44}",
            f"{'='*44}",
        ])
        return "\n".join([line for line in lines if line])

    def build_lab_copy():
        lines = [
            f"{'='*44}",
            f"{'نسخة المختبر - LAB COPY':^44}",
            f"{'='*44}",
            f"{_('Invoice')}: #{controller.invoice_no}",
            f"{_('Date')}: {datetime.datetime.now().strftime('%d/%m/%Y')}",
            f"{_('Delivery Date')}: {_delivery_str()}",
            f"{_('Doctor')}: {controller.doctor_name}" if controller.doctor_name else "",
            f"{'='*44}",
        ]

        if controller.examinations:
            for i, exam in enumerate(controller.examinations, 1):
                lines.append(f"{'-'*44}")
                lines.append(f"{_('Exam')} #{i}: {exam.get('exam_type', 'N/A')}")
                lines.append(f"{'='*44}")
                lines.append(f"  {'OD (Right Eye)':}")
                lines.append(f"    SPH: {exam.get('sphere_od', '-'):>8}")
                lines.append(f"    CYL: {exam.get('cylinder_od', '-'):>8}")
                lines.append(f"    AXIS: {exam.get('axis_od', '-'):>7}")
                lines.append(f"  {'OS (Left Eye)':}")
                lines.append(f"    SPH: {exam.get('sphere_os', '-'):>8}")
                lines.append(f"    CYL: {exam.get('cylinder_os', '-'):>8}")
                lines.append(f"    AXIS: {exam.get('axis_os', '-'):>7}")
                lines.append(f"  IPD: {exam.get('ipd', '-')}")
                lines.append(f"{'-'*44}")
                lines.append(f"  {_('Lens Type')}: {exam.get('lens_info', '-')}")
                lines.append(f"  {_('Frame')}: {exam.get('frame_info', '-')}")
                lines.append(f"  {_('Color')}: {exam.get('frame_color', '-')}")
                lines.append(f"  {_('Frame Status')}: {exam.get('frame_status', '-')}")
        else:
            lines.append(f"{_('No examination data')}")

        lines.append(f"{'='*44}")
        return "\n".join([line for line in lines if line])

    builders = {"shop": build_shop_copy, "customer": build_customer_copy, "lab": build_lab_copy}

    preview_text = ft.Text("", font_family="Courier New", size=11)
    preview_container = ft.Container(
        content=preview_text,
        bgcolor=ON_PRIMARY,
        padding=15,
        border_radius=5,
        border=ft.border.all(1, BORDER),
        width=420,
        height=400,
    )

    def show_preview(copy_type):
        preview_text.value = builders[copy_type]()
        page.update()

    def print_copy(copy_type):
        print(builders[copy_type]())
        show_success(page, f"✓ {_('Sent to printer')}")

    def print_all(_e):
        for key in ("shop", "customer", "lab"):
            print(builders[key]())
            print("\n" + "=" * 50 + "\n")
        show_success(page, f"✓ {_('All copies sent to printer')}")

    def close_and_reset(_e):
        dlg.open = False
        controller.reset_pos()
        page.go("/")

    show_preview("shop")

    copy_tabs = ft.Row(
        [
            ft.ElevatedButton(_("Shop Copy"), icon=ft.icons.STORE, on_click=lambda e: show_preview("shop"), bgcolor=BRAND_PRIMARY, color=ON_PRIMARY),
            ft.ElevatedButton(_("Customer Copy"), icon=ft.icons.PERSON, on_click=lambda e: show_preview("customer"), bgcolor=SUCCESS, color=ON_PRIMARY),
            ft.ElevatedButton(_("Lab Copy"), icon=ft.icons.SCIENCE, on_click=lambda e: show_preview("lab"), bgcolor=WARNING, color=ON_PRIMARY),
        ],
        alignment=ft.MainAxisAlignment.CENTER,
        spacing=10,
    )

    print_buttons = ft.Row(
        [
            ft.OutlinedButton(_("Print Shop"), icon=ft.icons.PRINT, on_click=lambda e: print_copy("shop")),
            ft.OutlinedButton(_("Print Customer"), icon=ft.icons.PRINT, on_click=lambda e: print_copy("customer")),
            ft.OutlinedButton(_("Print Lab"), icon=ft.icons.PRINT, on_click=lambda e: print_copy("lab")),
        ],
        alignment=ft.MainAxisAlignment.CENTER,
        spacing=10,
    )

    dlg = build_dialog(
        _("Order Saved Successfully!"),
        ft.Container(
            ft.Column(
                [
                    ft.Row(
                        [
                            ft.Icon(ft.icons.CHECK_CIRCLE, color=SUCCESS, size=30),
                            ft.Text(_("Order Saved Successfully!"), weight=ft.FontWeight.BOLD),
                        ],
                        alignment=ft.MainAxisAlignment.CENTER,
                    ),
                    copy_tabs,
                    ft.Divider(height=10),
                    preview_container,
                    ft.Divider(height=10),
                    print_buttons,
                ],
                spacing=10,
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
            ),
            width=480,
        ),
        [],
    )
    dlg.actions = [
        primary_button(_("Print All 3 Copies"), on_click=print_all, icon=ft.icons.PRINT),
        primary_button(_("Done"), on_click=close_and_reset, icon=ft.icons.CHECK),
    ]
    dlg.actions_alignment = ft.MainAxisAlignment.SPACE_BETWEEN
    open_dialog(page, dlg)
