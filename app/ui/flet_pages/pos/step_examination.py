"""Step 2 — order details and optical examination (Glasses / Contact Lenses).

Includes the past-prescriptions side drawer and the examination-row builder
that supports multiple exam rows per order.
"""

import flet as ft

from app.core.i18n import _
from app.ui.components.feedback import show_success
from app.ui.components.ui_tokens import (
    BRAND_PRIMARY,
    BRAND_PRIMARY_BG,
    BRAND_PRIMARY_DARK,
    BRAND_PRIMARY_FAINT,
    DANGER,
    ON_PRIMARY,
    SUCCESS,
    TEXT_FAINT,
    TEXT_MUTED,
    WARNING,
)


def build_examination_step(controller):
    """Render Step 2 (order/examination)."""
    controller.current_step = 2
    page = controller._page

    customer_name = (
        controller.selected_customer.get("name", "")
        if controller.selected_customer
        else _("Walk-in Customer")
    )

    controller.order_date_picker = ft.TextField(
        label=_("Order Date"),
        value=controller.order_date.strftime("%Y-%m-%d"),
        read_only=True,
        width=140,
        dense=True,
    )
    controller.delivery_date_picker = ft.TextField(
        label=_("Delivery Date"),
        value=controller.delivery_date.strftime("%Y-%m-%d"),
        width=140,
        dense=True,
    )
    controller.doctor_name_input = ft.TextField(
        label=_("Doctor Name"),
        value=controller.doctor_name,
        expand=True,
        dense=True,
    )

    controller.exam_rows_container = ft.Column([], spacing=8)

    if not controller.examinations:
        add_exam_row(controller)
    else:
        for exam in controller.examinations:
            add_exam_row(controller, exam)

    past_exams = []
    if controller.selected_customer:
        past_exams = controller.repo.get_customer_past_examinations(controller.selected_customer.get("id"))
    past_exams_count = len(past_exams)

    def build_past_exams_panel():
        panel_content = []
        if not past_exams:
            panel_content.append(
                ft.Container(
                    ft.Column([
                        ft.Icon(ft.icons.HISTORY, size=40, color=TEXT_FAINT),
                        ft.Text(_("No previous prescriptions"), color=TEXT_FAINT),
                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                    padding=30,
                )
            )
            return panel_content

        for exam in past_exams:
            sale = exam.get("sale", {}) or {}
            exam_date = (sale.get("order_date", "") or "")[:10] or _("N/A")
            invoice_no = sale.get("invoice_no", "")

            od_info = f"OD: {exam.get('sphere_od', '-')}/{exam.get('cylinder_od', '-')}x{exam.get('axis_od', '-')}"
            os_info = f"OS: {exam.get('sphere_os', '-')}/{exam.get('cylinder_os', '-')}x{exam.get('axis_os', '-')}"

            panel_content.append(
                ft.Container(
                    ft.Column([
                        ft.Row([
                            ft.Icon(ft.icons.CALENDAR_TODAY, size=14, color=BRAND_PRIMARY),
                            ft.Text(exam_date, weight=ft.FontWeight.BOLD, size=13),
                            ft.Container(expand=True),
                            ft.Text(f"#{invoice_no}", size=11, color=TEXT_MUTED) if invoice_no else ft.Container(),
                        ]),
                        ft.Text(f"{exam.get('exam_type', 'N/A')}", size=12, color=BRAND_PRIMARY, weight=ft.FontWeight.W_500),
                        ft.Text(od_info, size=11),
                        ft.Text(os_info, size=11),
                        ft.Text(f"IPD: {exam.get('ipd', '-')}", size=11),
                        ft.Divider(height=5),
                        ft.Text(f"🔍 {exam.get('lens_info', '-')}", size=11, color=TEXT_MUTED),
                        ft.Text(f"🖼️ {exam.get('frame_info', '-')} ({exam.get('frame_color', '-')})", size=11, color=TEXT_MUTED),
                        ft.ElevatedButton(
                            _("Use this"),
                            icon=ft.icons.COPY,
                            on_click=lambda e, ex=exam: use_past_exam(ex),
                            style=ft.ButtonStyle(bgcolor=BRAND_PRIMARY, color=ON_PRIMARY),
                            height=30,
                        ),
                    ], spacing=3),
                    bgcolor=ON_PRIMARY,
                    border=ft.border.all(1, BRAND_PRIMARY_FAINT),
                    border_radius=8,
                    padding=10,
                    margin=ft.margin.only(bottom=8),
                )
            )
        return panel_content

    def use_past_exam(exam):
        add_exam_row(controller, exam)
        show_success(page, f"✓ {_('Past examination loaded')}")
        if hasattr(controller, "past_rx_drawer"):
            controller.past_rx_drawer.open = False
        page.update()

    def show_past_prescriptions(_e):
        controller.past_rx_drawer = ft.BottomSheet(
            content=ft.Container(
                ft.Column([
                    ft.Row([
                        ft.Icon(ft.icons.HISTORY, color=BRAND_PRIMARY),
                        ft.Text(_("Previous Prescriptions"), size=18, weight=ft.FontWeight.BOLD),
                        ft.Container(expand=True),
                        ft.IconButton(ft.icons.CLOSE, on_click=lambda _e2: close_drawer()),
                    ]),
                    ft.Text(f"{customer_name}", size=14, color=TEXT_MUTED),
                    ft.Divider(),
                    ft.Column(build_past_exams_panel(), scroll=ft.ScrollMode.AUTO, expand=True),
                ], expand=True),
                padding=20,
                width=400,
                height=500,
            ),
            open=True,
            enable_drag=True,
        )
        page.overlay.append(controller.past_rx_drawer)
        page.update()

    def close_drawer():
        if hasattr(controller, "past_rx_drawer"):
            controller.past_rx_drawer.open = False
            page.update()

    past_rx_button = ft.ElevatedButton(
        f"{_('Previous Prescriptions')} ({past_exams_count})" if past_exams_count > 0 else _("No Previous Prescriptions"),
        icon=ft.icons.HISTORY,
        on_click=show_past_prescriptions if past_exams_count > 0 else None,
        disabled=past_exams_count == 0,
        bgcolor=BRAND_PRIMARY_FAINT if past_exams_count > 0 else ft.colors.GREY_200,
        color=BRAND_PRIMARY_DARK if past_exams_count > 0 else TEXT_FAINT,
    )

    controller.content_area.content = ft.Column([
        ft.Row([
            ft.Column([
                ft.Text(_("Step 2: Order & Examination"), size=22, weight=ft.FontWeight.BOLD),
                ft.Row([
                    ft.Icon(ft.icons.PERSON, size=16, color=BRAND_PRIMARY),
                    ft.Text(customer_name, size=14, weight=ft.FontWeight.W_500),
                    ft.Container(width=20),
                    ft.Icon(ft.icons.RECEIPT, size=16, color=SUCCESS),
                    ft.Text(f"#{controller.invoice_no}", size=14, color=SUCCESS),
                ]),
            ], expand=True),
            past_rx_button,
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),

        ft.Divider(height=10),

        ft.Row([
            controller.order_date_picker,
            controller.delivery_date_picker,
            controller.doctor_name_input,
        ], spacing=10),

        ft.Divider(height=10),

        ft.Text(_("Examination Details"), size=16, weight=ft.FontWeight.BOLD),
        controller.exam_rows_container,

        ft.Row([
            ft.ElevatedButton(
                _("+ Add Another Exam"),
                icon=ft.icons.ADD,
                on_click=lambda _: add_exam_row(controller),
                bgcolor=BRAND_PRIMARY_BG,
                color=BRAND_PRIMARY_DARK,
            ),
        ]),

        ft.Divider(height=10),

        ft.Row([
            ft.ElevatedButton(_("← Back"), icon=ft.icons.ARROW_BACK, on_click=lambda _: controller.show_step_1()),
            ft.ElevatedButton(
                _("Add More Items"),
                icon=ft.icons.SHOPPING_CART,
                bgcolor=WARNING,
                color=ON_PRIMARY,
                on_click=lambda _: controller.show_step_3(),
            ),
            ft.ElevatedButton(
                _("Next: Payment →"),
                icon=ft.icons.ARROW_FORWARD,
                bgcolor=SUCCESS,
                color=ON_PRIMARY,
                on_click=lambda _: save_exams_and_proceed(controller),
            ),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
    ], scroll=ft.ScrollMode.AUTO, spacing=8, expand=True)
    page.update()


def add_exam_row(controller, data=None):
    """Append an examination row to the exam container."""
    page = controller._page

    lens_types = controller.repo.get_lens_types()
    frame_colors = controller.repo.get_frame_colors()
    frame_products = controller.repo.get_inventory(category="Frame")

    field_list = []

    def create_nav_field(label, value, width):
        field = ft.TextField(
            label=label,
            value=value,
            width=width,
            dense=True,
            on_submit=lambda e: focus_next_field(e.control),
        )
        field_list.append(field)
        return field

    def focus_next_field(current_field):
        try:
            idx = field_list.index(current_field)
            if idx < len(field_list) - 1:
                next_field = field_list[idx + 1]
                next_field.focus()
                if next_field.value:
                    next_field.selection = ft.TextSelection(0, len(next_field.value))
                page.update()
        except (ValueError, IndexError):
            pass

    exam_type = ft.Dropdown(
        label=_("Exam Type"),
        options=[
            ft.dropdown.Option("Distance", _("Distance")),
            ft.dropdown.Option("Reading", _("Reading")),
            ft.dropdown.Option("Contact Lenses", _("Contact Lenses")),
        ],
        value=data.get("exam_type", "Distance") if data else "Distance",
        width=120,
        dense=True,
    )

    sph_od = create_nav_field("R.SPH", data.get("sphere_od", "") if data else "", 65)
    cyl_od = create_nav_field("R.CYL", data.get("cylinder_od", "") if data else "", 65)
    ax_od = create_nav_field("R.AX", data.get("axis_od", "") if data else "", 55)

    sph_os = create_nav_field("L.SPH", data.get("sphere_os", "") if data else "", 65)
    cyl_os = create_nav_field("L.CYL", data.get("cylinder_os", "") if data else "", 65)
    ax_os = create_nav_field("L.AX", data.get("axis_os", "") if data else "", 55)

    ipd = create_nav_field("IPD", data.get("ipd", "") if data else "", 55)

    lens_info = ft.Dropdown(
        label=_("Lens Type"),
        options=[ft.dropdown.Option(lt["name"], lt["name"]) for lt in lens_types],
        value=data.get("lens_info", "") if data else "",
        width=180,
        dense=True,
    )

    frame_info = ft.Dropdown(
        label=_("Frame"),
        options=[ft.dropdown.Option(p["name"], f"{p['name']}") for p in frame_products],
        value=data.get("frame_info", "").split(" (")[0] if data and data.get("frame_info") else "",
        width=180,
        dense=True,
    )

    frame_color = ft.Dropdown(
        label=_("Color"),
        options=[ft.dropdown.Option(c["name"], c["name"]) for c in frame_colors],
        value=data.get("frame_color", "") if data else "",
        width=120,
        dense=True,
    )

    frame_status = ft.Dropdown(
        label=_("Status"),
        options=[
            ft.dropdown.Option("New", _("New")),
            ft.dropdown.Option("Old", _("Old")),
        ],
        value=data.get("frame_status", "New") if data else "New",
        width=80,
        dense=True,
    )

    image_path_ref = {"path": data.get("image_path", "") if data else ""}
    image_indicator = ft.Icon(
        ft.icons.IMAGE if not image_path_ref["path"] else ft.icons.CHECK_CIRCLE,
        color=TEXT_FAINT if not image_path_ref["path"] else SUCCESS,
        size=20,
    )

    def pick_image(_e):
        def on_result(result: ft.FilePickerResultEvent):
            if result.files and len(result.files) > 0:
                image_path_ref["path"] = result.files[0].path
                image_indicator.name = ft.icons.CHECK_CIRCLE
                image_indicator.color = SUCCESS
                show_success(page, f"✓ {_('Image attached')}: {result.files[0].name}")

        file_picker = ft.FilePicker(on_result=on_result)
        page.overlay.append(file_picker)
        page.update()
        file_picker.pick_files(
            allowed_extensions=["png", "jpg", "jpeg", "gif", "bmp"],
            dialog_title=_("Select Prescription Image"),
        )

    attach_btn = ft.IconButton(
        ft.icons.ATTACH_FILE,
        icon_color=BRAND_PRIMARY,
        tooltip=_("Attach Image"),
        on_click=pick_image,
    )

    def remove_row(_e):
        if len(controller.exam_rows_container.controls) > 1:
            if row_container in controller.exam_rows_container.controls:
                controller.exam_rows_container.controls.remove(row_container)
                page.update()

    row_container = ft.Container(
        content=ft.Row([
            exam_type,
            ft.VerticalDivider(width=1),
            sph_od, cyl_od, ax_od,
            ft.Container(width=5),
            sph_os, cyl_os, ax_os,
            ipd,
            ft.VerticalDivider(width=1),
            lens_info,
            frame_info,
            frame_color,
            frame_status,
            ft.VerticalDivider(width=1),
            attach_btn,
            image_indicator,
            ft.IconButton(ft.icons.DELETE, icon_color=DANGER, on_click=remove_row, tooltip=_("Remove")),
        ], scroll=ft.ScrollMode.AUTO, spacing=5, vertical_alignment=ft.CrossAxisAlignment.CENTER),
        border=ft.border.all(1, BRAND_PRIMARY_FAINT),
        border_radius=8,
        padding=ft.padding.symmetric(horizontal=10, vertical=5),
        bgcolor=BRAND_PRIMARY_BG,
    )

    row_container.data = {
        "exam_type": exam_type,
        "sph_od": sph_od, "cyl_od": cyl_od, "ax_od": ax_od,
        "sph_os": sph_os, "cyl_os": cyl_os, "ax_os": ax_os,
        "ipd": ipd, "lens_info": lens_info, "frame_info": frame_info,
        "frame_color": frame_color, "frame_status": frame_status,
        "image_path": image_path_ref,
    }

    controller.exam_rows_container.controls.append(row_container)
    page.update()


def save_exams_and_proceed(controller):
    """Collect exam-row data, create cart entries for new frames, advance to Step 4."""
    controller.doctor_name = controller.doctor_name_input.value or ""
    controller.examinations = []

    for row in controller.exam_rows_container.controls:
        if not hasattr(row, "data"):
            continue
        d = row.data
        exam = {
            "exam_type": d["exam_type"].value or "Distance",
            "sphere_od": d["sph_od"].value or "",
            "cylinder_od": d["cyl_od"].value or "",
            "axis_od": d["ax_od"].value or "",
            "sphere_os": d["sph_os"].value or "",
            "cylinder_os": d["cyl_os"].value or "",
            "axis_os": d["ax_os"].value or "",
            "ipd": d["ipd"].value or "",
            "lens_info": d["lens_info"].value or "",
            "frame_info": d["frame_info"].value or "",
            "frame_color": d["frame_color"].value or "",
            "frame_status": d["frame_status"].value or "New",
            "doctor_name": controller.doctor_name,
            "image_path": d["image_path"]["path"] if d.get("image_path") else "",
        }
        controller.examinations.append(exam)

        # If the frame is a "New" frame, ensure it's in the cart.
        if exam["frame_status"] == "New" and exam["frame_info"]:
            frame_name = exam["frame_info"].split(" (")[0]
            inventory = controller.repo.get_inventory(category="Frame")
            frame_product = next(
                (p for p in inventory if p.get("name", "").lower() == frame_name.lower()),
                None,
            )
            if not frame_product:
                frame_product = controller.repo.create_frame_product_if_needed(frame_name)

            if frame_product:
                already_in_cart = any(
                    item["product_id"] == frame_product["id"] for item in controller.cart_items
                )
                if not already_in_cart:
                    controller.cart_items.append({
                        "product_id": frame_product["id"],
                        "name": frame_product.get("name", frame_name),
                        "qty": 1,
                        "unit_price": float(frame_product.get("sale_price", 0)),
                        "total_price": float(frame_product.get("sale_price", 0)),
                    })

        # Make sure any newly-typed lens type is registered.
        if exam["lens_info"]:
            controller.repo.ensure_lens_type_exists(exam["lens_info"])

    controller.show_step_4()
