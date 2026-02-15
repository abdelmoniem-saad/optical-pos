import os

# --- Environment Detection ---
# Check if running on a server (Render, Railway, etc.) or web
IS_SERVER = os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("FLY_APP_NAME")
IS_WEB = 'PYODIDE_RUNTIME' in os.environ or IS_SERVER

# --- Supabase Configuration ---
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# --- Local Fallback ---
# Use Supabase if URL and KEY are available, otherwise use local JSON
LOCAL_JSON_DB = "pos_data.json"
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)
USE_LOCAL_DB = not USE_SUPABASE

