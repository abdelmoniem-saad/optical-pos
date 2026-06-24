"""Pytest config — ensures the Flet compat shim is loaded before any test
imports `flet`. Mirrors what main.py does at boot. Without this, tests that
exercise UI code can hit AttributeError on color/icon names that the shim
papers over at runtime.
"""

import app.flet_compat  # noqa: F401  (import for side effects)
