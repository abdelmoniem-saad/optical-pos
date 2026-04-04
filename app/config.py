import os

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
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# --- Local Fallback ---
# Use Supabase if URL and KEY are available, otherwise use local JSON
LOCAL_JSON_DB = "pos_data.json"
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)
USE_LOCAL_DB = not USE_SUPABASE

