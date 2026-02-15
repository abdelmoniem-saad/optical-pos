import flet as ft
from app.core.i18n import _

def LabView(page: ft.Page, repo):
    lab_list = ft.ListView(expand=True, spacing=5)

    # Filter controls
    status_filter = ft.Dropdown(
        label=_("Filter by Status"),
        value="All",
        options=[
            ft.dropdown.Option("All", _("All")),
            ft.dropdown.Option("Not Started", _("Not Started")),
            ft.dropdown.Option("In Lab", _("In Lab")),
            ft.dropdown.Option("Ready", _("Ready")),
            ft.dropdown.Option("Received", _("Received")),
        ],
        width=180,
        on_change=lambda e: load_data(search_input.value)
    )

    def update_status(sale_id, status):
        repo.update_sale_lab_status(sale_id, status)
        load_data(search_input.value)
        page.snack_bar = ft.SnackBar(ft.Text(_("Status updated successfully")))
        page.snack_bar.open = True
        page.update()

    def load_data(term=""):
        lab_list.controls.clear()
        sales = repo.get_sales()
        customers = repo.get_customers()

        # Filter sales that have optical components (lab_status is not None)
        lab_sales = [s for s in sales if s.get("lab_status")]
        
        # Apply status filter
        if status_filter.value != "All":
            lab_sales = [s for s in lab_sales if s.get("lab_status") == status_filter.value]

        # Apply search filter
        if term:
            term = term.lower()
            filtered = []
            for s in lab_sales:
                cust_name = ""
                if s.get("customer_id"):
                    cust = next((c for c in customers if c.get("id") == s["customer_id"]), None)
                    if cust: cust_name = cust.get("name", "")

                if (term in s.get("invoice_no", "").lower() or
                    term in cust_name.lower() or
                    term in (s.get("doctor_name") or "").lower()):
                    filtered.append(s)
            lab_sales = filtered

        # Sort by status priority: Not Started > In Lab > Ready > Received
        status_order = {"Not Started": 0, "In Lab": 1, "Ready": 2, "Received": 3}
        lab_sales.sort(key=lambda x: (status_order.get(x.get("lab_status", ""), 99), x.get("order_date", "")))

        if not lab_sales:
            lab_list.controls.append(
                ft.ListTile(title=ft.Text(_("No lab orders found"), italic=True, color=ft.Colors.GREY_700))
            )
        else:
            for s in lab_sales:
                cust_name = _("Walk-in")
                cust_phone = ""
                if s.get("customer_id"):
                    cust = next((c for c in customers if c.get("id") == s["customer_id"]), None)
                    if cust:
                        cust_name = cust.get("name", "")
                        cust_phone = cust.get("phone", "")

                status = s.get("lab_status", "N/A")
                status_color = ft.Colors.GREY_500
                if status == "Not Started": status_color = ft.Colors.RED_500
                elif status == "In Lab": status_color = ft.Colors.ORANGE_500
                elif status == "Ready": status_color = ft.Colors.GREEN_500
                elif status == "Received": status_color = ft.Colors.BLUE_500

                # Delivery date
                delivery = s.get("delivery_date", "N/A")
                if delivery and delivery != "N/A":
                    delivery = delivery[:10]

                lab_list.controls.append(
                    ft.Card(
                        content=ft.Container(
                            content=ft.Column([
                                ft.ListTile(
                                    leading=ft.Container(
                                        ft.Icon(ft.icons.SCIENCE, color=ft.Colors.WHITE, size=25),
                                        bgcolor=status_color,
                                        border_radius=25,
                                        padding=10,
                                        width=50,
                                        height=50
                                    ),
                                    title=ft.Text(f"#{s['invoice_no']} - {cust_name}", weight=ft.FontWeight.BOLD),
                                    subtitle=ft.Text(f"📱 {cust_phone} | 👨‍⚕️ {s.get('doctor_name', 'N/A')}"),
                                ),
                                ft.Row([
                                    ft.Column([
                                        ft.Text(_("Order Date"), size=10, color=ft.Colors.GREY_700),
                                        ft.Text(s.get("order_date", "")[:10], size=12, weight=ft.FontWeight.BOLD)
                                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, expand=True),
                                    ft.Column([
                                        ft.Text(_("Delivery Date"), size=10, color=ft.Colors.GREY_700),
                                        ft.Text(delivery, size=12, weight=ft.FontWeight.BOLD, color=ft.Colors.BLUE_700)
                                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, expand=True),
                                    ft.Column([
                                        ft.Text(_("Status"), size=10, color=ft.Colors.GREY_700),
                                        ft.Dropdown(
                                            value=status,
                                            options=[
                                                ft.dropdown.Option("Not Started", _("Not Started")),
                                                ft.dropdown.Option("In Lab", _("In Lab")),
                                                ft.dropdown.Option("Ready", _("Ready")),
                                                ft.dropdown.Option("Received", _("Received")),
                                            ],
                                            on_change=lambda e, sid=s["id"]: update_status(sid, e.control.value),
                                            width=140,
                                            dense=True
                                        )
                                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, expand=True),
                                    ft.Column([
                                        ft.IconButton(
                                            ft.icons.PRINT,
                                            tooltip=_("Print Lab Copy"),
                                            on_click=lambda e, sale=s: print_lab_copy(sale)
                                        ),
                                        ft.IconButton(
                                            ft.icons.VISIBILITY,
                                            tooltip=_("View Details"),
                                            on_click=lambda e, sale=s: show_details(sale)
                                        )
                                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER)
                                ], alignment=ft.MainAxisAlignment.SPACE_AROUND),
                            ]),
                            padding=10
                        )
                    )
                )
        page.update()

    def show_details(sale):
        """Show examination details for a lab order."""
        customers = repo.get_customers()
        cust_name = _("Walk-in")
        if sale.get("customer_id"):
            cust = next((c for c in customers if c["id"] == sale["customer_id"]), None)
            if cust: cust_name = cust.get("name", "")

        # Get examinations for this sale
        data = repo._read_local()
        exams = [e for e in data.get("order_examinations", []) if e.get("sale_id") == sale.get("id")]

        exam_col = ft.Column([], spacing=10)
        for i, exam in enumerate(exams, 1):
            exam_col.controls.append(
                ft.Container(
                    ft.Column([
                        ft.Text(f"#{i} - {exam.get('exam_type', 'N/A')}", weight=ft.FontWeight.BOLD),
                        ft.Row([
                            ft.Text(f"OD: {exam.get('sphere_od', '')}/{exam.get('cylinder_od', '')}x{exam.get('axis_od', '')}"),
                            ft.Text(f"OS: {exam.get('sphere_os', '')}/{exam.get('cylinder_os', '')}x{exam.get('axis_os', '')}"),
                            ft.Text(f"IPD: {exam.get('ipd', '')}"),
                        ]),
                        ft.Text(f"{_('Lens')}: {exam.get('lens_info', 'N/A')}"),
                        ft.Text(f"{_('Frame')}: {exam.get('frame_info', 'N/A')} ({exam.get('frame_color', '')})"),
                    ]),
                    border=ft.border.all(1, ft.Colors.GREY_300),
                    border_radius=5,
                    padding=10
                )
            )

        if not exams:
            exam_col.controls.append(ft.Text(_("No examination data"), italic=True))

        dialog = ft.AlertDialog(
            title=ft.Text(f"{_('Lab Order')} #{sale.get('invoice_no', '')}"),
            content=ft.Container(
                ft.Column([
                    ft.Text(f"{_('Customer')}: {cust_name}", weight=ft.FontWeight.BOLD),
                    ft.Text(f"{_('Doctor')}: {sale.get('doctor_name', 'N/A')}"),
                    ft.Divider(),
                    ft.Text(_("Examinations:"), weight=ft.FontWeight.BOLD),
                    exam_col
                ], scroll=ft.ScrollMode.AUTO),
                width=500,
                height=400
            ),
            actions=[ft.TextButton(_("Close"), on_click=lambda e: setattr(dialog, "open", False) or page.update())]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    def print_lab_copy(sale):
        """Print lab copy for technicians."""
        customers = repo.get_customers()
        cust_name = _("Walk-in")
        cust_phone = ""
        if sale.get("customer_id"):
            cust = next((c for c in customers if c["id"] == sale["customer_id"]), None)
            if cust:
                cust_name = cust.get("name", "")
                cust_phone = cust.get("phone", "")

        shop_name = repo.get_setting("shop_name", "Optical Shop")

        # Get examinations
        data = repo._read_local()
        exams = [e for e in data.get("order_examinations", []) if e.get("sale_id") == sale.get("id")]

        lab_copy = f"""
{'='*50}
LAB COPY - {shop_name}
{'='*50}
Invoice: #{sale.get('invoice_no', '')}
Date: {sale.get('order_date', '')[:10]}
Delivery: {sale.get('delivery_date', 'N/A')[:10] if sale.get('delivery_date') else 'N/A'}
Customer: {cust_name} | Phone: {cust_phone}
Doctor: {sale.get('doctor_name', 'N/A')}
{'-'*50}
"""
        for i, exam in enumerate(exams, 1):
            lab_copy += f"""
Exam #{i} - {exam.get('exam_type', 'N/A')}
  OD: SPH {exam.get('sphere_od', '')} CYL {exam.get('cylinder_od', '')} AXIS {exam.get('axis_od', '')}
  OS: SPH {exam.get('sphere_os', '')} CYL {exam.get('cylinder_os', '')} AXIS {exam.get('axis_os', '')}
  IPD: {exam.get('ipd', '')}
  Lens: {exam.get('lens_info', 'N/A')}
  Frame: {exam.get('frame_info', 'N/A')} ({exam.get('frame_color', '')}) [{exam.get('frame_status', '')}]
"""
        lab_copy += f"\n{'='*50}\n"

        print(lab_copy)
        page.snack_bar = ft.SnackBar(ft.Text(_("Lab copy sent to printer")))
        page.snack_bar.open = True
        page.update()

    search_input = ft.TextField(
        label=_("Search by Invoice, Customer or Doctor..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_change=lambda e: load_data(e.control.value)
    )

    load_data()

    # Summary stats
    sales = repo.get_sales()
    lab_sales = [s for s in sales if s.get("lab_status")]
    not_started = len([s for s in lab_sales if s.get("lab_status") == "Not Started"])
    in_lab = len([s for s in lab_sales if s.get("lab_status") == "In Lab"])
    ready = len([s for s in lab_sales if s.get("lab_status") == "Ready"])

    return ft.View(
        "/lab",
        [
            ft.AppBar(
                title=ft.Text(_("Lab Management")),
                bgcolor=ft.Colors.BLUE_700,
                color=ft.Colors.WHITE,
                leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(
                content=ft.Column([
                    ft.Text(_("Lab Orders"), size=28, weight=ft.FontWeight.BOLD),
                    # Summary badges
                    ft.Row([
                        ft.Container(
                            ft.Row([
                                ft.Icon(ft.icons.HOURGLASS_EMPTY, color=ft.Colors.RED_700, size=20),
                                ft.Text(f"{not_started} {_('Not Started')}", weight=ft.FontWeight.BOLD)
                            ]),
                            bgcolor=ft.Colors.RED_100,
                            padding=ft.padding.symmetric(horizontal=15, vertical=8),
                            border_radius=20
                        ),
                        ft.Container(
                            ft.Row([
                                ft.Icon(ft.icons.BUILD, color=ft.Colors.ORANGE_700, size=20),
                                ft.Text(f"{in_lab} {_('In Lab')}", weight=ft.FontWeight.BOLD)
                            ]),
                            bgcolor=ft.Colors.ORANGE_100,
                            padding=ft.padding.symmetric(horizontal=15, vertical=8),
                            border_radius=20
                        ),
                        ft.Container(
                            ft.Row([
                                ft.Icon(ft.icons.CHECK_CIRCLE, color=ft.Colors.GREEN_700, size=20),
                                ft.Text(f"{ready} {_('Ready')}", weight=ft.FontWeight.BOLD)
                            ]),
                            bgcolor=ft.Colors.GREEN_100,
                            padding=ft.padding.symmetric(horizontal=15, vertical=8),
                            border_radius=20
                        ),
                    ], spacing=10),
                    ft.Divider(),
                    ft.Row([search_input, status_filter]),
                    lab_list,
                ], expand=True, spacing=10),
                padding=20,
                expand=True
            )
        ]
    )
