"""Optical Settings tab — manage lens types, frame types, and frame colors."""

import flet as ft

from app.core.i18n import _
from app.ui.components.feedback import show_success
from app.ui.components.ui_sync import UIEventTopic, publish_ui_event
from app.ui.components.ui_tokens import (
    BORDER,
    BRAND_PRIMARY,
    BRAND_PRIMARY_BG,
    SPACE_LG,
    SPACE_MD,
    SUCCESS,
    SUCCESS_BG,
    TEXT_FAINT,
    TEXT_MUTED,
    TITLE_SIZE,
)


def create_optical_settings_tab(page: ft.Page, repo):
    """Build the optical-settings UI block (column of 3 cards)."""

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
                        ft.Icon(ft.icons.LENS, size=16, color=BRAND_PRIMARY),
                        ft.Text(lt.get("name", ""), expand=True),
                    ], spacing=10),
                    padding=ft.padding.symmetric(horizontal=10, vertical=8),
                    border_radius=5,
                    bgcolor=BRAND_PRIMARY_BG,
                )
            )
        for ftype in repo.get_frame_types():
            frame_types_list.controls.append(
                ft.Container(
                    ft.Row([
                        ft.Icon(ft.icons.CROP_SQUARE, size=16, color=SUCCESS),
                        ft.Text(ftype.get("name", ""), expand=True),
                    ], spacing=10),
                    padding=ft.padding.symmetric(horizontal=10, vertical=8),
                    border_radius=5,
                    bgcolor=SUCCESS_BG,
                )
            )
        for fcolor in repo.get_frame_colors():
            frame_colors_list.controls.append(
                ft.Container(
                    ft.Row([
                        ft.Icon(ft.icons.COLOR_LENS, size=16, color=ft.colors.PURPLE_700),
                        ft.Text(fcolor.get("name", ""), expand=True),
                    ], spacing=10),
                    padding=ft.padding.symmetric(horizontal=10, vertical=8),
                    border_radius=5,
                    bgcolor=ft.colors.PURPLE_50,
                )
            )

        if not lens_types_list.controls:
            lens_types_list.controls.append(ft.Text(_("No lens types yet"), italic=True, color=TEXT_FAINT))
        if not frame_types_list.controls:
            frame_types_list.controls.append(ft.Text(_("No frame types yet"), italic=True, color=TEXT_FAINT))
        if not frame_colors_list.controls:
            frame_colors_list.controls.append(ft.Text(_("No colors yet"), italic=True, color=TEXT_FAINT))

        page.update()

    def add_item(table_name, input_field):
        if input_field.value and input_field.value.strip():
            value = input_field.value.strip()
            if table_name == "lens_types":
                repo.add_lens_type(value)
            elif table_name == "frame_types":
                repo.add_frame_type(value)
            elif table_name == "frame_colors":
                repo.add_frame_color(value)
            input_field.value = ""
            load_optical_settings()
            publish_ui_event(page, UIEventTopic.INVENTORY)
            show_success(page, _("Added successfully!"))

    lens_input = ft.TextField(
        label=_("Add Lens Type"),
        expand=True,
        on_submit=lambda e: add_item("lens_types", lens_input),
    )
    frame_type_input = ft.TextField(
        label=_("Add Frame Type"),
        expand=True,
        on_submit=lambda e: add_item("frame_types", frame_type_input),
    )
    frame_color_input = ft.TextField(
        label=_("Add Frame Color"),
        expand=True,
        on_submit=lambda e: add_item("frame_colors", frame_color_input),
    )

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
                    border=ft.border.all(1, BORDER),
                    border_radius=5,
                    padding=5,
                ),
                ft.Row([
                    input_field,
                    ft.IconButton(
                        ft.icons.ADD_CIRCLE,
                        icon_color=color,
                        icon_size=30,
                        tooltip=_("Add"),
                        on_click=lambda e: add_item(table_name, input_field),
                    ),
                ]),
            ], spacing=10),
            col={"xs": 12, "md": 4},
            padding=15,
            border=ft.border.all(1, BORDER),
            border_radius=10,
        )

    return ft.Column([
        ft.Row([
            ft.Icon(ft.icons.SETTINGS, size=28),
            ft.Text(_("Optical Settings"), size=TITLE_SIZE, weight=ft.FontWeight.BOLD),
        ], spacing=10),
        ft.Text(
            _("Manage lens types, frame types, and colors used in prescriptions and orders."),
            color=TEXT_MUTED,
            size=14,
        ),
        ft.Divider(height=SPACE_LG),
        ft.ResponsiveRow([
            create_settings_card(_("Lens Types"), ft.icons.LENS, BRAND_PRIMARY, lens_types_list, lens_input, "lens_types"),
            create_settings_card(_("Frame Types"), ft.icons.CROP_SQUARE, SUCCESS, frame_types_list, frame_type_input, "frame_types"),
            create_settings_card(_("Frame Colors"), ft.icons.COLOR_LENS, ft.colors.PURPLE_700, frame_colors_list, frame_color_input, "frame_colors"),
        ], spacing=SPACE_MD, run_spacing=SPACE_MD),
    ], expand=True, spacing=SPACE_MD)
