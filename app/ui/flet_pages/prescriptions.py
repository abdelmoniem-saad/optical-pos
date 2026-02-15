import flet as ft
from app.core.i18n import _
import datetime
import subprocess
import os

def PrescriptionView(page: ft.Page, repo, customer_id):
    p_list = ft.ListView(expand=True, spacing=10)
    customer_name = "Customer"
    customer_data = None

    def load_customer():
        nonlocal customer_name, customer_data
        customers = repo.get_customers()
        for c in customers:
            if str(c.get("id")) == str(customer_id):
                customer_name = c.get("name", "")
                customer_data = c
                break

    def print_prescription(record):
        """Print a prescription record."""
        shop_name = repo.get_setting("shop_name", "Optical Shop")

        if record["type"] == "prescription":
            p = record["data"]
            lines = [
                f"{'='*44}",
                f"{shop_name:^44}",
                f"{'='*44}",
                f"{_('Prescription')}",
                f"{_('Customer')}: {customer_name}",
                f"{_('Date')}: {p.get('created_at', '')[:10] if p.get('created_at') else 'N/A'}",
                f"{_('Type')}: {p.get('type', 'N/A')}",
                f"{_('Doctor')}: {p.get('doctor_name', 'N/A')}",
                f"{'='*44}",
                f"OD (Right Eye):",
                f"  SPH: {p.get('sphere_od', '-')}",
                f"  CYL: {p.get('cylinder_od', '-')}",
                f"  AXIS: {p.get('axis_od', '-')}",
                f"",
                f"OS (Left Eye):",
                f"  SPH: {p.get('sphere_os', '-')}",
                f"  CYL: {p.get('cylinder_os', '-')}",
                f"  AXIS: {p.get('axis_os', '-')}",
                f"{'='*44}",
            ]
            if p.get('notes'):
                lines.append(f"{_('Notes')}: {p.get('notes')}")
        else:
            e = record["data"]
            sale = record.get("sale", {})
            lines = [
                f"{'='*44}",
                f"{shop_name:^44}",
                f"{'='*44}",
                f"{_('Order Exam')} - #{sale.get('invoice_no', 'N/A')}",
                f"{_('Customer')}: {customer_name}",
                f"{_('Date')}: {sale.get('order_date', '')[:10] if sale.get('order_date') else 'N/A'}",
                f"{_('Type')}: {e.get('exam_type', 'N/A')}",
                f"{'='*44}",
                f"OD (Right Eye):",
                f"  SPH: {e.get('sphere_od', '-')}",
                f"  CYL: {e.get('cylinder_od', '-')}",
                f"  AXIS: {e.get('axis_od', '-')}",
                f"",
                f"OS (Left Eye):",
                f"  SPH: {e.get('sphere_os', '-')}",
                f"  CYL: {e.get('cylinder_os', '-')}",
                f"  AXIS: {e.get('axis_os', '-')}",
                f"",
                f"IPD: {e.get('ipd', '-')}",
                f"{'='*44}",
                f"{_('Lens Type')}: {e.get('lens_info', '-')}",
                f"{_('Frame')}: {e.get('frame_info', '-')}",
                f"{_('Color')}: {e.get('frame_color', '-')}",
                f"{'='*44}",
            ]

        content = "\n".join(lines)
        print(content)
        page.snack_bar = ft.SnackBar(ft.Text(f"✓ {_('Sent to printer')}"))
        page.snack_bar.open = True
        page.update()

    def preview_image(image_path):
        """Preview an attached image."""
        if not image_path or not os.path.exists(image_path):
            page.snack_bar = ft.SnackBar(ft.Text(_("Image not found")))
            page.snack_bar.open = True
            page.update()
            return

        # Open image with default system viewer
        try:
            if os.name == 'nt':  # Windows
                os.startfile(image_path)
            else:  # Linux/Mac
                subprocess.run(['xdg-open', image_path])
        except Exception as ex:
            page.snack_bar = ft.SnackBar(ft.Text(f"{_('Error')}: {str(ex)}"))
            page.snack_bar.open = True
            page.update()

    def load_prescriptions():
        p_list.controls.clear()

        # Get prescriptions from prescriptions table
        prescriptions = repo.get_prescriptions(customer_id)

        # Also get order examinations for this customer
        data = repo._read_local()
        sales = data.get("sales", [])
        exams = data.get("order_examinations", [])

        customer_sales = [s for s in sales if str(s.get("customer_id")) == str(customer_id)]
        customer_sale_ids = [s["id"] for s in customer_sales]
        customer_exams = [e for e in exams if e.get("sale_id") in customer_sale_ids]

        # Combine both sources
        all_records = []

        for p in prescriptions:
            all_records.append({
                "type": "prescription",
                "data": p,
                "date": p.get("created_at", "")
            })

        for e in customer_exams:
            sale = next((s for s in customer_sales if s["id"] == e.get("sale_id")), {})
            all_records.append({
                "type": "examination",
                "data": e,
                "sale": sale,
                "date": sale.get("order_date", "")
            })

        # Sort by date descending
        all_records.sort(key=lambda x: x.get("date", ""), reverse=True)

        if not all_records:
            p_list.controls.append(
                ft.Container(
                    ft.Column([
                        ft.Icon(ft.Icons.ASSIGNMENT, size=50, color=ft.Colors.GREY_400),
                        ft.Text(_("No prescriptions or examinations found"), italic=True, color=ft.Colors.GREY_700)
                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                    padding=40
                )
            )
        else:
            for record in all_records:
                if record["type"] == "prescription":
                    p = record["data"]
                    image_path = p.get("image_path", "")

                    action_buttons = ft.Row([
                        ft.IconButton(
                            ft.Icons.PRINT,
                            tooltip=_("Print"),
                            icon_color=ft.Colors.BLUE_700,
                            on_click=lambda e, r=record: print_prescription(r)
                        ),
                    ], spacing=0)

                    if image_path:
                        action_buttons.controls.insert(0, ft.IconButton(
                            ft.Icons.IMAGE,
                            tooltip=_("View Image"),
                            icon_color=ft.Colors.GREEN_700,
                            on_click=lambda e, path=image_path: preview_image(path)
                        ))

                    p_list.controls.append(
                        ft.Card(
                            content=ft.Container(
                                ft.Column([
                                    ft.Row([
                                        ft.Icon(ft.Icons.ASSIGNMENT, color=ft.Colors.BLUE_700),
                                        ft.Column([
                                            ft.Text(f"{_('Prescription')} - {p.get('type', 'N/A')}", weight=ft.FontWeight.BOLD),
                                            ft.Text(f"{_('Doctor')}: {p.get('doctor_name', 'N/A')} | {_('Date')}: {p.get('created_at', '')[:10] if p.get('created_at') else 'N/A'}", size=12, color=ft.Colors.GREY_700),
                                        ], expand=True),
                                        action_buttons,
                                    ]),
                                    ft.Divider(height=10),
                                    ft.Row([
                                        ft.Container(
                                            ft.Column([
                                                ft.Text("OD (Right Eye)", weight=ft.FontWeight.BOLD, size=12, color=ft.Colors.BLUE_700),
                                                ft.Text(f"SPH: {p.get('sphere_od', '-')}", size=12),
                                                ft.Text(f"CYL: {p.get('cylinder_od', '-')}", size=12),
                                                ft.Text(f"AXIS: {p.get('axis_od', '-')}", size=12),
                                            ]),
                                            bgcolor=ft.Colors.BLUE_50,
                                            padding=10,
                                            border_radius=8,
                                            expand=True
                                        ),
                                        ft.Container(
                                            ft.Column([
                                                ft.Text("OS (Left Eye)", weight=ft.FontWeight.BOLD, size=12, color=ft.Colors.GREEN_700),
                                                ft.Text(f"SPH: {p.get('sphere_os', '-')}", size=12),
                                                ft.Text(f"CYL: {p.get('cylinder_os', '-')}", size=12),
                                                ft.Text(f"AXIS: {p.get('axis_os', '-')}", size=12),
                                            ]),
                                            bgcolor=ft.Colors.GREEN_50,
                                            padding=10,
                                            border_radius=8,
                                            expand=True
                                        ),
                                    ], spacing=10),
                                    ft.Text(f"{_('Notes')}: {p.get('notes', '-')}", size=12, color=ft.Colors.GREY_700) if p.get('notes') else ft.Container()
                                ]),
                                padding=15
                            )
                        )
                    )
                else:
                    e = record["data"]
                    sale = record.get("sale", {})
                    image_path = e.get("image_path", "")

                    action_buttons = ft.Row([
                        ft.IconButton(
                            ft.Icons.PRINT,
                            tooltip=_("Print"),
                            icon_color=ft.Colors.BLUE_700,
                            on_click=lambda ev, r=record: print_prescription(r)
                        ),
                    ], spacing=0)

                    if image_path:
                        action_buttons.controls.insert(0, ft.IconButton(
                            ft.Icons.IMAGE,
                            tooltip=_("View Image"),
                            icon_color=ft.Colors.GREEN_700,
                            on_click=lambda ev, path=image_path: preview_image(path)
                        ))

                    p_list.controls.append(
                        ft.Card(
                            content=ft.Container(
                                ft.Column([
                                    ft.Row([
                                        ft.Icon(ft.Icons.REMOVE_RED_EYE, color=ft.Colors.GREEN_700),
                                        ft.Column([
                                            ft.Text(f"{_('Order Exam')} - {e.get('exam_type', 'N/A')}", weight=ft.FontWeight.BOLD),
                                            ft.Text(f"#{sale.get('invoice_no', 'N/A')} | {sale.get('order_date', '')[:10] if sale.get('order_date') else 'N/A'}", size=12, color=ft.Colors.GREY_700),
                                        ], expand=True),
                                        action_buttons,
                                    ]),
                                    ft.Divider(height=10),
                                    ft.Row([
                                        ft.Container(
                                            ft.Column([
                                                ft.Text("OD (Right Eye)", weight=ft.FontWeight.BOLD, size=12, color=ft.Colors.BLUE_700),
                                                ft.Text(f"SPH: {e.get('sphere_od', '-')}", size=12),
                                                ft.Text(f"CYL: {e.get('cylinder_od', '-')}", size=12),
                                                ft.Text(f"AXIS: {e.get('axis_od', '-')}", size=12),
                                            ]),
                                            bgcolor=ft.Colors.BLUE_50,
                                            padding=10,
                                            border_radius=8,
                                            expand=True
                                        ),
                                        ft.Container(
                                            ft.Column([
                                                ft.Text("OS (Left Eye)", weight=ft.FontWeight.BOLD, size=12, color=ft.Colors.GREEN_700),
                                                ft.Text(f"SPH: {e.get('sphere_os', '-')}", size=12),
                                                ft.Text(f"CYL: {e.get('cylinder_os', '-')}", size=12),
                                                ft.Text(f"AXIS: {e.get('axis_os', '-')}", size=12),
                                            ]),
                                            bgcolor=ft.Colors.GREEN_50,
                                            padding=10,
                                            border_radius=8,
                                            expand=True
                                        ),
                                        ft.Container(
                                            ft.Column([
                                                ft.Text("IPD", weight=ft.FontWeight.BOLD, size=12, color=ft.Colors.PURPLE_700),
                                                ft.Text(f"{e.get('ipd', '-')}", size=14, weight=ft.FontWeight.BOLD),
                                            ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                                            bgcolor=ft.Colors.PURPLE_50,
                                            padding=10,
                                            border_radius=8,
                                            width=80
                                        ),
                                    ], spacing=10),
                                    ft.Divider(height=10),
                                    ft.Row([
                                        ft.Container(
                                            ft.Row([
                                                ft.Icon(ft.Icons.LENS, size=16, color=ft.Colors.ORANGE_700),
                                                ft.Text(f"{_('Lens')}: {e.get('lens_info', '-')}", size=12),
                                            ]),
                                            bgcolor=ft.Colors.ORANGE_50,
                                            padding=8,
                                            border_radius=5
                                        ),
                                        ft.Container(
                                            ft.Row([
                                                ft.Icon(ft.Icons.CROP_SQUARE, size=16, color=ft.Colors.TEAL_700),
                                                ft.Text(f"{_('Frame')}: {e.get('frame_info', '-')} ({e.get('frame_color', '-')})", size=12),
                                            ]),
                                            bgcolor=ft.Colors.TEAL_50,
                                            padding=8,
                                            border_radius=5
                                        ),
                                    ], spacing=10, wrap=True)
                                ]),
                                padding=15
                            )
                        )
                    )
        page.update()

    def add_prescription(e):
        """Dialog to add a new prescription."""
        def save_rx(e):
            if not sph_od.value and not sph_os.value:
                page.snack_bar = ft.SnackBar(ft.Text(_("Please enter at least one eye measurement")))
                page.snack_bar.open = True
                page.update()
                return

            rx_data = {
                "customer_id": customer_id,
                "type": rx_type.value,
                "doctor_name": doctor_field.value,
                "sphere_od": sph_od.value,
                "cylinder_od": cyl_od.value,
                "axis_od": axis_od.value,
                "ipd_od": ipd_od.value,
                "sphere_os": sph_os.value,
                "cylinder_os": cyl_os.value,
                "axis_os": axis_os.value,
                "ipd_os": ipd_os.value,
                "notes": notes_field.value,
                "created_at": datetime.datetime.utcnow().isoformat()
            }
            repo.add_prescription(rx_data)
            dialog.open = False
            page.snack_bar = ft.SnackBar(ft.Text(_("Prescription added successfully")))
            page.snack_bar.open = True
            load_prescriptions()
            page.update()

        rx_type = ft.Dropdown(
            label=_("Type"),
            value="Distance",
            options=[
                ft.dropdown.Option("Distance", _("Distance")),
                ft.dropdown.Option("Reading", _("Reading")),
                ft.dropdown.Option("Contact Lenses", _("Contact Lenses")),
            ],
            width=150
        )
        doctor_field = ft.TextField(label=_("Doctor Name"), expand=True)

        # OD (Right Eye)
        sph_od = ft.TextField(label="R.SPH", width=80)
        cyl_od = ft.TextField(label="R.CYL", width=80)
        axis_od = ft.TextField(label="R.AXIS", width=80)
        ipd_od = ft.TextField(label="R.IPD", width=80)

        # OS (Left Eye)
        sph_os = ft.TextField(label="L.SPH", width=80)
        cyl_os = ft.TextField(label="L.CYL", width=80)
        axis_os = ft.TextField(label="L.AXIS", width=80)
        ipd_os = ft.TextField(label="L.IPD", width=80)

        notes_field = ft.TextField(label=_("Notes"), multiline=True, min_lines=2, expand=True)

        dialog = ft.AlertDialog(
            title=ft.Text(_("Add Prescription")),
            content=ft.Container(
                ft.Column([
                    ft.Row([rx_type, doctor_field]),
                    ft.Divider(),
                    ft.Text("OD (Right Eye)", weight=ft.FontWeight.BOLD),
                    ft.Row([sph_od, cyl_od, axis_od, ipd_od]),
                    ft.Text("OS (Left Eye)", weight=ft.FontWeight.BOLD),
                    ft.Row([sph_os, cyl_os, axis_os, ipd_os]),
                    ft.Divider(),
                    notes_field
                ], tight=True, spacing=10),
                width=500
            ),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(_("Save"), on_click=save_rx)
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    load_customer()
    load_prescriptions()

    return ft.View(
        f"/prescription/{customer_id}",
        [
            ft.AppBar(
                title=ft.Text(f"{_('Prescriptions')} - {customer_name}"),
                bgcolor=ft.Colors.BLUE_700,
                color=ft.Colors.WHITE,
                leading=ft.IconButton(ft.Icons.ARROW_BACK, on_click=lambda _: page.go("/customers"))
            ),
            ft.Container(
                content=ft.Column([
                    # Customer info header
                    ft.Card(
                        content=ft.Container(
                            ft.ListTile(
                                leading=ft.Icon(ft.Icons.PERSON, size=40),
                                title=ft.Text(customer_name, size=20, weight=ft.FontWeight.BOLD),
                                subtitle=ft.Text(f"📱 {customer_data.get('phone', 'N/A') if customer_data else 'N/A'} | 📍 {customer_data.get('city', 'N/A') if customer_data else 'N/A'}"),
                                trailing=ft.ElevatedButton(_("+ Add Prescription"), icon=ft.Icons.ADD, on_click=add_prescription)
                            ),
                            padding=10
                        )
                    ),
                    ft.Divider(),
                    ft.Text(_("Prescription & Examination History"), size=18, weight=ft.FontWeight.BOLD),
                    p_list,
                ], expand=True),
                padding=20,
                expand=True,
            )
        ],
    )
