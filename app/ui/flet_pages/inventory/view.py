"""Inventory view — assembles three tabs: products, suppliers, optical settings."""

import flet as ft

from app.core.i18n import _
from app.ui.components.design_helpers import (
    primary_button,
    refresh_action,
    standard_appbar,
)
from app.ui.components.ui_tokens import (
    DANGER,
    INPUT_HEIGHT,
    SPACE_MD,
    SUCCESS,
    TEXT_MUTED,
    TITLE_SIZE,
)
from app.ui.flet_pages.inventory.optical_settings_tab import create_optical_settings_tab
from app.ui.flet_pages.inventory.product_dialog import show_product_dialog
from app.ui.flet_pages.inventory.stock_dialog import show_adjust_stock_dialog
from app.ui.flet_pages.inventory.supplier_dialog import show_supplier_dialog


def InventoryView(page: ft.Page, repo):

    # ---- Products tab state ----
    items_list = ft.ListView(expand=True, spacing=SPACE_MD)
    inventory_summary = ft.Text("", color=TEXT_MUTED)

    search_input = ft.TextField(
        label=_("Search by name or SKU..."),
        prefix_icon=ft.icons.SEARCH,
        height=INPUT_HEIGHT,
        text_size=15,
        expand=True,
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
            ft.dropdown.Option("Other", _("Others")),
        ],
        width=210,
    )

    stock_filter = ft.Dropdown(
        label=_("Stock"),
        value="All",
        options=[
            ft.dropdown.Option("All", _("All Stock")),
            ft.dropdown.Option("InStock", _("In Stock")),
            ft.dropdown.Option("LowStock", _("Low Stock (<5)")),
            ft.dropdown.Option("OutOfStock", _("Out of Stock")),
        ],
        width=210,
    )

    def get_selected_category():
        return None if category_filter.value == "All" else category_filter.value

    def get_selected_stock_mode():
        return stock_filter.value or "All"

    def load_inventory(term="", category=None):
        items_list.controls.clear()
        inventory = repo.get_inventory(category=category, search_term=term if term else None)

        stock_mode = get_selected_stock_mode()
        if stock_mode == "InStock":
            inventory = [i for i in inventory if float(i.get("stock_qty", 0) or 0) > 0]
        elif stock_mode == "OutOfStock":
            inventory = [i for i in inventory if float(i.get("stock_qty", 0) or 0) <= 0]
        elif stock_mode == "LowStock":
            inventory = [i for i in inventory if 0 < float(i.get("stock_qty", 0) or 0) < 5]

        total_items = len(inventory)
        low_stock_count = len([i for i in inventory if 0 < float(i.get("stock_qty", 0) or 0) < 5])
        out_of_stock_count = len([i for i in inventory if float(i.get("stock_qty", 0) or 0) <= 0])
        inventory_summary.value = (
            f"{_('Items')}: {total_items} | "
            f"{_('Low Stock')}: {low_stock_count} | "
            f"{_('Out of Stock')}: {out_of_stock_count}"
        )

        if not inventory:
            items_list.controls.append(
                ft.ListTile(title=ft.Text(_("No products found"), italic=True, color=TEXT_MUTED))
            )
        else:
            for item in inventory:
                stock = item.get("stock_qty", 0)
                stock_color = SUCCESS if stock > 0 else DANGER

                items_list.controls.append(
                    ft.ListTile(
                        leading=ft.Icon(ft.icons.INVENTORY_2),
                        title=ft.Text(item.get("name", "Unknown"), size=16, weight=ft.FontWeight.W_600),
                        subtitle=ft.Text(
                            f"SKU: {item.get('sku')} | "
                            f"{_('Category')}: {item.get('category', 'N/A')} | "
                            f"{_('Price')}: {item.get('sale_price', 0):.2f}",
                            size=13,
                        ),
                        trailing=ft.Row([
                            ft.Container(
                                ft.Text(f"{stock}", weight=ft.FontWeight.BOLD, color=stock_color),
                                bgcolor=ft.colors.GREY_200,
                                padding=ft.padding.symmetric(horizontal=12, vertical=8),
                                border_radius=8,
                            ),
                            ft.IconButton(
                                ft.icons.ADD_CIRCLE,
                                tooltip=_("Adjust Stock"),
                                on_click=lambda e, i=item: show_adjust_stock_dialog(
                                    page, repo, i, on_saved=refresh_inventory
                                ),
                            ),
                            ft.IconButton(
                                ft.icons.EDIT,
                                tooltip=_("Edit"),
                                on_click=lambda e, i=item: show_product_dialog(
                                    page, repo, item=i, on_saved=refresh_inventory
                                ),
                            ),
                        ], tight=True),
                    )
                )
        page.update()

    def refresh_inventory():
        load_inventory(search_input.value, get_selected_category())

    # Wire up the filters now that the closures exist.
    search_input.on_change = lambda e: refresh_inventory()
    category_filter.on_change = lambda e: refresh_inventory()
    stock_filter.on_change = lambda e: refresh_inventory()

    products_content = ft.Column([
        ft.Row([
            ft.Text(_("Products"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
            ft.Row([
                refresh_action(on_click=lambda _: refresh_inventory(), tooltip=_("Refresh")),
                primary_button(
                    _("+ Add New Product"),
                    on_click=lambda _: show_product_dialog(page, repo, on_saved=refresh_inventory),
                    icon=ft.icons.ADD,
                ),
            ]),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        ft.Row([search_input, category_filter, stock_filter]),
        inventory_summary,
        items_list,
    ], spacing=SPACE_MD, expand=True)

    # ---- Suppliers tab ----
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
                        subtitle=ft.Text(
                            f"{_('Phone')}: {s.get('phone', 'N/A')} | "
                            f"{_('Email')}: {s.get('email', 'N/A')}"
                        ),
                        trailing=ft.IconButton(
                            ft.icons.EDIT,
                            on_click=lambda e, sup=s: show_supplier_dialog(
                                page, repo, supplier=sup, on_saved=load_suppliers
                            ),
                        ),
                    )
                )
        page.update()

    suppliers_content = ft.Column([
        ft.Row([
            ft.Text(_("Suppliers"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
            primary_button(
                _("+ Add Supplier"),
                on_click=lambda _: show_supplier_dialog(page, repo, on_saved=load_suppliers),
                icon=ft.icons.ADD,
            ),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        suppliers_list,
    ], spacing=SPACE_MD, expand=True)

    # ---- Optical Settings tab ----
    optical_settings_content = create_optical_settings_tab(page, repo)

    tabs = ft.Tabs(
        selected_index=0,
        tabs=[
            ft.Tab(label=_("Inventory"), content=products_content),
            ft.Tab(label=_("Suppliers"), content=suppliers_content),
            ft.Tab(label=_("Optical Settings"), content=optical_settings_content),
        ],
        expand=True,
    )

    load_inventory()
    load_suppliers()

    return ft.View(
        "/inventory",
        [
            standard_appbar(_("Inventory Management"), on_back=lambda _: page.go("/")),
            ft.Container(content=tabs, expand=True, padding=SPACE_MD),
        ],
    )
