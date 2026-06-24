"""Color access for the UI layer.

For new code, prefer named semantic tokens from
``app.ui.components.ui_tokens`` (e.g. ``BRAND_PRIMARY``, ``DANGER``).
This module exists to:
  1. Keep the legacy ``from app.ui.colors import colors`` import path working.
  2. Expose ``get_color(name)`` for callers that need a string-keyed lookup.

Both rely on the compatibility proxy installed by ``app.flet_compat`` so
``ft.colors.X`` keeps working across Flet versions, including the
lowercase-module-form regression in Flet 0.30+.
"""

# Ensure compat is loaded first so ft.colors is the proxy, not a stale module.
import app.flet_compat  # noqa: F401

import flet as ft

# Re-export the design-token palette for callers that want the named values.
from app.ui.components.ui_tokens import (  # noqa: F401  (public re-exports)
    BRAND_PRIMARY,
    BRAND_PRIMARY_BG,
    BRAND_PRIMARY_DARK,
    BRAND_PRIMARY_FAINT,
    BRAND_PRIMARY_LIGHT,
    BRAND_PRIMARY_LIGHTER,
    BORDER,
    DANGER,
    DANGER_LIGHT,
    ON_PRIMARY,
    SUCCESS,
    SUCCESS_BG,
    SUCCESS_LIGHT,
    SURFACE,
    TEXT_FAINT,
    TEXT_MUTED,
    TEXT_PRIMARY,
    TRANSPARENT,
    WARNING,
    WARNING_BG,
    WARNING_LIGHT,
)

# Re-export the live ft.colors proxy under its old name.
colors = ft.colors


def get_color(name: str, default: str = "black"):
    """Get a color by name with a safe fallback. Prefer named tokens above."""
    if hasattr(colors, name):
        return getattr(colors, name)
    return default
