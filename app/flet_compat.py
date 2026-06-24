"""Flet compatibility shim.

Import this **first**, before any other ``flet`` imports, so that lookups
like ``ft.colors.BLUE_700`` and ``ft.icons.ARROW_BACK`` keep working as
Flet's API drifts between releases.

Why this exists
---------------
Flet has changed the way colors and icons are exposed across minor
versions:

  * Flet 0.24 and earlier:  ``ft.colors`` and ``ft.icons`` were the enums.
  * Flet 0.25+:              renamed to ``ft.Colors`` / ``ft.Icons``.
  * Flet 0.30+:              ``ft.icons`` (lowercase) is bound to a *module*,
                             not the enum, so ``ft.icons.ARROW_BACK`` raises
                             AttributeError even though ``ft.Icons.ARROW_BACK``
                             works fine.

The application code is full of ``ft.colors.X`` / ``ft.icons.X`` references
that predate the rename. Sweeping them all is a separate refactor; this
module installs proxies on ``ft.colors`` and ``ft.icons`` that always
delegate to the modern enums plus a few sensible aliasings, so the legacy
syntax keeps working on a pinned modern Flet.

Upgrade policy
--------------
Flet is pinned exactly in ``pyproject.toml`` and ``requirements.txt``.
When that pin moves, re-run the test suite with the new Flet installed
and audit this file for any new attribute drift (e.g. another rename of
``ft.colors`` / ``ft.icons``, removed icon constants, or moved properties
on ``ft.Padding`` / ``ft.Margin`` / ``page.window``).

This file used to also carry a ~190-line ``ColorsFallback`` class with
hardcoded color name strings, in case neither ``ft.Colors`` nor
``ft.colors`` existed. That branch is unreachable on any installable
Flet release and was removed.
"""

import sys
import warnings

# Suppress deprecation warnings for the legacy ft.colors / ft.icons access.
warnings.filterwarnings('ignore', message='.*colors enum is deprecated.*')
warnings.filterwarnings('ignore', message='.*icons enum is deprecated.*')

print("[COMPAT] Loading Flet compatibility module...", file=sys.stderr, flush=True)

import flet as ft

print("[COMPAT] Flet module loaded", file=sys.stderr, flush=True)


def _patch_flet_colors():
    """Install a proxy on ``ft.colors`` that delegates to ``ft.Colors``.

    The proxy also handles cross-version aliasing so older constant
    names keep resolving to a sensible value:

      * ``SURFACE_VARIANT`` -> ``SURFACE_CONTAINER_HIGHEST`` (etc.) on
        newer Flet, where the Material 3 palette renamed surfaces.
      * British spellings (``GREY`` -> ``GRAY`` and ``BLUE_GREY`` ->
        ``BLUE_GRAY``) on releases that switched.

    If the requested name has no match, the proxy returns the literal
    ``"transparent"`` so the UI keeps rendering instead of crashing on a
    stray color name.
    """
    if not (hasattr(ft, 'Colors') and ft.Colors is not None):
        # On any supported Flet version ft.Colors exists. If we ever land here
        # the install is fundamentally broken; let the caller see the error.
        print("[COMPAT][WARN] ft.Colors is not available; ft.colors lookups will likely fail", file=sys.stderr, flush=True)
        return

    color_enum = ft.Colors

    _ALIASES = {
        "SURFACE_VARIANT": ["SURFACE_CONTAINER_HIGHEST", "SURFACE_CONTAINER_HIGH", "SURFACE_CONTAINER", "SURFACE"],
        "BACKGROUND": ["SURFACE"],
    }

    def _resolve_color_name(name: str):
        if hasattr(color_enum, name):
            return getattr(color_enum, name)

        for candidate in _ALIASES.get(name, []):
            if hasattr(color_enum, candidate):
                return getattr(color_enum, candidate)

        # British/American spelling differences.
        normalized = []
        if "GREY" in name:
            normalized.append(name.replace("GREY", "GRAY"))
        if "BLUE_GREY" in name:
            normalized.append(name.replace("BLUE_GREY", "BLUE_GRAY"))
        for candidate in normalized:
            if hasattr(color_enum, candidate):
                return getattr(color_enum, candidate)

        # Last resort - keep the page rendering instead of crashing.
        return "transparent"

    class ColorsProxy:
        def __getattr__(self, name):
            return _resolve_color_name(name)

    ft.colors = ColorsProxy()
    print("[COMPAT] Using proxied ft.Colors", file=sys.stderr, flush=True)


def _patch_flet_icons():
    """Install a proxy on ``ft.icons`` that delegates to ``ft.Icons``.

    Handles the Flet 0.30+ regression where ``ft.icons`` (lowercase) is
    bound to a *module*, not the enum, so the attribute lookups all
    fail. Also tries common variant suffixes (``_ROUNDED``, ``_OUTLINED``,
    ``_SHARP``) for icons that only exist as variants in some versions.
    """
    if not (hasattr(ft, 'Icons') and ft.Icons is not None):
        print("[COMPAT][WARN] ft.Icons is not available; leaving ft.icons as-is", file=sys.stderr, flush=True)
        return

    icons_enum = ft.Icons

    def _resolve_icon_name(name: str):
        if hasattr(icons_enum, name):
            return getattr(icons_enum, name)
        for suffix in ("_ROUNDED", "_OUTLINED", "_SHARP"):
            if hasattr(icons_enum, name + suffix):
                return getattr(icons_enum, name + suffix)
        # Neutral fallback so a missing icon doesn't crash the page.
        return getattr(icons_enum, "HELP_OUTLINE", "help")

    class IconsProxy:
        def __getattr__(self, name):
            return _resolve_icon_name(name)

    ft.icons = IconsProxy()
    print("[COMPAT] Using proxied ft.Icons", file=sys.stderr, flush=True)


def _patch_flet_widgets():
    """Bridge widget kwargs that were renamed/restructured in Flet 0.80+.

    This codebase carries lots of pre-0.80 idioms:

      * ``ft.PopupMenuItem(text=...)``  -> kwarg renamed to ``content=``
      * ``ft.Tab(text=..., content=...)`` -> ``label=`` for the strip;
        ``content`` is no longer carried by Tab itself.
      * ``ft.Tabs(tabs=[...])``         -> Tabs now takes a single
        ``content=Control`` + ``length=int``, with the bar / body managed
        externally. We synthesize a TabBar + a swapping container.
      * ``ft.Dropdown(on_change=...)``  -> renamed to ``on_select=``.
      * ``ft.ElevatedButton(text=...)`` / ``ft.Button(text=...)`` etc.
        -> the first slot is now ``content=``.

    Sweeping every call site is the "right" fix; until that lands,
    these monkey-patches keep the legacy idioms working on a modern
    Flet so the app actually boots. They're safe to remove once the
    legacy kwargs are gone from the codebase.
    """

    import inspect

    def _signature_params(cls):
        try:
            return set(inspect.signature(cls.__init__).parameters)
        except (ValueError, TypeError):
            return set()

    def _alias_kwarg(cls, old_name, new_name):
        """Make ``cls(old_name=X, ...)`` rewrite to ``cls(new_name=X, ...)``.

        No-op if the class still accepts ``old_name`` (i.e. we're on a Flet
        where the rename hasn't happened yet) or doesn't accept ``new_name``
        (i.e. neither name works — let the real error surface).
        """
        if cls is None:
            return
        params = _signature_params(cls)
        if old_name in params or new_name not in params:
            return
        orig_init = cls.__init__

        def patched(self, *args, **kwargs):
            if old_name in kwargs and new_name not in kwargs:
                kwargs[new_name] = kwargs.pop(old_name)
            orig_init(self, *args, **kwargs)

        cls.__init__ = patched

    # ft.View positional order changed: pre-0.80 was View(route, controls, ...);
    # 0.80+ is View(controls, route, ...). The codebase uses the legacy order
    # in many places (e.g. ft.View("/login", [...]) ), which on 0.82 silently
    # makes the route a list and controls a string -> blank screen, no error.
    # Detect by first-positional being a str ("/route") and second being a list,
    # and swap. Skip if kwargs already specify controls or route explicitly.
    View = getattr(ft, "View", None)
    if View is not None:
        view_params = _signature_params(View)
        # Only patch when the modern signature has controls as the first param
        # (i.e. before route) and we have access to both names.
        try:
            param_names = list(inspect.signature(View.__init__).parameters)
            modern_order = (
                "controls" in param_names
                and "route" in param_names
                and param_names.index("controls") < param_names.index("route")
            )
        except (ValueError, TypeError):
            modern_order = False

        if modern_order:
            orig_view_init = View.__init__

            def patched_view_init(self, *args, **kwargs):
                if (
                    len(args) >= 2
                    and isinstance(args[0], str)
                    and isinstance(args[1], list)
                    and "controls" not in kwargs
                    and "route" not in kwargs
                ):
                    # Legacy positional order: View(route_str, controls_list, ...)
                    new_args = (args[1], args[0]) + args[2:]
                    args = new_args
                orig_view_init(self, *args, **kwargs)

            View.__init__ = patched_view_init

    # PopupMenuItem(text=) -> content=
    _alias_kwarg(getattr(ft, "PopupMenuItem", None), "text", "content")

    # Dropdown(on_change=) -> on_select=
    _alias_kwarg(getattr(ft, "Dropdown", None), "on_change", "on_select")

    # Buttons: text= -> content=. Patch every Button-like class we use.
    for name in ("ElevatedButton", "Button", "TextButton", "OutlinedButton", "FilledButton", "FilledTonalButton"):
        _alias_kwarg(getattr(ft, name, None), "text", "content")

    # Tab: text= -> label=, plus stash `content` for our Tabs shim to read.
    # Only patch on Flet versions where Tab no longer carries content directly.
    Tab = getattr(ft, "Tab", None)
    if Tab is not None and "content" not in _signature_params(Tab):
        orig_tab_init = Tab.__init__

        def patched_tab_init(self, *args, **kwargs):
            if "text" in kwargs and "label" not in kwargs and "label" in _signature_params(Tab):
                kwargs["label"] = kwargs.pop("text")
            stashed_content = kwargs.pop("content", None)
            orig_tab_init(self, *args, **kwargs)
            self._legacy_content = stashed_content

        Tab.__init__ = patched_tab_init

    # Tabs(tabs=[Tab(content=..., label=...), ...]) -> rebuild with TabBar +
    # a swapping Container as the Tabs.content. Only patch on Flet versions
    # where Tabs no longer accepts a ``tabs`` kwarg.
    Tabs = getattr(ft, "Tabs", None)
    TabBar = getattr(ft, "TabBar", None)
    if Tabs is not None and TabBar is not None and "tabs" not in _signature_params(Tabs):
        orig_tabs_init = Tabs.__init__

        def patched_tabs_init(self, *args, **kwargs):
            old_tabs = kwargs.pop("tabs", None)
            if old_tabs is not None and "content" not in kwargs:
                initial = getattr(old_tabs[0], "_legacy_content", None) if old_tabs else None
                body = ft.Container(content=initial, expand=True)
                bar = TabBar(tabs=list(old_tabs))

                user_on_change = kwargs.pop("on_change", None)

                def _on_change(e):
                    idx = getattr(e.control, "selected_index", 0)
                    if 0 <= idx < len(old_tabs):
                        body.content = getattr(old_tabs[idx], "_legacy_content", None)
                        try:
                            body.update()
                        except Exception:
                            pass
                    if callable(user_on_change):
                        user_on_change(e)

                kwargs["on_change"] = _on_change
                kwargs["length"] = len(old_tabs)
                kwargs["content"] = ft.Column([bar, body], expand=True)
            orig_tabs_init(self, *args, **kwargs)

        Tabs.__init__ = patched_tabs_init


def _patch_flet_alignment():
    """Add legacy lowercase aliases (``ft.alignment.center`` etc.) on the
    ``ft.alignment`` module.

    Pre-0.80 Flet exposed ``ft.alignment.center``, ``ft.alignment.top_left``,
    etc. as ready-made ``Alignment`` instances on the module. Flet 0.80+
    promoted these to *class* attributes on ``ft.Alignment`` (uppercase),
    so ``ft.alignment.center`` raises ``AttributeError: module
    'flet.controls.alignment' has no attribute 'center'``. We add
    lowercase aliases on the module that point at the uppercase class
    constants so legacy call sites keep working.
    """
    alignment_mod = getattr(ft, "alignment", None)
    Alignment = getattr(ft, "Alignment", None)
    if alignment_mod is None or Alignment is None:
        return

    name_pairs = [
        ("center", "CENTER"),
        ("top_center", "TOP_CENTER"),
        ("top_left", "TOP_LEFT"),
        ("top_right", "TOP_RIGHT"),
        ("center_left", "CENTER_LEFT"),
        ("center_right", "CENTER_RIGHT"),
        ("bottom_center", "BOTTOM_CENTER"),
        ("bottom_left", "BOTTOM_LEFT"),
        ("bottom_right", "BOTTOM_RIGHT"),
    ]
    aliased = []
    for lower, upper in name_pairs:
        if hasattr(alignment_mod, lower):
            continue
        value = getattr(Alignment, upper, None)
        if value is None:
            continue
        try:
            setattr(alignment_mod, lower, value)
            aliased.append(lower)
        except (AttributeError, TypeError):
            # Some Flet builds expose `alignment` as an immutable namespace.
            pass
    if aliased:
        print(f"[COMPAT] Aliased legacy ft.alignment names: {', '.join(aliased)}", file=sys.stderr, flush=True)


def _patch_flet_padding_and_margin():
    """Patch ``ft.Padding`` / ``ft.Margin`` to expose ``symmetric`` /
    ``only`` / ``all`` shortcuts on releases that moved them onto the
    lowercase ``ft.padding`` / ``ft.margin`` modules.
    """
    if hasattr(ft, 'Padding'):
        if not hasattr(ft.Padding, 'symmetric'):
            try:
                ft.Padding.symmetric = staticmethod(
                    lambda horizontal=0, vertical=0: ft.padding.symmetric(horizontal=horizontal, vertical=vertical)
                )
            except Exception:
                pass
        if not hasattr(ft.Padding, 'all'):
            try:
                ft.Padding.all = staticmethod(lambda value: ft.padding.all(value))
            except Exception:
                pass

    if hasattr(ft, 'Margin'):
        if not hasattr(ft.Margin, 'only'):
            try:
                ft.Margin.only = staticmethod(
                    lambda left=0, top=0, right=0, bottom=0: ft.margin.only(left=left, top=top, right=right, bottom=bottom)
                )
            except Exception:
                pass
        if not hasattr(ft.Margin, 'symmetric'):
            try:
                ft.Margin.symmetric = staticmethod(
                    lambda horizontal=0, vertical=0: ft.margin.symmetric(horizontal=horizontal, vertical=vertical)
                )
            except Exception:
                pass


# Apply patches at import time. main.py imports this module first so the
# proxies are in place before any view code touches ft.colors / ft.icons.
print("[COMPAT] Applying patches...", file=sys.stderr, flush=True)
_patch_flet_colors()
_patch_flet_icons()
_patch_flet_widgets()
_patch_flet_alignment()
_patch_flet_padding_and_margin()
print("[COMPAT] All patches applied successfully", file=sys.stderr, flush=True)
