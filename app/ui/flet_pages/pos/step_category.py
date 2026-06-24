"""Step 0 — category selection grid (Glasses / Sunglasses / Contact Lenses / Accessories / Others)."""

import flet as ft

from app.core.i18n import _
from app.ui.components.ui_tokens import ON_PRIMARY, SPACE_LG


def build_category_step(controller):
    """Render the category-selection grid into ``controller.content_area``."""
    controller.current_step = 0

    categories = [
        (_("Glasses"), "Frame", ft.icons.REMOVE_RED_EYE, "#1976d2"),
        (_("Sunglasses"), "Sunglasses", ft.icons.WB_SUNNY, "#388e3c"),
        (_("Contact Lenses"), "ContactLens", ft.icons.BLUR_ON, "#0288d1"),
        (_("Accessories"), "Accessory", ft.icons.DASHBOARD_CUSTOMIZE, "#f57c00"),
        (_("Others"), "Other", ft.icons.MORE_HORIZ, "#7b1fa2"),
    ]

    grid = ft.ResponsiveRow(
        [
            ft.Container(
                content=ft.Column([
                    ft.Icon(icon, size=60, color=ON_PRIMARY),
                    ft.Text(label, size=22, weight=ft.FontWeight.BOLD, color=ON_PRIMARY),
                ], alignment=ft.MainAxisAlignment.CENTER, horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                padding=36,
                border_radius=15,
                bgcolor=color,
                on_click=lambda e, cat=val: controller.start_with_category(cat),
                col={"xs": 6, "sm": 4, "md": 4, "lg": 2.4},
                height=210,
            )
            for label, val, icon, color in categories
        ],
        alignment=ft.MainAxisAlignment.CENTER,
        spacing=SPACE_LG,
        run_spacing=SPACE_LG,
    )

    controller.content_area.content = ft.Column(
        [
            ft.Text(_("Select Product Category"), size=34, weight=ft.FontWeight.BOLD),
            ft.Divider(height=SPACE_LG),
            grid,
        ],
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        spacing=SPACE_LG,
    )
    controller._page.update()
