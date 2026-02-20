"""
Flet Compatibility Module
Import this FIRST before any other flet imports to ensure compatibility.

This module patches flet to work across different versions (0.24.x to 0.25.x+).
In Flet 0.25+, colors/icons are uppercase enums (Colors, Icons).
This module provides backwards compatibility with lowercase access.
"""

import sys
import warnings

# Suppress deprecation warnings for colors/icons
warnings.filterwarnings('ignore', message='.*colors enum is deprecated.*')
warnings.filterwarnings('ignore', message='.*icons enum is deprecated.*')

print("[COMPAT] Loading Flet compatibility module...", file=sys.stderr, flush=True)

import flet as ft

print(f"[COMPAT] Flet module loaded", file=sys.stderr, flush=True)


def _patch_flet_colors():
    """Ensure ft.colors is available (maps to ft.Colors in 0.25+)."""
    # In Flet 0.25+, Colors is the new enum
    if hasattr(ft, 'Colors') and ft.Colors is not None:
        # Create a lowercase alias for backward compatibility
        if not hasattr(ft, 'colors') or ft.colors is None:
            ft.colors = ft.Colors
        print("[COMPAT] Using ft.Colors (0.25+ style)", file=sys.stderr, flush=True)
        return

    # Older versions have ft.colors directly
    if hasattr(ft, 'colors') and ft.colors is not None:
        print("[COMPAT] Using ft.colors (legacy style)", file=sys.stderr, flush=True)
        return

    # Fallback - create basic color constants
    print("[COMPAT] Creating fallback colors", file=sys.stderr, flush=True)

    class ColorsFallback:
        """Fallback colors for when Flet colors are not available."""
        # Basic colors
        RED = "red"
        RED_50 = "red50"
        RED_100 = "red100"
        RED_200 = "red200"
        RED_300 = "red300"
        RED_400 = "red400"
        RED_500 = "red500"
        RED_600 = "red600"
        RED_700 = "red700"
        RED_800 = "red800"
        RED_900 = "red900"

        BLUE = "blue"
        BLUE_50 = "blue50"
        BLUE_100 = "blue100"
        BLUE_200 = "blue200"
        BLUE_300 = "blue300"
        BLUE_400 = "blue400"
        BLUE_500 = "blue500"
        BLUE_600 = "blue600"
        BLUE_700 = "blue700"
        BLUE_800 = "blue800"
        BLUE_900 = "blue900"

        GREEN = "green"
        GREEN_50 = "green50"
        GREEN_100 = "green100"
        GREEN_200 = "green200"
        GREEN_300 = "green300"
        GREEN_400 = "green400"
        GREEN_500 = "green500"
        GREEN_600 = "green600"
        GREEN_700 = "green700"
        GREEN_800 = "green800"
        GREEN_900 = "green900"

        ORANGE = "orange"
        ORANGE_50 = "orange50"
        ORANGE_100 = "orange100"
        ORANGE_200 = "orange200"
        ORANGE_300 = "orange300"
        ORANGE_400 = "orange400"
        ORANGE_500 = "orange500"
        ORANGE_600 = "orange600"
        ORANGE_700 = "orange700"
        ORANGE_800 = "orange800"
        ORANGE_900 = "orange900"

        YELLOW = "yellow"
        YELLOW_50 = "yellow50"
        YELLOW_100 = "yellow100"
        YELLOW_200 = "yellow200"
        YELLOW_300 = "yellow300"
        YELLOW_400 = "yellow400"
        YELLOW_500 = "yellow500"
        YELLOW_600 = "yellow600"
        YELLOW_700 = "yellow700"
        YELLOW_800 = "yellow800"
        YELLOW_900 = "yellow900"

        PURPLE = "purple"
        PURPLE_50 = "purple50"
        PURPLE_100 = "purple100"
        PURPLE_200 = "purple200"
        PURPLE_300 = "purple300"
        PURPLE_400 = "purple400"
        PURPLE_500 = "purple500"
        PURPLE_600 = "purple600"
        PURPLE_700 = "purple700"
        PURPLE_800 = "purple800"
        PURPLE_900 = "purple900"

        PINK = "pink"
        PINK_50 = "pink50"
        PINK_100 = "pink100"
        PINK_200 = "pink200"
        PINK_300 = "pink300"
        PINK_400 = "pink400"
        PINK_500 = "pink500"
        PINK_600 = "pink600"
        PINK_700 = "pink700"
        PINK_800 = "pink800"
        PINK_900 = "pink900"

        GREY = "grey"
        GREY_50 = "grey50"
        GREY_100 = "grey100"
        GREY_200 = "grey200"
        GREY_300 = "grey300"
        GREY_400 = "grey400"
        GREY_500 = "grey500"
        GREY_600 = "grey600"
        GREY_700 = "grey700"
        GREY_800 = "grey800"
        GREY_900 = "grey900"

        BLUE_GREY = "bluegrey"
        BLUE_GREY_50 = "bluegrey50"
        BLUE_GREY_100 = "bluegrey100"
        BLUE_GREY_200 = "bluegrey200"
        BLUE_GREY_300 = "bluegrey300"
        BLUE_GREY_400 = "bluegrey400"
        BLUE_GREY_500 = "bluegrey500"
        BLUE_GREY_600 = "bluegrey600"
        BLUE_GREY_700 = "bluegrey700"
        BLUE_GREY_800 = "bluegrey800"
        BLUE_GREY_900 = "bluegrey900"

        # Basic
        WHITE = "white"
        BLACK = "black"
        TRANSPARENT = "transparent"

        # Theme colors
        SURFACE = "surface"
        SURFACE_VARIANT = "surfacevariant"
        ON_SURFACE = "onsurface"
        BACKGROUND = "background"
        PRIMARY = "primary"
        ON_PRIMARY = "onprimary"
        SECONDARY = "secondary"
        ERROR = "error"

    ft.colors = ColorsFallback
    ft.Colors = ColorsFallback


def _patch_flet_icons():
    """Ensure ft.icons is available (maps to ft.Icons in 0.25+)."""
    # In Flet 0.25+, Icons is the new enum
    if hasattr(ft, 'Icons') and ft.Icons is not None:
        if not hasattr(ft, 'icons') or ft.icons is None:
            ft.icons = ft.Icons
        print("[COMPAT] Using ft.Icons (0.25+ style)", file=sys.stderr, flush=True)
        return

    if hasattr(ft, 'icons') and ft.icons is not None:
        print("[COMPAT] Using ft.icons (legacy style)", file=sys.stderr, flush=True)
        return

    print("[COMPAT] Icons not found - they may need to be accessed differently", file=sys.stderr, flush=True)


def _patch_flet_padding():
    """Ensure padding helpers work across versions."""
    # In newer Flet, use ft.padding.symmetric() instead of ft.Padding.symmetric()
    if hasattr(ft, 'padding') and ft.padding is not None:
        print("[COMPAT] ft.padding available", file=sys.stderr, flush=True)

    # Patch Padding class if it exists but lacks methods
    if hasattr(ft, 'Padding'):
        if not hasattr(ft.Padding, 'symmetric'):
            try:
                ft.Padding.symmetric = staticmethod(lambda horizontal=0, vertical=0: ft.padding.symmetric(horizontal=horizontal, vertical=vertical))
            except:
                pass
        if not hasattr(ft.Padding, 'all'):
            try:
                ft.Padding.all = staticmethod(lambda value: ft.padding.all(value))
            except:
                pass


def _patch_window_properties():
    """Handle window property changes in different Flet versions."""
    # In Flet 0.23+, window properties moved to page.window object
    # This is handled at runtime, but we note it here
    print("[COMPAT] Window properties: use page.window.maximized (0.23+ style)", file=sys.stderr, flush=True)


# Apply all patches
print("[COMPAT] Applying patches...", file=sys.stderr, flush=True)
_patch_flet_colors()
_patch_flet_icons()
_patch_flet_padding()
_patch_window_properties()
print("[COMPAT] All patches applied successfully", file=sys.stderr, flush=True)


