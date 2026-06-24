"""Shared design tokens — spacing, typography, colors, motion.

All UI code should reference these tokens instead of raw ``ft.colors.X`` or
magic-number sizes so the design system stays consistent and themable.

Color tokens are **semantic** (``BRAND_PRIMARY``, ``DANGER``, ``SURFACE``)
rather than named after their current values. This means the palette can
be retuned in one place without sweeping every view.

Convention for new code:
- Use a semantic token (e.g. ``BRAND_PRIMARY``) over a raw color (e.g.
  ``ft.colors.BLUE_700``).
- If you need a color the palette doesn't cover, add a token here first.
- Inline ``ft.colors.X`` references in view files are legacy and should
  migrate to tokens incrementally.
"""

# The compat shim must be loaded before resolving any ft.colors.* lookup —
# on Flet 0.30+ the lowercase ``ft.colors`` is a module without the expected
# constants, and the shim installs a proxy that papers over the difference.
import app.flet_compat  # noqa: F401  (imported for side effects)

import flet as ft

# ---- Spacing ----
SPACE_XS = 6
SPACE_SM = 10
SPACE_MD = 16
SPACE_LG = 22
SPACE_XL = 30

# ---- Control sizes ----
INPUT_HEIGHT = 52
BUTTON_HEIGHT = 56
TOPBAR_ICON_SIZE = 22
TOPBAR_HEIGHT = 64

# ---- Typography ----
TITLE_SIZE = 24
SUBTITLE_SIZE = 16
BODY_SIZE = 14

# ---- Motion ----
PAGE_TRANSITION_MS = 240

# ---- Color palette (semantic) ----
# Brand
BRAND_PRIMARY = ft.colors.BLUE_700
BRAND_PRIMARY_LIGHT = ft.colors.BLUE_500
BRAND_PRIMARY_LIGHTER = ft.colors.BLUE_300
BRAND_PRIMARY_FAINT = ft.colors.BLUE_100
BRAND_PRIMARY_BG = ft.colors.BLUE_50
BRAND_PRIMARY_DARK = ft.colors.BLUE_900

# Status
DANGER = ft.colors.RED_700
DANGER_LIGHT = ft.colors.RED_500
SUCCESS = ft.colors.GREEN_700
SUCCESS_LIGHT = ft.colors.GREEN_500
SUCCESS_BG = ft.colors.GREEN_50
WARNING = ft.colors.ORANGE_700
WARNING_LIGHT = ft.colors.ORANGE_500
WARNING_BG = ft.colors.ORANGE_50

# Foreground / surface
ON_PRIMARY = ft.colors.WHITE
SURFACE = ft.colors.SURFACE_VARIANT
TRANSPARENT = ft.colors.TRANSPARENT

# Text
TEXT_PRIMARY = ft.colors.BLACK
TEXT_MUTED = ft.colors.GREY_600
TEXT_FAINT = ft.colors.GREY_500

# Border / dividers
BORDER = ft.colors.GREY_400
