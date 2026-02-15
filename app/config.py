import os

# --- Environment Detection ---
# We assume it's a web environment if 'PYODIDE_RUNTIME' is set, a common indicator for Pyodide.
IS_WEB = 'PYODIDE_RUNTIME' in os.environ

# --- Supabase Configuration ---
# In a real web deployment (like GitHub Pages), these would be set as environment variables.
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# --- Local Fallback ---
# If not in a web environment or if Supabase keys are missing, use a local JSON file.
LOCAL_JSON_DB = "pos_data.json"
USE_LOCAL_DB = not (IS_WEB and SUPABASE_URL and SUPABASE_KEY)
