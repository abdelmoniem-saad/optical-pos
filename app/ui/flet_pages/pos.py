import flet as ft
from app.core.i18n import _
import datetime


def POSView(page: ft.Page, repo):
    """POS View factory function that returns a ft.View"""
    pos = _POSController(page, repo)
    return pos.view


class _POSController:
    """
    Point of Sale (POS) System for Optical Shop.

    Complete ordering flow ported from the PyQt architecture:
    Step 0: Category Selection (Glasses, Sunglasses, Contact Lenses, Accessories, Others)
    Step 1: Customer Selection (Search & select existing or create new)
    Step 2: Order & Examination (for Glasses/Contact Lenses - supports multiple exams)
    Step 3: Additional Items (Add accessories, other products to the order)
    Step 4: Items & Cart Summary + Payment
    Step 5: Print Preview & Finalize
    """

    def __init__(self, page: ft.Page, repo):
        self._page = page
        self.repo = repo
        
        # Order State
        self.current_step = 0
        self.selected_category = None
        self.selected_customer = None
        self.cart_items = []
        self.examinations = []  # List of examination data (supports multiple)
        self.examination_data = {}  # Current examination being edited
        self.totals = {
            "gross_total": 0.0,
            "discount": 0.0,
            "net_amount": 0.0,
            "amount_paid": 0.0,
            "balance": 0.0
        }
        self.invoice_no = None
        self.order_date = datetime.date.today()
        self.delivery_date = datetime.date.today() + datetime.timedelta(days=3)
        self.doctor_name = ""

        # UI Components
        self.app_bar = ft.AppBar(
            title=ft.Text(_("Sales POS")),
            bgcolor=ft.colors.BLUE_700,
            color=ft.colors.WHITE,
            leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: self._page.go("/"))
        )
        
        self.content_area = ft.Container(expand=True, padding=20)

        # Create the view
        self.view = ft.View(
            route="/pos",
            padding=0,
            spacing=0,
            controls=[self.app_bar, self.content_area]
        )

        self.show_step_0()

    # ==================== STEP 0: CATEGORY SELECTION ====================
    def show_step_0(self):
        """Step 0: Select transaction category."""
        self.current_step = 0
        categories = [
            (_("Glasses"), "Frame", ft.icons.REMOVE_RED_EYE, "#1976d2"),
            (_("Sunglasses"), "Sunglasses", ft.icons.WB_SUNNY, "#388e3c"),
            (_("Contact Lenses"), "ContactLens", ft.icons.BLUR_ON, "#0288d1"),
            (_("Accessories"), "Accessory", ft.icons.DASHBOARD_CUSTOMIZE, "#f57c00"),
            (_("Others"), "Other", ft.icons.MORE_HORIZ, "#7b1fa2")
        ]
        
        grid = ft.ResponsiveRow(
            [
                ft.Container(
                    content=ft.Column([
                        ft.Icon(icon, size=60, color=ft.colors.WHITE),
                        ft.Text(label, size=20, weight=ft.FontWeight.BOLD, color=ft.colors.WHITE)
                    ], alignment=ft.MainAxisAlignment.CENTER, horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                    padding=30,
                    border_radius=15,
                    bgcolor=color,
                    on_click=lambda e, cat=val: self.start_with_category(cat),
                    col={"xs": 6, "sm": 4, "md": 4, "lg": 2.4},
                    height=180,
                ) for label, val, icon, color in categories
            ],
            alignment=ft.MainAxisAlignment.CENTER,
            spacing=20,
            run_spacing=20
        )
        
        self.content_area.content = ft.Column([
            ft.Text(_("Select Product Category"), size=32, weight=ft.FontWeight.BOLD),
            ft.Divider(height=30),
            grid
        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=20)
        self._page.update()

    def start_with_category(self, category):
        """User selected a category, proceed to customer selection."""
        self.selected_category = category
        self.show_step_1()

    # ==================== STEP 1: CUSTOMER SELECTION ====================
    def show_step_1(self):
        """Step 1: Search and select or create customer."""
        self.current_step = 1
        
        # Customer input fields
        self.c_name = ft.TextField(label=_("Name") + " *", expand=True, autofocus=True)
        self.c_phone = ft.TextField(label=_("Mobile Phone"), expand=True)
        self.c_phone2 = ft.TextField(label=_("Second Number"), expand=True)
        self.c_city = ft.TextField(label=_("City Name"), expand=True)
        self.c_email = ft.TextField(label=_("Email"), expand=True)
        self.c_address = ft.TextField(label=_("Address"), expand=True)

        # Debounced search
        def on_field_change(e):
            self.perform_customer_search()

        for field in [self.c_name, self.c_phone, self.c_phone2, self.c_city]:
            field.on_change = on_field_change

        self.customer_results = ft.ListView(expand=True, spacing=5)

        # Navigation buttons - always visible
        nav_buttons = ft.Container(
            content=ft.Row([
                ft.ElevatedButton(
                    _("← Back"),
                    icon=ft.icons.ARROW_BACK,
                    on_click=lambda _: self.show_step_0()
                ),
                ft.ElevatedButton(
                    _("Walk-in (No Customer) →"),
                    icon=ft.icons.PERSON_OFF,
                    bgcolor=ft.colors.ORANGE_700,
                    color=ft.colors.WHITE,
                    on_click=lambda _: self.go_to_next_step(None)
                ),
                ft.ElevatedButton(
                    _("Continue with Customer →"),
                    icon=ft.icons.ARROW_FORWARD,
                    bgcolor=ft.colors.GREEN_700,
                    color=ft.colors.WHITE,
                    on_click=lambda _: self.validate_and_proceed_customer()
                )
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
            padding=ft.Padding.only(top=10),
            bgcolor=ft.colors.SURFACE_VARIANT,
            border_radius=10
        )

        self.content_area.content = ft.Column([
            # Header
            ft.Text(_("Step 1: Customer Selection"), size=24, weight=ft.FontWeight.BOLD),
            ft.Text(_("Enter customer information or select from search results below."), color=ft.colors.GREY_700),
            ft.Divider(height=10),

            # Customer Form
            ft.ResponsiveRow([
                ft.Container(self.c_name, col={"xs": 12, "md": 6}),
                ft.Container(self.c_phone, col={"xs": 12, "md": 6}),
                ft.Container(self.c_phone2, col={"xs": 12, "md": 6}),
                ft.Container(self.c_city, col={"xs": 12, "md": 6}),
            ]),

            # Search Results
            ft.Text(_("Matching Customers:"), size=14, weight=ft.FontWeight.BOLD),
            ft.Container(
                content=self.customer_results,
                border=ft.Border.all(1, ft.colors.GREY_300),
                border_radius=10,
                padding=5,
                height=200
            ),

            # Navigation Buttons
            nav_buttons
        ], spacing=10, expand=True)

        # Don't load customers initially - wait for user to type
        self.customer_results.controls.append(
            ft.Container(
                ft.Text(_("Start typing to search for existing customers..."), italic=True, color=ft.colors.GREY_500),
                padding=20
            )
        )
        self._page.update()

    def perform_customer_search(self):
        """Search customers by name, phone, city."""
        self.customer_results.controls.clear()

        # Build search term from filled fields
        terms = []
        if self.c_name.value and self.c_name.value.strip():
            terms.append(self.c_name.value.strip())
        if self.c_phone.value and self.c_phone.value.strip():
            terms.append(self.c_phone.value.strip())
        if self.c_city.value and self.c_city.value.strip():
            terms.append(self.c_city.value.strip())

        # If no search term, show prompt
        if not terms:
            self.customer_results.controls.append(
                ft.Container(
                    ft.Text(_("Start typing to search for existing customers..."), italic=True, color=ft.colors.GREY_500),
                    padding=20
                )
            )
            self._page.update()
            return

        search_term = " ".join(terms)
        customers = self.repo.search_customers(search_term)

        # Remove duplicates by customer ID
        seen_ids = set()
        unique_customers = []
        for c in customers:
            cid = c.get("id")
            if cid and cid not in seen_ids:
                seen_ids.add(cid)
                unique_customers.append(c)

        customers = unique_customers[:10]  # Limit to 10 results

        if not customers:
            self.customer_results.controls.append(
                ft.Container(
                    ft.Column([
                        ft.Icon(ft.icons.PERSON_ADD, size=40, color=ft.colors.GREY_400),
                        ft.Text(_("No matching customers found."), color=ft.colors.GREY_700),
                        ft.Text(_("A new customer will be created when you continue."), italic=True, size=12, color=ft.colors.GREY_500),
                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=5),
                    padding=20
                )
            )
        else:
            for c in customers:
                self.customer_results.controls.append(
                    ft.ListTile(
                        leading=ft.Icon(ft.icons.PERSON, color=ft.colors.BLUE_700),
                        title=ft.Text(c.get("name", _("Unknown")), weight=ft.FontWeight.BOLD),
                        subtitle=ft.Text(f"📱 {c.get('phone', 'N/A')} | 📍 {c.get('city', 'N/A')}"),
                        trailing=ft.Icon(ft.icons.TOUCH_APP, color=ft.colors.GREEN_700),
                        on_click=lambda e, cust=c: self.select_existing_customer(cust),
                        bgcolor=ft.colors.BLUE_50
                    )
                )
        self._page.update()

    def select_existing_customer(self, customer):
        """User clicked on an existing customer."""
        self.c_name.value = customer.get("name", "")
        self.c_phone.value = customer.get("phone", "")
        self.c_phone2.value = customer.get("phone2", "")
        self.c_city.value = customer.get("city", "")
        self.c_email.value = customer.get("email", "")
        self.c_address.value = customer.get("address", "")
        self.selected_customer = customer
        self._page.update()

        # Show confirmation
        self._page.snack_bar = ft.SnackBar(ft.Text(f"✓ {_('Selected')}: {customer.get('name')}"))
        self._page.snack_bar.open = True
        self._page.update()

    def validate_and_proceed_customer(self):
        """Validate customer data and proceed to next step."""
        name = self.c_name.value.strip() if self.c_name.value else ""

        if not name:
            self._page.snack_bar = ft.SnackBar(ft.Text(_("Please enter customer name.")))
            self._page.snack_bar.open = True
            self._page.update()
            return

        # If no customer selected, create new one
        if not self.selected_customer or self.selected_customer.get("name") != name:
            customer_data = {
                "name": name,
                "phone": self.c_phone.value.strip() if self.c_phone.value else "",
                "phone2": self.c_phone2.value.strip() if self.c_phone2.value else "",
                "city": self.c_city.value.strip() if self.c_city.value else "",
                "email": self.c_email.value.strip() if self.c_email.value else "",
                "address": self.c_address.value.strip() if self.c_address.value else ""
            }
            self.selected_customer = self.repo.add_customer(customer_data)

        self.go_to_next_step(self.selected_customer)

    def go_to_next_step(self, customer):
        """Proceed to next step after customer selection."""
        self.selected_customer = customer

        # Generate invoice number
        self.invoice_no = self.repo.get_next_invoice_no()

        # For Glasses/Contact Lenses, show examination form
        # For other categories, go directly to items
        if self.selected_category in ["Frame", "ContactLens"]:
            self.show_step_2()
        else:
            self.show_step_4()

    # ==================== STEP 2: ORDER & EXAMINATION ====================
    def show_step_2(self):
        """Step 2: Enter optical examination data (Glasses/Contact Lenses only)."""
        self.current_step = 2
        customer_name = self.selected_customer.get("name", "") if self.selected_customer else _("Walk-in Customer")
        
        # Date inputs
        self.order_date_picker = ft.TextField(
            label=_("Order Date"),
            value=self.order_date.strftime("%Y-%m-%d"),
            read_only=True,
            width=140,
            dense=True
        )
        self.delivery_date_picker = ft.TextField(
            label=_("Delivery Date"),
            value=self.delivery_date.strftime("%Y-%m-%d"),
            width=140,
            dense=True
        )
        self.doctor_name_input = ft.TextField(label=_("Doctor Name"), value=self.doctor_name, expand=True, dense=True)

        # Examination table (supports multiple rows)
        self.exam_rows_container = ft.Column([], spacing=8)

        # Add first exam row
        if not self.examinations:
            self.add_exam_row()
        else:
            for exam in self.examinations:
                self.add_exam_row(exam)

        # --- Past Prescriptions Side Panel ---
        past_exams = []
        past_exams_count = 0
        if self.selected_customer:
            past_exams = self.repo.get_customer_past_examinations(self.selected_customer.get("id"))
            past_exams_count = len(past_exams)

        def build_past_exams_panel():
            """Build the past examinations panel content."""
            panel_content = []

            if not past_exams:
                panel_content.append(
                    ft.Container(
                        ft.Column([
                            ft.Icon(ft.icons.HISTORY, size=40, color=ft.colors.GREY_400),
                            ft.Text(_("No previous prescriptions"), color=ft.colors.GREY_500)
                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                        padding=30
                    )
                )
            else:
                for exam in past_exams:
                    exam_date = exam.get("sale", {}).get("order_date", "")[:10] if exam.get("sale") else _("N/A")
                    invoice_no = exam.get("sale", {}).get("invoice_no", "") if exam.get("sale") else ""

                    # Build eye info string
                    od_info = f"OD: {exam.get('sphere_od', '-')}/{exam.get('cylinder_od', '-')}x{exam.get('axis_od', '-')}"
                    os_info = f"OS: {exam.get('sphere_os', '-')}/{exam.get('cylinder_os', '-')}x{exam.get('axis_os', '-')}"

                    panel_content.append(
                        ft.Container(
                            ft.Column([
                                ft.Row([
                                    ft.Icon(ft.icons.CALENDAR_TODAY, size=14, color=ft.colors.BLUE_700),
                                    ft.Text(exam_date, weight=ft.FontWeight.BOLD, size=13),
                                    ft.Container(expand=True),
                                    ft.Text(f"#{invoice_no}", size=11, color=ft.colors.GREY_600) if invoice_no else ft.Container(),
                                ]),
                                ft.Text(f"{exam.get('exam_type', 'N/A')}", size=12, color=ft.colors.BLUE_700, weight=ft.FontWeight.W_500),
                                ft.Text(od_info, size=11),
                                ft.Text(os_info, size=11),
                                ft.Text(f"IPD: {exam.get('ipd', '-')}", size=11),
                                ft.Divider(height=5),
                                ft.Text(f"🔍 {exam.get('lens_info', '-')}", size=11, color=ft.colors.GREY_700),
                                ft.Text(f"🖼️ {exam.get('frame_info', '-')} ({exam.get('frame_color', '-')})", size=11, color=ft.colors.GREY_700),
                                ft.ElevatedButton(
                                    _("Use this"),
                                    icon=ft.icons.COPY,
                                    on_click=lambda e, ex=exam: use_past_exam(ex),
                                    style=ft.ButtonStyle(
                                        bgcolor=ft.colors.BLUE_700,
                                        color=ft.colors.WHITE,
                                    ),
                                    height=30
                                )
                            ], spacing=3),
                            bgcolor=ft.colors.WHITE,
                            border=ft.Border.all(1, ft.colors.BLUE_200),
                            border_radius=8,
                            padding=10,
                            margin=ft.Margin.only(bottom=8)
                        )
                    )
            return panel_content

        def use_past_exam(exam):
            """Use a past examination - add it as a new row."""
            self.add_exam_row(exam)
            self._page.snack_bar = ft.SnackBar(ft.Text(f"✓ {_('Past examination loaded')}"))
            self._page.snack_bar.open = True
            # Close the drawer
            if hasattr(self, 'past_rx_drawer'):
                self.past_rx_drawer.open = False
            self._page.update()

        def show_past_prescriptions(e):
            """Show the past prescriptions in a bottom sheet / end drawer."""
            self.past_rx_drawer = ft.BottomSheet(
                content=ft.Container(
                    ft.Column([
                        ft.Row([
                            ft.Icon(ft.icons.HISTORY, color=ft.colors.BLUE_700),
                            ft.Text(_("Previous Prescriptions"), size=18, weight=ft.FontWeight.BOLD),
                            ft.Container(expand=True),
                            ft.IconButton(ft.icons.CLOSE, on_click=lambda e: close_drawer())
                        ]),
                        ft.Text(f"{customer_name}", size=14, color=ft.colors.GREY_700),
                        ft.Divider(),
                        ft.Column(
                            build_past_exams_panel(),
                            scroll=ft.ScrollMode.AUTO,
                            expand=True
                        )
                    ], expand=True),
                    padding=20,
                    width=400,
                    height=500,
                ),
                open=True,
                enable_drag=True,
            )
            self._page.overlay.append(self.past_rx_drawer)
            self._page.update()

        def close_drawer():
            if hasattr(self, 'past_rx_drawer'):
                self.past_rx_drawer.open = False
                self._page.update()

        # Button to show past prescriptions
        past_rx_button = ft.ElevatedButton(
            f"{_('Previous Prescriptions')} ({past_exams_count})" if past_exams_count > 0 else _("No Previous Prescriptions"),
            icon=ft.icons.HISTORY,
            on_click=show_past_prescriptions if past_exams_count > 0 else None,
            disabled=past_exams_count == 0,
            bgcolor=ft.colors.BLUE_100 if past_exams_count > 0 else ft.colors.GREY_200,
            color=ft.colors.BLUE_900 if past_exams_count > 0 else ft.colors.GREY_500,
        )

        # Main content
        self.content_area.content = ft.Column([
            # Header row with customer info and past Rx button
            ft.Row([
                ft.Column([
                    ft.Text(_("Step 2: Order & Examination"), size=22, weight=ft.FontWeight.BOLD),
                    ft.Row([
                        ft.Icon(ft.icons.PERSON, size=16, color=ft.colors.BLUE_700),
                        ft.Text(customer_name, size=14, weight=ft.FontWeight.W_500),
                        ft.Container(width=20),
                        ft.Icon(ft.icons.RECEIPT, size=16, color=ft.colors.GREEN_700),
                        ft.Text(f"#{self.invoice_no}", size=14, color=ft.colors.GREEN_700),
                    ])
                ], expand=True),
                past_rx_button,
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),

            ft.Divider(height=10),

            # Date and Doctor row
            ft.Row([
                self.order_date_picker,
                self.delivery_date_picker,
                self.doctor_name_input,
            ], spacing=10),

            ft.Divider(height=10),

            # Examination rows
            ft.Text(_("Examination Details"), size=16, weight=ft.FontWeight.BOLD),
            self.exam_rows_container,

            ft.Row([
                ft.ElevatedButton(
                    _("+ Add Another Exam"),
                    icon=ft.icons.ADD,
                    on_click=lambda _: self.add_exam_row(),
                    bgcolor=ft.colors.BLUE_50,
                    color=ft.colors.BLUE_900
                ),
            ]),

            ft.Divider(height=10),

            # Navigation buttons
            ft.Row([
                ft.ElevatedButton(_("← Back"), icon=ft.icons.ARROW_BACK, on_click=lambda _: self.show_step_1()),
                ft.ElevatedButton(
                    _("Add More Items"),
                    icon=ft.icons.SHOPPING_CART,
                    bgcolor=ft.colors.ORANGE_700,
                    color=ft.colors.WHITE,
                    on_click=lambda _: self.show_step_3()
                ),
                ft.ElevatedButton(
                    _("Next: Payment →"),
                    icon=ft.icons.ARROW_FORWARD,
                    bgcolor=ft.colors.GREEN_700,
                    color=ft.colors.WHITE,
                    on_click=lambda _: self.save_exams_and_proceed()
                )
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN)
        ], scroll=ft.ScrollMode.AUTO, spacing=8, expand=True)
        self._page.update()

    def add_exam_row(self, data=None):
        """Add an examination row to the form."""
        row_index = len(self.exam_rows_container.controls)

        # Get metadata for dropdowns
        lens_types = self.repo.get_lens_types()
        frame_colors = self.repo.get_frame_colors()
        frame_products = self.repo.get_inventory(category="Frame")

        # Store all text fields for navigation
        field_list = []

        def create_nav_field(label, value, width):
            """Create a text field with Enter/Tab navigation."""
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
            """Move focus to next field and select its text."""
            try:
                idx = field_list.index(current_field)
                if idx < len(field_list) - 1:
                    next_field = field_list[idx + 1]
                    next_field.focus()
                    # Select all text in the next field
                    if next_field.value:
                        next_field.selection = ft.TextSelection(0, len(next_field.value))
                    self._page.update()
            except (ValueError, IndexError):
                pass

        exam_type = ft.Dropdown(
            label=_("Exam Type"),
            options=[
                ft.dropdown.Option("Distance", _("Distance")),
                ft.dropdown.Option("Reading", _("Reading")),
                ft.dropdown.Option("Contact Lenses", _("Contact Lenses"))
            ],
            value=data.get("exam_type", "Distance") if data else "Distance",
            width=120,
            dense=True
        )

        # Right Eye (OD) - compact with navigation
        sph_od = create_nav_field("R.SPH", data.get("sphere_od", "") if data else "", 65)
        cyl_od = create_nav_field("R.CYL", data.get("cylinder_od", "") if data else "", 65)
        ax_od = create_nav_field("R.AX", data.get("axis_od", "") if data else "", 55)

        # Left Eye (OS) - compact with navigation
        sph_os = create_nav_field("L.SPH", data.get("sphere_os", "") if data else "", 65)
        cyl_os = create_nav_field("L.CYL", data.get("cylinder_os", "") if data else "", 65)
        ax_os = create_nav_field("L.AX", data.get("axis_os", "") if data else "", 55)

        ipd = create_nav_field("IPD", data.get("ipd", "") if data else "", 55)

        # Lens type - increased width
        lens_options = [ft.dropdown.Option(lt["name"], lt["name"]) for lt in lens_types]
        lens_info = ft.Dropdown(
            label=_("Lens Type"),
            options=lens_options,
            value=data.get("lens_info", "") if data else "",
            width=180,
            dense=True
        )

        # Frame selection - increased width
        frame_options = [ft.dropdown.Option(p["name"], f"{p['name']}") for p in frame_products]
        frame_info = ft.Dropdown(
            label=_("Frame"),
            options=frame_options,
            value=data.get("frame_info", "").split(" (")[0] if data and data.get("frame_info") else "",
            width=180,
            dense=True
        )

        # Frame color - increased width
        color_options = [ft.dropdown.Option(c["name"], c["name"]) for c in frame_colors]
        frame_color = ft.Dropdown(
            label=_("Color"),
            options=color_options,
            value=data.get("frame_color", "") if data else "",
            width=120,
            dense=True
        )

        frame_status = ft.Dropdown(
            label=_("Status"),
            options=[
                ft.dropdown.Option("New", _("New")),
                ft.dropdown.Option("Old", _("Old"))
            ],
            value=data.get("frame_status", "New") if data else "New",
            width=80,
            dense=True
        )

        # Image attachment
        image_path_ref = {"path": data.get("image_path", "") if data else ""}
        image_indicator = ft.Icon(
            ft.icons.IMAGE if not image_path_ref["path"] else ft.icons.CHECK_CIRCLE,
            color=ft.colors.GREY_500 if not image_path_ref["path"] else ft.colors.GREEN_700,
            size=20
        )

        def pick_image(e):
            def on_result(result: ft.FilePickerResultEvent):
                if result.files and len(result.files) > 0:
                    image_path_ref["path"] = result.files[0].path
                    image_indicator.name = ft.icons.CHECK_CIRCLE
                    image_indicator.color = ft.colors.GREEN_700
                    self._page.snack_bar = ft.SnackBar(ft.Text(f"✓ {_('Image attached')}: {result.files[0].name}"))
                    self._page.snack_bar.open = True
                    self._page.update()

            file_picker = ft.FilePicker(on_result=on_result)
            self._page.overlay.append(file_picker)
            self._page.update()
            file_picker.pick_files(
                allowed_extensions=["png", "jpg", "jpeg", "gif", "bmp"],
                dialog_title=_("Select Prescription Image")
            )

        attach_btn = ft.IconButton(
            ft.icons.ATTACH_FILE,
            icon_color=ft.colors.BLUE_700,
            tooltip=_("Attach Image"),
            on_click=pick_image
        )

        def remove_row(e, idx=row_index):
            if len(self.exam_rows_container.controls) > 1:
                self.exam_rows_container.controls.pop(idx)
                self._page.update()

        # Single compact row layout
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
                ft.IconButton(ft.icons.DELETE, icon_color=ft.colors.RED_700, on_click=remove_row, tooltip=_("Remove"))
            ], scroll=ft.ScrollMode.AUTO, spacing=5, vertical_alignment=ft.CrossAxisAlignment.CENTER),
            border=ft.Border.all(1, ft.colors.BLUE_200),
            border_radius=8,
            padding=ft.Padding.symmetric(horizontal=10, vertical=5),
            bgcolor=ft.colors.BLUE_50
        )

        # Store references for later retrieval
        row_container.data = {
            "exam_type": exam_type,
            "sph_od": sph_od, "cyl_od": cyl_od, "ax_od": ax_od,
            "sph_os": sph_os, "cyl_os": cyl_os, "ax_os": ax_os,
            "ipd": ipd, "lens_info": lens_info, "frame_info": frame_info,
            "frame_color": frame_color, "frame_status": frame_status,
            "image_path": image_path_ref
        }

        self.exam_rows_container.controls.append(row_container)
        self._page.update()

    def save_exams_and_proceed(self):
        """Save examination data from all rows and proceed to payment."""
        self.doctor_name = self.doctor_name_input.value or ""
        self.examinations = []

        for row in self.exam_rows_container.controls:
            if hasattr(row, 'data'):
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
                    "doctor_name": self.doctor_name,
                    "image_path": d["image_path"]["path"] if d.get("image_path") else ""
                }
                self.examinations.append(exam)

                # Add frame to cart if it's a "New" frame
                if exam["frame_status"] == "New" and exam["frame_info"]:
                    frame_name = exam["frame_info"].split(" (")[0]
                    frame_product = None

                    # Find or create frame product
                    inventory = self.repo.get_inventory(category="Frame")
                    for p in inventory:
                        if p.get("name", "").lower() == frame_name.lower():
                            frame_product = p
                            break

                    if not frame_product:
                        frame_product = self.repo.create_frame_product_if_needed(frame_name)

                    if frame_product:
                        # Check if already in cart
                        existing = next((item for item in self.cart_items if item["product_id"] == frame_product["id"]), None)
                        if not existing:
                            self.cart_items.append({
                                "product_id": frame_product["id"],
                                "name": frame_product.get("name", frame_name),
                                "qty": 1,
                                "unit_price": float(frame_product.get("sale_price", 0)),
                                "total_price": float(frame_product.get("sale_price", 0))
                            })

                # Ensure lens type exists in metadata
                if exam["lens_info"]:
                    self.repo.ensure_lens_type_exists(exam["lens_info"])

        self.show_step_4()

    # ==================== STEP 3: ADDITIONAL ITEMS ====================
    def show_step_3(self):
        """Step 3: Add additional items to the order (optional)."""
        self.current_step = 3

        # Category filter for additional items
        category_options = [
            ft.dropdown.Option("All", _("All Categories")),
            ft.dropdown.Option("Frame", _("Frames")),
            ft.dropdown.Option("Sunglasses", _("Sunglasses")),
            ft.dropdown.Option("Accessory", _("Accessories")),
            ft.dropdown.Option("Other", _("Others"))
        ]

        self.add_item_category = ft.Dropdown(
            label=_("Category"),
            options=category_options,
            value="All",
            width=200,
            on_change=lambda e: self.load_additional_products()
        )

        self.add_item_search = ft.TextField(
            label=_("Search products..."),
            prefix_icon=ft.icons.SEARCH,
            expand=True,
            on_change=lambda e: self.load_additional_products()
        )

        self.additional_products_list = ft.ListView(expand=True, spacing=5)

        # Navigation buttons - always visible at bottom
        nav_buttons = ft.Container(
            content=ft.Row([
                ft.ElevatedButton(
                    _("← Back to Examination"),
                    icon=ft.icons.ARROW_BACK,
                    on_click=lambda _: self.show_step_2()
                ),
                ft.ElevatedButton(
                    _("Continue to Payment →"),
                    icon=ft.icons.PAYMENT,
                    bgcolor=ft.colors.GREEN_700,
                    color=ft.colors.WHITE,
                    on_click=lambda _: self.save_exams_and_proceed()
                )
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
            bgcolor=ft.colors.GREY_100,
            padding=15,
            border_radius=10
        )

        self.content_area.content = ft.Column([
            ft.Text(_("Step 3: Add More Items"), size=24, weight=ft.FontWeight.BOLD),
            ft.Text(_("Add accessories or other products to this order"), color=ft.colors.GREY_700),
            ft.Divider(height=10),
            ft.Row([self.add_item_category, self.add_item_search]),
            ft.Text(_("Available Products:"), size=14, weight=ft.FontWeight.BOLD),
            ft.Container(
                content=self.additional_products_list,
                height=350,
                border=ft.Border.all(1, ft.colors.GREY_300),
                border_radius=8,
                padding=5
            ),
            ft.Divider(height=10),
            nav_buttons
        ], spacing=10, expand=True)

        self.load_additional_products()
        self._page.update()

    def load_additional_products(self):
        """Load products for additional items selection."""
        self.additional_products_list.controls.clear()

        category = self.add_item_category.value if self.add_item_category.value != "All" else None
        search_term = self.add_item_search.value if self.add_item_search.value else None

        products = self.repo.get_inventory(category=category, search_term=search_term)

        for p in products:
            stock = p.get("stock_qty", 0)
            self.additional_products_list.controls.append(
                ft.ListTile(
                    leading=ft.Icon(ft.icons.INVENTORY_2),
                    title=ft.Text(f"{p.get('name', 'Unknown')} ({p.get('sku', '')})"),
                    subtitle=ft.Text(f"{_('Price')}: {p.get('sale_price', 0):.2f} | {_('Stock')}: {stock}"),
                    trailing=ft.IconButton(
                        ft.icons.ADD_SHOPPING_CART,
                        tooltip=_("Add to Cart"),
                        on_click=lambda e, prod=p: self.add_product_to_cart_from_list(prod)
                    ),
                )
            )
        self._page.update()

    def add_product_to_cart_from_list(self, product):
        """Add a product to the cart from the additional items list."""
        existing = next((item for item in self.cart_items if item["product_id"] == product["id"]), None)
        if existing:
            existing["qty"] += 1
            existing["total_price"] = existing["qty"] * existing["unit_price"]
        else:
            self.cart_items.append({
                "product_id": product["id"],
                "name": product.get("name", ""),
                "qty": 1,
                "unit_price": float(product.get("sale_price", 0)),
                "total_price": float(product.get("sale_price", 0))
            })

        self._page.snack_bar = ft.SnackBar(ft.Text(f"✓ {product.get('name')} {_('added to cart')}"))
        self._page.snack_bar.open = True
        self._page.update()

    # ==================== STEP 4: ITEMS & CART ====================
    def show_step_4(self):
        """Step 4: Cart summary and payment details."""
        self.current_step = 4
        customer_name = self.selected_customer.get("name", _("Walk-in")) if self.selected_customer else _("Walk-in")

        product_search = ft.TextField(
            label=_("Quick add by SKU or name..."),
            prefix_icon=ft.icons.SEARCH,
            expand=True,
            on_submit=lambda e: self.add_product_to_cart(e.control.value)
        )
        
        self.cart_table = ft.DataTable(
            columns=[
                ft.DataColumn(ft.Text(_("Product"))),
                ft.DataColumn(ft.Text(_("Qty")), numeric=True),
                ft.DataColumn(ft.Text(_("Price")), numeric=True),
                ft.DataColumn(ft.Text(_("Total")), numeric=True),
                ft.DataColumn(ft.Text(""))
            ],
            rows=[]
        )

        # Totals inputs
        self.discount_input = ft.TextField(
            label=_("Discount"),
            value=str(self.totals["discount"]),
            width=150,
            on_change=lambda e: self.on_totals_change()
        )

        self.paid_input = ft.TextField(
            label=_("Amount Paid"),
            value=str(self.totals["amount_paid"]),
            width=150,
            on_change=lambda e: self.on_totals_change()
        )

        self.totals_display = ft.Column([], horizontal_alignment=ft.CrossAxisAlignment.END)

        self.update_cart_display()
        self.update_totals_display()

        self.content_area.content = ft.Column([
            ft.Row([
                ft.Text(f"{_('Step 4: Cart & Payment')} - {customer_name}", size=28, weight=ft.FontWeight.BOLD)
            ]),
            ft.Text(f"{_('Invoice')}: {self.invoice_no}", size=14, color=ft.colors.BLUE_700, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            ft.Row([
                product_search,
                ft.IconButton(ft.icons.ADD, on_click=lambda e: self.add_product_to_cart(product_search.value), tooltip=_("Add")),
                ft.ElevatedButton(_("Add More Items"), icon=ft.icons.SHOPPING_CART, on_click=lambda _: self.show_step_3())
            ]),
            ft.Text(_("Shopping Cart:"), size=16, weight=ft.FontWeight.BOLD),
            ft.Container(content=self.cart_table, border=ft.Border.all(1, ft.colors.GREY_300), border_radius=5),
            ft.Divider(),
            ft.ResponsiveRow([
                ft.Container(
                    ft.Column([
                        ft.Text(_("Order Details"), size=16, weight=ft.FontWeight.BOLD),
                        self.discount_input,
                        self.paid_input
                    ]),
                    col=6
                ),
                ft.Container(self.totals_display, col=6)
            ]),
            ft.Divider(),
            ft.Row([
                ft.ElevatedButton(
                    _("← Back"),
                    icon=ft.icons.ARROW_BACK,
                    on_click=lambda _: self.show_step_2() if self.selected_category in ["Frame", "ContactLens"] else self.show_step_1()
                ),
                ft.ElevatedButton(_("Clear Cart"), icon=ft.icons.DELETE_SWEEP, on_click=lambda _: self.clear_cart()),
                ft.ElevatedButton(
                    _("Finish Checkout →"),
                    icon=ft.icons.CHECK_CIRCLE,
                    bgcolor=ft.colors.GREEN_700,
                    color=ft.colors.WHITE,
                    on_click=lambda _: self.finish_order()
                )
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN)
        ], scroll=ft.ScrollMode.AUTO, spacing=10)
        self._page.update()

    def add_product_to_cart(self, search_term):
        """Add product to cart by SKU or name."""
        if not search_term:
            return

        product = self.repo.find_product_by_name_or_sku(search_term)

        if not product:
            self._page.snack_bar = ft.SnackBar(ft.Text(f"{_('Product not found')}: {search_term}"))
            self._page.snack_bar.open = True
            self._page.update()
            return

        existing = next((item for item in self.cart_items if item["product_id"] == product["id"]), None)
        if existing:
            existing["qty"] += 1
            existing["total_price"] = existing["qty"] * existing["unit_price"]
        else:
            self.cart_items.append({
                "product_id": product["id"],
                "name": product.get("name", ""),
                "qty": 1,
                "unit_price": float(product.get("sale_price", 0)),
                "total_price": float(product.get("sale_price", 0))
            })

        self.update_cart_display()
        self.update_totals_display()
        self._page.update()

    def update_cart_display(self):
        """Update cart table display."""
        self.cart_table.rows.clear()

        for item in self.cart_items:
            def make_remove_callback(itm):
                def remove_item(e):
                    self.cart_items.remove(itm)
                    self.update_cart_display()
                    self.update_totals_display()
                    self._page.update()
                return remove_item

            def make_qty_change_callback(itm):
                def change_qty(e, delta):
                    itm["qty"] = max(1, itm["qty"] + delta)
                    itm["total_price"] = itm["qty"] * itm["unit_price"]
                    self.update_cart_display()
                    self.update_totals_display()
                    self._page.update()
                return change_qty

            qty_control = ft.Row([
                ft.IconButton(ft.icons.REMOVE, on_click=lambda e, i=item: make_qty_change_callback(i)(e, -1)),
                ft.Text(str(item["qty"]), weight=ft.FontWeight.BOLD),
                ft.IconButton(ft.icons.ADD, on_click=lambda e, i=item: make_qty_change_callback(i)(e, 1))
            ], tight=True)

            self.cart_table.rows.append(
                ft.DataRow(
                    cells=[
                        ft.DataCell(ft.Text(item["name"])),
                        ft.DataCell(qty_control),
                        ft.DataCell(ft.Text(f"{item['unit_price']:.2f}")),
                        ft.DataCell(ft.Text(f"{item['total_price']:.2f}")),
                        ft.DataCell(ft.IconButton(ft.icons.DELETE, icon_color=ft.colors.RED_700, on_click=make_remove_callback(item))),
                    ]
                )
            )

    def on_totals_change(self):
        """Handle totals input changes."""
        try:
            self.totals["discount"] = float(self.discount_input.value or 0)
            self.totals["amount_paid"] = float(self.paid_input.value or 0)
        except ValueError:
            pass
        self.update_totals_display()

    def update_totals_display(self):
        """Update totals calculation and display."""
        gross = sum(item["total_price"] for item in self.cart_items)
        self.totals["gross_total"] = gross
        self.totals["net_amount"] = gross - self.totals["discount"]
        self.totals["balance"] = self.totals["net_amount"] - self.totals["amount_paid"]

        self.totals_display.controls.clear()
        self.totals_display.controls.extend([
            ft.Row([ft.Text(_("Gross Total"), weight=ft.FontWeight.BOLD), ft.Text(f"{self.totals['gross_total']:.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
            ft.Row([ft.Text(_("Discount"), weight=ft.FontWeight.BOLD), ft.Text(f"- {self.totals['discount']:.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
            ft.Divider(height=10),
            ft.Row([
                ft.Text(_("Net Amount"), size=18, weight=ft.FontWeight.BOLD),
                ft.Text(f"{self.totals['net_amount']:.2f}", size=18, weight=ft.FontWeight.BOLD, color=ft.colors.GREEN_700)
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
            ft.Row([ft.Text(_("Amount Paid"), weight=ft.FontWeight.BOLD), ft.Text(f"{self.totals['amount_paid']:.2f}")], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
            ft.Divider(height=10),
            ft.Row([
                ft.Text(_("Remaining Balance"), size=18, weight=ft.FontWeight.BOLD),
                ft.Text(
                    f"{self.totals['balance']:.2f}",
                    size=18,
                    weight=ft.FontWeight.BOLD,
                    color=ft.colors.RED_700 if self.totals['balance'] > 0 else ft.colors.GREEN_700
                )
            ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ])
        self._page.update()

    def clear_cart(self):
        """Clear all items from the cart."""
        self.cart_items.clear()
        self.update_cart_display()
        self.update_totals_display()
        self._page.update()

    # ==================== CHECKOUT ====================
    def finish_order(self):
        """Finalize the sale: save to database, create stock movements, show receipt."""
        if not self.cart_items and not self.examinations:
            self._page.snack_bar = ft.SnackBar(ft.Text(_("Cart is empty and no examinations. Cannot checkout.")))
            self._page.snack_bar.open = True
            self._page.update()
            return

        try:
            # Prepare sale data
            # Get user ID safely
            user = self._page.data.get("user") if hasattr(self.page, 'data') and self._page.data else None
            user_id = user.get("id") if user else None

            sale_data = {
                "invoice_no": self.invoice_no,
                "customer_id": self.selected_customer.get("id") if self.selected_customer else None,
                "total_amount": self.totals["gross_total"],
                "discount": self.totals["discount"],
                "net_amount": self.totals["net_amount"],
                "amount_paid": self.totals["amount_paid"],
                "payment_method": "Cash",
                "user_id": user_id,
                "doctor_name": self.doctor_name,
                "lab_status": "Not Started" if self.examinations else None,
                "order_date": datetime.datetime.utcnow().isoformat(),
                "delivery_date": self.delivery_date.isoformat() if hasattr(self, 'delivery_date') else None
            }

            # Save sale with items and examinations
            sale_response = self.repo.add_sale(
                sale_data,
                self.cart_items,
                exam_data=None,
                examinations=self.examinations if self.examinations else None
            )

            # Show success and receipt preview
            self.show_receipt_preview(sale_data)

        except Exception as ex:
            self._page.snack_bar = ft.SnackBar(ft.Text(f"{_('Error saving order')}: {str(ex)}"))
            self._page.snack_bar.open = True
            self._page.update()

    def show_receipt_preview(self, sale_data):
        """Show receipt preview dialog with 3 print options: Shop, Customer, Lab."""
        customer_name = self.selected_customer.get("name", _("Walk-in")) if self.selected_customer else _("Walk-in")
        customer_phone = self.selected_customer.get("phone", "") if self.selected_customer else ""
        shop_name = self.repo.get_setting("shop_name", "Optical Shop")
        shop_address = self.repo.get_setting("store_address", "")
        shop_phone = self.repo.get_setting("store_phone", "")
        currency = self.repo.get_setting("currency", "EGP")

        # ========== SHOP COPY (Full Details) ==========
        def build_shop_copy():
            lines = [
                f"{'='*44}",
                f"{'نسخة المحل - SHOP COPY':^44}",
                f"{'='*44}",
                f"{shop_name:^44}",
                f"{shop_address:^44}" if shop_address else "",
                f"{shop_phone:^44}" if shop_phone else "",
                f"{'='*44}",
                f"{_('Invoice')}: #{self.invoice_no}",
                f"{_('Date')}: {datetime.datetime.now().strftime('%d/%m/%Y %H:%M')}",
                f"{_('Delivery Date')}: {self.delivery_date.strftime('%d/%m/%Y') if hasattr(self, 'delivery_date') else 'N/A'}",
                f"{'-'*44}",
                f"{_('Customer')}: {customer_name}",
                f"{_('Phone')}: {customer_phone}" if customer_phone else "",
                f"{_('Doctor')}: {self.doctor_name}" if self.doctor_name else "",
                f"{'-'*44}",
            ]

            # Items
            if self.cart_items:
                lines.append(f"{_('Items')}:")
                for item in self.cart_items:
                    lines.append(f"  {item['name'][:28]:<28} x{item['qty']} {item['total_price']:>8.2f}")

            # Examinations (Full details for shop)
            if self.examinations:
                lines.append(f"{'-'*44}")
                lines.append(f"{_('Examinations')}:")
                for i, exam in enumerate(self.examinations, 1):
                    lines.append(f"  [{i}] {exam.get('exam_type', 'N/A')}")
                    lines.append(f"      OD: {exam.get('sphere_od', '-')}/{exam.get('cylinder_od', '-')}x{exam.get('axis_od', '-')}")
                    lines.append(f"      OS: {exam.get('sphere_os', '-')}/{exam.get('cylinder_os', '-')}x{exam.get('axis_os', '-')}")
                    lines.append(f"      IPD: {exam.get('ipd', '-')}")
                    lines.append(f"      {_('Lens')}: {exam.get('lens_info', '-')}")
                    lines.append(f"      {_('Frame')}: {exam.get('frame_info', '-')} ({exam.get('frame_color', '-')})")

            lines.extend([
                f"{'-'*44}",
                f"{_('Gross Total'):.<30} {self.totals['gross_total']:>10.2f} {currency}",
                f"{_('Discount'):.<30} {self.totals['discount']:>10.2f} {currency}",
                f"{_('Net Amount'):.<30} {self.totals['net_amount']:>10.2f} {currency}",
                f"{_('Amount Paid'):.<30} {self.totals['amount_paid']:>10.2f} {currency}",
                f"{_('Balance'):.<30} {self.totals['balance']:>10.2f} {currency}",
                f"{'='*44}",
            ])
            return "\n".join([l for l in lines if l])

        # ========== CUSTOMER COPY (No Prescriptions) ==========
        def build_customer_copy():
            lines = [
                f"{'='*44}",
                f"{'نسخة العميل - CUSTOMER COPY':^44}",
                f"{'='*44}",
                f"{shop_name:^44}",
                f"{shop_address:^44}" if shop_address else "",
                f"{shop_phone:^44}" if shop_phone else "",
                f"{'='*44}",
                f"{_('Invoice')}: #{self.invoice_no}",
                f"{_('Date')}: {datetime.datetime.now().strftime('%d/%m/%Y %H:%M')}",
                f"{_('Delivery Date')}: {self.delivery_date.strftime('%d/%m/%Y') if hasattr(self, 'delivery_date') else 'N/A'}",
                f"{'-'*44}",
                f"{_('Customer')}: {customer_name}",
                f"{_('Phone')}: {customer_phone}" if customer_phone else "",
                f"{'-'*44}",
            ]

            # Items (all items for customer)
            if self.cart_items:
                lines.append(f"{_('Items')}:")
                for item in self.cart_items:
                    lines.append(f"  {item['name'][:28]:<28} x{item['qty']} {item['total_price']:>8.2f}")

            # Only show lens/frame info (no prescription details)
            if self.examinations:
                lines.append(f"{'-'*44}")
                lines.append(f"{_('Ordered Items')}:")
                for i, exam in enumerate(self.examinations, 1):
                    if exam.get('lens_info'):
                        lines.append(f"  {_('Lens')}: {exam.get('lens_info', '-')}")
                    if exam.get('frame_info'):
                        lines.append(f"  {_('Frame')}: {exam.get('frame_info', '-')} ({exam.get('frame_color', '-')})")

            lines.extend([
                f"{'-'*44}",
                f"{_('Gross Total'):.<30} {self.totals['gross_total']:>10.2f} {currency}",
                f"{_('Discount'):.<30} {self.totals['discount']:>10.2f} {currency}",
                f"{_('Net Amount'):.<30} {self.totals['net_amount']:>10.2f} {currency}",
                f"{_('Amount Paid'):.<30} {self.totals['amount_paid']:>10.2f} {currency}",
                f"{_('Balance'):.<30} {self.totals['balance']:>10.2f} {currency}",
                f"{'='*44}",
                f"{_('Thank you for your purchase!'):^44}",
                f"{'='*44}",
            ])
            return "\n".join([l for l in lines if l])

        # ========== LAB COPY (Invoice + Prescriptions Only, No Customer Info, No Accessories) ==========
        def build_lab_copy():
            lines = [
                f"{'='*44}",
                f"{'نسخة المختبر - LAB COPY':^44}",
                f"{'='*44}",
                f"{_('Invoice')}: #{self.invoice_no}",
                f"{_('Date')}: {datetime.datetime.now().strftime('%d/%m/%Y')}",
                f"{_('Delivery Date')}: {self.delivery_date.strftime('%d/%m/%Y') if hasattr(self, 'delivery_date') else 'N/A'}",
                f"{_('Doctor')}: {self.doctor_name}" if self.doctor_name else "",
                f"{'='*44}",
            ]

            # Only Examinations/Prescriptions (no accessories, no customer info)
            if self.examinations:
                for i, exam in enumerate(self.examinations, 1):
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

            lines.extend([
                f"{'='*44}",
            ])
            return "\n".join([l for l in lines if l])

        # Preview display
        preview_text = ft.Text("", font_family="Courier New", size=11)
        preview_container = ft.Container(
            content=preview_text,
            bgcolor=ft.colors.WHITE,
            padding=15,
            border_radius=5,
            border=ft.Border.all(1, ft.colors.GREY_300),
            width=420,
            height=400,
        )

        def show_preview(copy_type):
            if copy_type == "shop":
                preview_text.value = build_shop_copy()
            elif copy_type == "customer":
                preview_text.value = build_customer_copy()
            elif copy_type == "lab":
                preview_text.value = build_lab_copy()
            self._page.update()

        def print_copy(copy_type):
            if copy_type == "shop":
                content = build_shop_copy()
            elif copy_type == "customer":
                content = build_customer_copy()
            elif copy_type == "lab":
                content = build_lab_copy()
            print(content)
            self._page.snack_bar = ft.SnackBar(ft.Text(f"✓ {_('Sent to printer')}"))
            self._page.snack_bar.open = True
            self._page.update()

        def print_all(e):
            print(build_shop_copy())
            print("\n" + "="*50 + "\n")
            print(build_customer_copy())
            print("\n" + "="*50 + "\n")
            print(build_lab_copy())
            self._page.snack_bar = ft.SnackBar(ft.Text(f"✓ {_('All copies sent to printer')}"))
            self._page.snack_bar.open = True
            self._page.update()

        def close_and_reset(e):
            dlg.open = False
            self.reset_pos()
            self._page.go("/")

        # Show shop copy by default
        show_preview("shop")

        # Tabs for different copies
        copy_tabs = ft.Row([
            ft.ElevatedButton(
                _("Shop Copy"),
                icon=ft.icons.STORE,
                on_click=lambda e: show_preview("shop"),
                bgcolor=ft.colors.BLUE_700,
                color=ft.colors.WHITE,
            ),
            ft.ElevatedButton(
                _("Customer Copy"),
                icon=ft.icons.PERSON,
                on_click=lambda e: show_preview("customer"),
                bgcolor=ft.colors.GREEN_700,
                color=ft.colors.WHITE,
            ),
            ft.ElevatedButton(
                _("Lab Copy"),
                icon=ft.icons.SCIENCE,
                on_click=lambda e: show_preview("lab"),
                bgcolor=ft.colors.ORANGE_700,
                color=ft.colors.WHITE,
            ),
        ], alignment=ft.MainAxisAlignment.CENTER, spacing=10)

        # Print buttons
        print_buttons = ft.Row([
            ft.OutlinedButton(_("Print Shop"), icon=ft.icons.PRINT, on_click=lambda e: print_copy("shop")),
            ft.OutlinedButton(_("Print Customer"), icon=ft.icons.PRINT, on_click=lambda e: print_copy("customer")),
            ft.OutlinedButton(_("Print Lab"), icon=ft.icons.PRINT, on_click=lambda e: print_copy("lab")),
        ], alignment=ft.MainAxisAlignment.CENTER, spacing=10)

        dlg = ft.AlertDialog(
            title=ft.Row([
                ft.Icon(ft.icons.CHECK_CIRCLE, color=ft.colors.GREEN_700, size=30),
                ft.Text(_("Order Saved Successfully!"), weight=ft.FontWeight.BOLD),
            ]),
            content=ft.Container(
                ft.Column([
                    copy_tabs,
                    ft.Divider(height=10),
                    preview_container,
                    ft.Divider(height=10),
                    print_buttons,
                ], spacing=10, horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                width=480,
            ),
            actions=[
                ft.ElevatedButton(
                    _("Print All 3 Copies"),
                    icon=ft.icons.PRINT,
                    bgcolor=ft.colors.PURPLE_700,
                    color=ft.colors.WHITE,
                    on_click=print_all
                ),
                ft.ElevatedButton(
                    _("Done"),
                    icon=ft.icons.CHECK,
                    bgcolor=ft.colors.GREEN_700,
                    color=ft.colors.WHITE,
                    on_click=close_and_reset
                )
            ],
            actions_alignment=ft.MainAxisAlignment.SPACE_BETWEEN
        )
        self._page.dialog = dlg
        dlg.open = True
        self._page.update()

    def reset_pos(self):
        """Reset POS to initial state."""
        self.current_step = 0
        self.selected_category = None
        self.selected_customer = None
        self.cart_items.clear()
        self.examinations.clear()
        self.examination_data.clear()
        self.totals = {
            "gross_total": 0.0,
            "discount": 0.0,
            "net_amount": 0.0,
            "amount_paid": 0.0,
            "balance": 0.0
        }
        self.invoice_no = None
        self.doctor_name = ""
        self.order_date = datetime.date.today()
        self.delivery_date = datetime.date.today() + datetime.timedelta(days=3)
        self.show_step_0()






