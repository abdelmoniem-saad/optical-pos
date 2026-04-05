import os
import tempfile
import json
from pathlib import Path

# --- Environment Detection ---
# Check if running on a server (Render, Railway, etc.) or web
IS_SERVER = bool(
	os.environ.get("RENDER")
	or os.environ.get("RAILWAY_ENVIRONMENT")
	or os.environ.get("FLY_APP_NAME")
)
IS_WEB = bool("PYODIDE_RUNTIME" in os.environ or IS_SERVER)

# --- Local SQLite Configuration ---
# Used by legacy Flask bridge and any local-only workflows.
DB_FILENAME = os.environ.get("DB_FILENAME", "pos_data.db")

# --- Supabase Configuration ---
def _load_supabase_config_file() -> dict:
	"""Load Supabase credentials from a bundled JSON file if present."""
	config_path = os.environ.get("LENSY_SUPABASE_CONFIG")
	candidates = []
	if config_path:
		candidates.append(Path(config_path))

	# Bundled path for desktop/APK builds.
	candidates.append(Path(__file__).resolve().parent / "supabase_config.json")
	# Optional project-root path for local runs.
	candidates.append(Path.cwd() / "supabase_config.json")

	for candidate in candidates:
		try:
			if candidate.exists():
				with candidate.open("r", encoding="utf-8") as f:
					payload = json.load(f)
				if isinstance(payload, dict):
					return payload
		except Exception:
			continue

	return {}


_SUPABASE_FILE = _load_supabase_config_file()
SUPABASE_URL = (
	os.environ.get("SUPABASE_URL")
	or os.environ.get("LENSY_SUPABASE_URL")
	or _SUPABASE_FILE.get("url")
)
SUPABASE_KEY = (
	os.environ.get("SUPABASE_KEY")
	or os.environ.get("LENSY_SUPABASE_KEY")
	or _SUPABASE_FILE.get("key")
)

# Controls backend behavior:
# - "auto" (default): use Supabase when available, else local JSON.
# - "supabase": fail fast if Supabase credentials/client are unavailable.
# - "local": always use local JSON.
DATA_BACKEND = os.environ.get("LENSY_DATA_BACKEND", "auto").strip().lower()
if DATA_BACKEND not in {"auto", "supabase", "local"}:
	DATA_BACKEND = "auto"
FORCE_SUPABASE = DATA_BACKEND == "supabase"

# --- Local Fallback ---
# Use Supabase if URL and KEY are available, otherwise use local JSON
def _pick_writable_app_data_dir() -> str:
	"""Pick a writable directory without crashing import-time on restricted runtimes."""

	env_dir = os.environ.get("LENSY_APP_DATA_DIR")
	candidates = []
	if env_dir:
		candidates.append(Path(env_dir))

	# Prefer user-home path on desktop, but Android/iOS sandboxes may reject it.
	candidates.append(Path.home() / ".lensypos")
	# Temp dir is usually writable on mobile packaged runtimes.
	candidates.append(Path(tempfile.gettempdir()) / "lensypos")
	# Working directory fallback.
	candidates.append(Path.cwd() / ".lensypos")

	for candidate in candidates:
		try:
			candidate.mkdir(parents=True, exist_ok=True)
			return str(candidate)
		except Exception:
			continue

	# Last resort: current directory without mkdir side effects.
	return str(Path.cwd())


APP_DATA_DIR = _pick_writable_app_data_dir()
LOCAL_JSON_DB = str(Path(APP_DATA_DIR) / "pos_data.json")
USE_SUPABASE = (DATA_BACKEND != "local") and bool(SUPABASE_URL and SUPABASE_KEY)
USE_LOCAL_DB = not USE_SUPABASE

