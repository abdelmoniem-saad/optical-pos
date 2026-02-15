import flet as ft
from app.core.i18n import _

def InventoryView(page: ft.Page, repo):
    
    # --- Products Tab ---
    items_list = ft.ListView(expand=True, spacing=10)

    def load_inventory(term="", category=None):
        items_list.controls.clear()
        inventory = repo.get_inventory(category=category, search_term=term if term else None)

        if not inventory:
            items_list.controls.append(
                ft.ListTile(title=ft.Text(_("No products found"), italic=True, color=ft.colors.GREY_700))
            )
        else:
            for item in inventory:
                stock = item.get("stock_qty", 0)
                stock_color = ft.colors.GREEN_700 if stock > 0 else ft.colors.RED_700

                items_list.controls.append(
                    ft.ListTile(
                        leading=ft.Icon(ft.icons.INVENTORY_2),
                        title=ft.Text(item.get("name", "Unknown")),
                        subtitle=ft.Text(
                            f"SKU: {item.get('sku')} | {_('Category')}: {item.get('category', 'N/A')} | "
                            f"{_('Price')}: {item.get('sale_price', 0):.2f}"
                        ),
                        trailing=ft.Row([
                            ft.Container(
                                ft.Text(f"{stock}", weight=ft.FontWeight.BOLD, color=stock_color),
                                bgcolor=ft.colors.GREY_200,
                                padding=ft.Padding.symmetric(horizontal=10, vertical=5),
                                border_radius=5
                            ),
                            ft.IconButton(ft.icons.ADD_CIRCLE, tooltip=_("Adjust Stock"), on_click=lambda e, i=item: show_adjust_stock_dialog(i)),
                            ft.IconButton(ft.icons.EDIT, tooltip=_("Edit"), on_click=lambda e, i=item: show_product_dialog(i)),
                        ], tight=True),
                    )
                )
        page.update()

    def show_product_dialog(item=None):
        def save_product(e):
            try:
                data = {
                    "name": name_field.value,
                    "sku": sku_field.value,
                    "category": cat_dropdown.value,
                    "sale_price": float(price_field.value or 0),
                    "cost_price": float(cost_field.value or 0),
                    "barcode": barcode_field.value,
                    "frame_type": frame_type_field.value,
                    "frame_color": frame_color_field.value,
                }

                if item:
                    repo.update_inventory_item(item["id"], data)
                else:
                    initial_stock = int(qty_field.value or 0)
                    data["stock_qty"] = initial_stock
                    repo.add_inventory_item(data)

                dialog.open = False
                load_inventory(search_input.value, get_selected_category())
                page.snack_bar = ft.SnackBar(ft.Text(_("Product saved successfully!")))
                page.snack_bar.open = True
                page.update()
            except Exception as ex:
                page.snack_bar = ft.SnackBar(ft.Text(f"{_('Error')}: {str(ex)}"))
                page.snack_bar.open = True
                page.update()

        name_field = ft.TextField(label=_("Name"), value=item.get("name", "") if item else "", expand=True)
        sku_field = ft.TextField(label=_("SKU"), value=item.get("sku", "") if item else repo.generate_sku("Other"), width=150)
        barcode_field = ft.TextField(label=_("Barcode"), value=item.get("barcode", "") if item else "", width=150)

        cat_dropdown = ft.Dropdown(
            label=_("Category"),
            value=item.get("category", "Other") if item else "Other",
            options=[
                ft.dropdown.Option("Frame", _("Frame")),
                ft.dropdown.Option("Sunglasses", _("Sunglasses")),
                ft.dropdown.Option("Accessory", _("Accessory")),
                ft.dropdown.Option("ContactLens", _("Contact Lens")),
                ft.dropdown.Option("Other", _("Other"))
            ],
            width=150,
            on_change=lambda e: update_sku()
        )

        def update_sku():
            if not item:
                sku_field.value = repo.generate_sku(cat_dropdown.value)
                page.update()

        price_field = ft.TextField(
            label=_("Sale Price"),
            value=str(item.get("sale_price", 0)) if item else "0.00",
            width=120
        )
        cost_field = ft.TextField(
            label=_("Cost Price"),
            value=str(item.get("cost_price", 0)) if item else "0.00",
            width=120
        )
        qty_field = ft.TextField(
            label=_("Initial Stock"),
            value="0",
            input_filter=ft.NumbersOnlyInputFilter(),
            width=100,
            visible=not item  # Only show for new products
        )

        # Frame-specific fields
        frame_types = repo.get_frame_types()
        frame_colors = repo.get_frame_colors()

        frame_type_field = ft.Dropdown(
            label=_("Frame Type"),
            value=item.get("frame_type", "") if item else "",
            options=[ft.dropdown.Option(ftype["name"], ftype["name"]) for ftype in frame_types],
            width=150
        )
        frame_color_field = ft.Dropdown(
            label=_("Frame Color"),
            value=item.get("frame_color", "") if item else "",
            options=[ft.dropdown.Option(fcolor["name"], fcolor["name"]) for fcolor in frame_colors],
            width=150
        )

        dialog = ft.AlertDialog(
            title=ft.Text(_("Edit Product") if item else _("New Product")),
            content=ft.Container(
                ft.Column([
                    ft.Row([name_field]),
                    ft.Row([sku_field, barcode_field, cat_dropdown]),
                    ft.Row([price_field, cost_field, qty_field]),
                    ft.Row([frame_type_field, frame_color_field]),
                ], tight=True, spacing=10),
                width=500
            ),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: close_dialog()),
                ft.ElevatedButton(_("Save"), on_click=save_product)
            ]
        )

        def close_dialog():
            dialog.open = False
            page.update()

        page.dialog = dialog
        dialog.open = True
        page.update()

    def show_adjust_stock_dialog(item):
        """Dialog to adjust stock with movement record."""
        current_stock = item.get("stock_qty", 0)

        def adjust_stock(e):
            try:
                adjustment = int(adjustment_field.value or 0)
                if adjustment == 0:
                    dialog.open = False
                    page.update()
                    return

                movement_type = "adjustment"
                if adjustment > 0:
                    movement_type = type_dropdown.value or "purchase"
                else:
                    movement_type = type_dropdown.value or "sale"

                repo.adjust_stock(
                    item["id"],
                    adjustment,
                    movement_type,
                    ref_no=ref_field.value or "",
                    note=note_field.value or ""
                )

                dialog.open = False
                load_inventory(search_input.value, get_selected_category())
                page.snack_bar = ft.SnackBar(ft.Text(_("Stock adjusted successfully!")))
                page.snack_bar.open = True
                page.update()
            except Exception as ex:
                page.snack_bar = ft.SnackBar(ft.Text(f"{_('Error')}: {str(ex)}"))
                page.snack_bar.open = True
                page.update()

        adjustment_field = ft.TextField(
            label=_("Adjustment (+/-)"),
            value="0",
            width=150,
            autofocus=True
        )
        type_dropdown = ft.Dropdown(
            label=_("Movement Type"),
            value="adjustment",
            options=[
                ft.dropdown.Option("purchase", _("Purchase")),
                ft.dropdown.Option("adjustment", _("Adjustment")),
                ft.dropdown.Option("return", _("Return")),
                ft.dropdown.Option("initial", _("Initial Stock")),
            ],
            width=150
        )
        ref_field = ft.TextField(label=_("Reference No."), width=150)
        note_field = ft.TextField(label=_("Note"), expand=True)

        dialog = ft.AlertDialog(
            title=ft.Text(f"{_('Adjust Stock')}: {item.get('name')}"),
            content=ft.Container(
                ft.Column([
                    ft.Text(f"{_('Current Stock')}: {current_stock}", size=16, weight=ft.FontWeight.BOLD),
                    ft.Row([adjustment_field, type_dropdown]),
                    ft.Row([ref_field, note_field]),
                ], tight=True, spacing=10),
                width=400
            ),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.ElevatedButton(_("Adjust"), on_click=adjust_stock)
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()

    search_input = ft.TextField(
        label=_("Search by name or SKU..."),
        prefix_icon=ft.icons.SEARCH,
        expand=True,
        on_change=lambda e: load_inventory(e.control.value, get_selected_category())
    )

    category_filter = ft.Dropdown(
        label=_("Category"),
        value="All",
        options=[
            ft.dropdown.Option("All", _("All Categories")),
            ft.dropdown.Option("Frame", _("Frames")),
            ft.dropdown.Option("Sunglasses", _("Sunglasses")),
            ft.dropdown.Option("Accessory", _("Accessories")),
            ft.dropdown.Option("ContactLens", _("Contact Lenses")),
            ft.dropdown.Option("Other", _("Others"))
        ],
        width=180,
        on_change=lambda e: load_inventory(search_input.value, get_selected_category())
    )

    def get_selected_category():
        return None if category_filter.value == "All" else category_filter.value

    products_content = ft.Column([
        ft.Row([
            ft.Text(_("Products"), size=22, weight=ft.FontWeight.BOLD),
            ft.ElevatedButton(_("+ Add New Product"), icon=ft.icons.ADD, on_click=lambda _: show_product_dialog())
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ft.Row([search_input, category_filter]),
        items_list
    ], spacing=10, expand=True)

    # --- Suppliers Tab ---
    suppliers_list = ft.ListView(expand=True, spacing=10)

    def load_suppliers():
        suppliers_list.controls.clear()
        suppliers = repo.get_metadata("suppliers")

        if not suppliers:
            suppliers_list.controls.append(
                ft.ListTile(title=ft.Text(_("No suppliers found"), italic=True))
            )
        else:
            for s in suppliers:
                suppliers_list.controls.append(
                    ft.ListTile(
                        leading=ft.Icon(ft.icons.BUSINESS),
                        title=ft.Text(s.get("name", "Unknown")),
                        subtitle=ft.Text(f"{_('Phone')}: {s.get('phone', 'N/A')} | {_('Email')}: {s.get('email', 'N/A')}"),
                        trailing=ft.IconButton(ft.icons.EDIT, on_click=lambda e, sup=s: show_supplier_dialog(sup))
                    )
                )
        page.update()

    def show_supplier_dialog(supplier=None):
        def save_supplier(e):
            data = {
                "name": name_field.value,
                "phone": phone_field.value,
                "email": email_field.value,
                "address": address_field.value
            }
            if supplier:
                # Update existing (if repo supports it)
                pass
            else:
                repo.add_metadata("suppliers", data["name"])
            dialog.open = False
            load_suppliers()
            page.update()

        name_field = ft.TextField(label=_("Name"), value=supplier.get("name", "") if supplier else "")
        phone_field = ft.TextField(label=_("Phone"), value=supplier.get("phone", "") if supplier else "")
        email_field = ft.TextField(label=_("Email"), value=supplier.get("email", "") if supplier else "")
        address_field = ft.TextField(label=_("Address"), value=supplier.get("address", "") if supplier else "", multiline=True)

        dialog = ft.AlertDialog(
            title=ft.Text(_("Supplier")),
            content=ft.Column([name_field, phone_field, email_field, address_field], tight=True),
            actions=[
                ft.TextButton(_("Cancel"), on_click=lambda e: setattr(dialog, "open", False) or page.update()),
                ft.TextButton(_("Save"), on_click=save_supplier)
            ]
        )
        page.dialog = dialog
        dialog.open = True
        page.update()
    
    suppliers_content = ft.Column([
        ft.Row([
            ft.Text(_("Suppliers"), size=22, weight=ft.FontWeight.BOLD),
            ft.ElevatedButton(_("+ Add Supplier"), icon=ft.icons.ADD, on_click=lambda _: show_supplier_dialog())
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        suppliers_list
    ], spacing=10, expand=True)

    # --- Optical Settings Tab ---
    def create_optical_settings_tab():
        lens_types_list = ft.ListView(expand=True, spacing=2)
        frame_types_list = ft.ListView(expand=True, spacing=2)
        frame_colors_list = ft.ListView(expand=True, spacing=2)

        def load_optical_settings():
            lens_types_list.controls.clear()
            frame_types_list.controls.clear()
            frame_colors_list.controls.clear()

            for lt in repo.get_lens_types():
                lens_types_list.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.LENS, size=16, color=ft.colors.BLUE_700),
                            ft.Text(lt.get("name", ""), expand=True),
                        ], spacing=10),
                        padding=ft.Padding.symmetric(horizontal=10, vertical=8),
                        border_radius=5,
                        bgcolor=ft.colors.BLUE_50
                    )
                )
            for ftype in repo.get_frame_types():
                frame_types_list.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.CROP_SQUARE, size=16, color=ft.colors.GREEN_700),
                            ft.Text(ftype.get("name", ""), expand=True),
                        ], spacing=10),
                        padding=ft.Padding.symmetric(horizontal=10, vertical=8),
                        border_radius=5,
                        bgcolor=ft.colors.GREEN_50
                    )
                )
            for fcolor in repo.get_frame_colors():
                frame_colors_list.controls.append(
                    ft.Container(
                        ft.Row([
                            ft.Icon(ft.icons.COLOR_LENS, size=16, color=ft.colors.PURPLE_700),
                            ft.Text(fcolor.get("name", ""), expand=True),
                        ], spacing=10),
                        padding=ft.Padding.symmetric(horizontal=10, vertical=8),
                        border_radius=5,
                        bgcolor=ft.colors.PURPLE_50
                    )
                )

            # Add placeholder if empty
            if not lens_types_list.controls:
                lens_types_list.controls.append(ft.Text(_("No lens types yet"), italic=True, color=ft.colors.GREY_500))
            if not frame_types_list.controls:
                frame_types_list.controls.append(ft.Text(_("No frame types yet"), italic=True, color=ft.colors.GREY_500))
            if not frame_colors_list.controls:
                frame_colors_list.controls.append(ft.Text(_("No colors yet"), italic=True, color=ft.colors.GREY_500))

            page.update()

        def add_item(table_name, input_field):
            if input_field.value and input_field.value.strip():
                if table_name == "lens_types":
                    repo.add_lens_type(input_field.value.strip())
                elif table_name == "frame_types":
                    repo.add_frame_type(input_field.value.strip())
                elif table_name == "frame_colors":
                    repo.add_frame_color(input_field.value.strip())
                input_field.value = ""
                load_optical_settings()
                page.snack_bar = ft.SnackBar(ft.Text(_("Added successfully!")))
                page.snack_bar.open = True
                page.update()

        lens_input = ft.TextField(label=_("Add Lens Type"), expand=True, on_submit=lambda e: add_item("lens_types", lens_input))
        frame_type_input = ft.TextField(label=_("Add Frame Type"), expand=True, on_submit=lambda e: add_item("frame_types", frame_type_input))
        frame_color_input = ft.TextField(label=_("Add Frame Color"), expand=True, on_submit=lambda e: add_item("frame_colors", frame_color_input))

        load_optical_settings()

        def create_settings_card(title, icon, color, items_list, input_field, table_name):
            return ft.Container(
                ft.Column([
                    ft.Row([
                        ft.Icon(icon, color=color, size=24),
                        ft.Text(title, weight=ft.FontWeight.BOLD, size=16),
                    ], spacing=10),
                    ft.Divider(height=10),
                    ft.Container(
                        items_list,
                        height=200,
                        border=ft.Border.all(1, ft.colors.GREY_300),
                        border_radius=5,
                        padding=5
                    ),
                    ft.Row([
                        input_field,
                        ft.IconButton(
                            ft.icons.ADD_CIRCLE,
                            icon_color=color,
                            icon_size=30,
                            tooltip=_("Add"),
                            on_click=lambda e: add_item(table_name, input_field)
                        )
                    ])
                ], spacing=10),
                col={"xs": 12, "md": 4},
                padding=15,
                border=ft.Border.all(1, ft.colors.GREY_200),
                border_radius=10
            )

        return ft.Column([
            ft.Row([
                ft.Icon(ft.icons.SETTINGS, size=28),
                ft.Text(_("Optical Settings"), size=22, weight=ft.FontWeight.BOLD),
            ], spacing=10),
            ft.Text(_("Manage lens types, frame types, and colors used in prescriptions and orders."),
                    color=ft.colors.GREY_700, size=14),
            ft.Divider(height=20),
            ft.ResponsiveRow([
                create_settings_card(_("Lens Types"), ft.icons.LENS, ft.colors.BLUE_700, lens_types_list, lens_input, "lens_types"),
                create_settings_card(_("Frame Types"), ft.icons.CROP_SQUARE, ft.colors.GREEN_700, frame_types_list, frame_type_input, "frame_types"),
                create_settings_card(_("Frame Colors"), ft.icons.COLOR_LENS, ft.colors.PURPLE_700, frame_colors_list, frame_color_input, "frame_colors"),
            ], spacing=15, run_spacing=15)
        ], expand=True, spacing=10)

    optical_settings_content = create_optical_settings_tab()

    tabs = ft.Tabs(
        selected_index=0,
        tabs=[
            ft.Tab(text=_("Inventory"), content=products_content),
            ft.Tab(text=_("Suppliers"), content=suppliers_content),
            ft.Tab(text=_("Optical Settings"), content=optical_settings_content),
        ],
        expand=True
    )

    load_inventory()
    load_suppliers()

    return ft.View(
        "/inventory",
        [
            ft.AppBar(
                title=ft.Text(_("Inventory Management")),
                bgcolor=ft.colors.BLUE_700,
                color=ft.colors.WHITE,
                leading=ft.IconButton(ft.icons.ARROW_BACK, on_click=lambda _: page.go("/"))
            ),
            ft.Container(content=tabs, expand=True, padding=10)
        ],
    )

