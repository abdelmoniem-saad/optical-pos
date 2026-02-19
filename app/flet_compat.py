"""
Flet Compatibility Module
Import this FIRST before any other flet imports to ensure compatibility.

This module patches flet to work across different versions (0.21.x to 0.24.x+).
"""

import sys
print("[COMPAT] Loading Flet compatibility module...", file=sys.stderr, flush=True)

import flet as ft

print(f"[COMPAT] Flet module loaded from: {ft.__file__}", file=sys.stderr, flush=True)

def _patch_flet_colors():
    """Ensure ft.colors is available across all Flet versions."""
    if hasattr(ft, 'colors') and ft.colors is not None:
        print("[COMPAT] ft.colors already available", file=sys.stderr, flush=True)
        return  # Already has colors

    print("[COMPAT] ft.colors NOT found, trying alternatives...", file=sys.stderr, flush=True)

    # Try to get from flet_core
    try:
        from flet_core import colors
        ft.colors = colors
        print("[COMPAT] Got colors from flet_core", file=sys.stderr, flush=True)
        return
    except (ImportError, AttributeError) as e:
        print(f"[COMPAT] flet_core.colors failed: {e}", file=sys.stderr, flush=True)

    # Try flet.colors module
    try:
        import flet.colors as colors
        ft.colors = colors
        print("[COMPAT] Got colors from flet.colors", file=sys.stderr, flush=True)
        return
    except (ImportError, AttributeError) as e:
        print(f"[COMPAT] flet.colors module failed: {e}", file=sys.stderr, flush=True)

    # Create fallback
    print("[COMPAT] Creating fallback ColorsFallback class", file=sys.stderr, flush=True)
    class ColorsFallback:
        # Reds
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

        # Blues
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

        # Greens
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

        # Oranges
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

        # Greys
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

        # Yellows
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

        # Purples
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

        # Pinks
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

        # Basic colors
        WHITE = "white"
        BLACK = "black"
        TRANSPARENT = "transparent"

        # Surface/Theme colors
        SURFACE = "surface"
        SURFACE_VARIANT = "surfacevariant"
        SURFACE_CONTAINER = "surfacecontainer"
        ON_SURFACE = "onsurface"
        ON_SURFACE_VARIANT = "onsurfacevariant"
        BACKGROUND = "background"
        ON_BACKGROUND = "onbackground"
        PRIMARY = "primary"
        ON_PRIMARY = "onprimary"
        SECONDARY = "secondary"
        ON_SECONDARY = "onsecondary"
        ERROR = "error"
        ON_ERROR = "onerror"

        # Blue grey
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

    ft.colors = ColorsFallback()
    print("[COMPAT] Using fallback colors", file=sys.stderr, flush=True)


def _patch_flet_icons():
    """Ensure ft.icons is available."""
    if hasattr(ft, 'icons') and ft.icons is not None:
        return

    try:
        from flet_core import icons
        ft.icons = icons
    except (ImportError, AttributeError):
        pass


def _patch_flet_padding():
    """Patch Padding if symmetric method is missing."""
    if hasattr(ft, 'Padding'):
        if not hasattr(ft.Padding, 'symmetric'):
            # Add symmetric as a static method
            @staticmethod
            def symmetric(horizontal=0, vertical=0):
                return ft.padding.symmetric(horizontal=horizontal, vertical=vertical)
            ft.Padding.symmetric = symmetric
        if not hasattr(ft.Padding, 'all'):
            @staticmethod
            def all(value):
                return ft.padding.all(value)
            ft.Padding.all = all


# Apply all patches
print("[COMPAT] Applying patches...", file=sys.stderr, flush=True)
_patch_flet_colors()
_patch_flet_icons()
_patch_flet_padding()
print("[COMPAT] All patches applied successfully", file=sys.stderr, flush=True)





