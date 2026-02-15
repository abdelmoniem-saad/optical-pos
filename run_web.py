# run_web.py
import subprocess
import sys
import os

def run():
    print("🚀 Starting Optical Shop POS Web Bridge...")
    print("📍 Local Access: http://127.0.0.1:5000")
    print("💡 To access from mobile, ensure you are on the same WiFi or use a tunnel.")
    
    # Set the path to the current directory
    current_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(current_dir)
    
    try:
        from web_app import app
        app.run(host='0.0.0.0', port=5000)
    except ImportError:
        print("❌ Error: Flask not found. Please run: pip install Flask")
    except Exception as e:
        print(f"❌ Error starting server: {e}")

if __name__ == "__main__":
    run()

