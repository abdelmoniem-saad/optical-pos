"""
Flet Color Compatibility Layer
Re-exports colors from flet after compatibility patches are applied.

Usage:
    from app.ui.colors import colors
    # or
    import flet as ft  # after importing app.flet_compat
    ft.colors.RED_700
"""

# Ensure compat is loaded first
import app.flet_compat  # noqa: F401

import flet as ft

# Re-export colors
colors = ft.colors

# Convenience function to get a color
def get_color(name: str, default: str = "black"):
    """Get a color by name, with fallback."""
    if hasattr(colors, name):
        return getattr(colors, name)
    return default


