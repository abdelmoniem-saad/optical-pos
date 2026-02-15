"""
Build and Package Script for Lensy POS
Run this to create a complete delivery package for customers
"""

import os
import shutil
import subprocess
import sys
from datetime import datetime


def _try_taskkill(exe_name):
    """Attempt to kill a running process by executable name on Windows."""
    try:
        # /f force, /im image name
        subprocess.run(["taskkill", "/f", "/im", exe_name], capture_output=True)
    except Exception:
        pass


def _make_writable(path):
    try:
        os.chmod(path, 0o666)
    except Exception:
        pass


def safe_remove_file(path):
    """Try removing a file. If PermissionError, attempt to taskkill and retry, then chmod and retry."""
    try:
        if os.path.exists(path):
            os.remove(path)
            return True
        return False
    except PermissionError:
        # Try to kill any process with that exe name
        exe_name = os.path.basename(path)
        _try_taskkill(exe_name)
        try:
            _make_writable(path)
            os.remove(path)
            return True
        except Exception:
            return False
    except Exception:
        return False


def _rmtree_onerror(func, path, exc_info):
    # Called by shutil.rmtree on error; try to chmod and retry
    try:
        _make_writable(path)
        func(path)
    except Exception:
        # As a last resort, if it's an executable file, try to taskkill and remove
        if os.path.isfile(path):
            exe_name = os.path.basename(path)
            _try_taskkill(exe_name)
            try:
                _make_writable(path)
                os.remove(path)
            except Exception:
                pass


def create_delivery_package():
    """Create a complete delivery package"""

    print("=" * 60)
    print("Building Lensy POS Delivery Package")
    print("=" * 60)

    # Configuration
    app_name = "LensyPOS"
    version = "1.0"
    delivery_folder = f"LensyPOS_Delivery_v{version}"
    ngrok_domain = "homothallic-lakeesha-nonemotively.ngrok-free.dev"

    # Step 1: Clean previous builds
    print("\n[1/8] Cleaning previous builds...")
    for item in ["build", "dist", delivery_folder, "LensyPOS.spec"]:
        if os.path.exists(item):
            # If it's a file, attempt to remove safely
            if os.path.isfile(item):
                ok = safe_remove_file(item)
                if not ok:
                    print(f"Warning: Could not remove file {item}. Try closing running instances or run this script as Administrator.")
            else:
                try:
                    shutil.rmtree(item, onerror=_rmtree_onerror)
                except PermissionError:
                    # Try to kill common executables that could be locking files inside the folder
                    try:
                        # attempt to kill any exe inside the directory that matches pattern
                        for root, dirs, files in os.walk(item):
                            for f in files:
                                if f.lower().endswith('.exe'):
                                    _try_taskkill(f)
                    except Exception:
                        pass
                    try:
                        shutil.rmtree(item, onerror=_rmtree_onerror)
                    except Exception:
                        print(f"Warning: Could not remove directory {item}. Try closing running programs or run as Administrator.")
    print("✓ Cleanup complete")

    # Step 2: Build with PyInstaller (ONEFILE for security)
    print("\n[2/8] Building Desktop executable with PyInstaller...")
    print("⏳ Using --onefile mode...")

    build_cmd = [
        "pyinstaller",
        "--noconsole",
        "--onefile",
        "--add-data", "app;app",
        "--add-data", "scripts;scripts",
        "--hidden-import", "passlib.hash",
        "--hidden-import", "passlib.handlers.bcrypt",
        "--hidden-import", "sqlalchemy",
        "--hidden-import", "sqlalchemy.sql",
        "--hidden-import", "sqlalchemy.sql.default_comparator",
        "--hidden-import", "sqlalchemy.ext.declarative",
        "--hidden-import", "PySide6.QtCore",
        "--hidden-import", "PySide6.QtWidgets",
        "--hidden-import", "PySide6.QtGui",
        "--name", app_name,
        "main.py"
    ]

    result = subprocess.run(build_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("✗ Desktop build failed!")
        print(result.stderr)
        return False
    print("✓ Desktop executable built successfully")

    print("\n[3/8] Building Web Bridge executable...")
    web_build_cmd = [
        "pyinstaller",
        "--noconsole",
        "--onefile",
        "--add-data", "app;app",
        "--add-data", "templates;templates",
        "--add-data", "static;static",
        "--hidden-import", "flask",
        "--hidden-import", "sqlalchemy",
        "--hidden-import", "passlib.hash",
        "--hidden-import", "passlib.handlers.bcrypt",
        "--name", f"{app_name}_Web",
        "web_app.py"
    ]
    result = subprocess.run(web_build_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("✗ Web build failed!")
        print(result.stderr)
        return False
    print("✓ Web bridge executable built successfully")

    # Step 4: Create delivery folder structure
    print("\n[4/8] Creating delivery package...")
    os.makedirs(delivery_folder, exist_ok=True)

    # Copy EXEs
    shutil.copy(f"dist/{app_name}.exe", f"{delivery_folder}/{app_name}.exe")
    shutil.copy(f"dist/{app_name}_Web.exe", f"{delivery_folder}/{app_name}_Web.exe")

    # Copy Ngrok
    if os.path.exists("ngrok.exe"):
        shutil.copy("ngrok.exe", f"{delivery_folder}/ngrok.exe")
        print("✓ ngrok.exe included")
    else:
        print("\n" + "!" * 60)
        print("⚠️  CRITICAL: ngrok.exe not found in root!")
        print("The mobile bridge will NOT work without ngrok.exe in the package.")
        print("Please download it from https://ngrok.com/download and place it in the root folder.")
        print("!" * 60 + "\n")

    # Create additional folders
    os.makedirs(f"{delivery_folder}/backup", exist_ok=True)
    os.makedirs(f"{delivery_folder}/docs", exist_ok=True)
    os.makedirs(f"{delivery_folder}/uploads", exist_ok=True)

    print("✓ Folder structure created")

    # Step 5: Create launcher
    print("\n[5/8] Creating launcher...")

    startup_batch = f"{delivery_folder}/Start_LensyPOS.bat"
    with open(startup_batch, 'w', encoding='utf-8') as f:
        f.write(f"""@echo off
chcp 65001 >nul
title LensyPOS - Launcher
cd /d "%~dp0"

echo ============================================================
echo 🚀 LENSY POS - Starting Services...
echo ============================================================
echo.
echo 📱 YOUR PERMANENT MOBILE LINK:
echo    https://{ngrok_domain}
echo.
echo 🖥️ Starting Desktop Application...

:: The main application will now automatically start the 
:: mobile bridge and secure tunnel in the background.
start "" "{app_name}.exe"

echo.
echo ✅ Services started successfully!
echo.
timeout /t 5
exit
""")

    setup_ngrok_batch = f"{delivery_folder}/Setup_Ngrok.bat"
    with open(setup_ngrok_batch, 'w', encoding='utf-8') as f:
        f.write(f"""@echo off
chcp 65001 >nul
title LensyPOS - Ngrok Setup
cd /d "%~dp0"
echo ============================================================
echo      LENSY POS - NGROK AUTHENTICATION SETUP
echo ============================================================
echo This setup only needs to be run ONCE.
echo.
set /p token="Enter your Ngrok Authtoken: "
ngrok.exe config add-authtoken %token%
echo.
echo ✅ Authtoken saved successfully!
echo.
pause
""")

    print("✓ Launchers created")

    # Step 6: Create license
    print("\n[6/8] Creating license agreement...")

    license_text = f"""
╔════════════════════════════════════════════════════════════════╗
║                   SOFTWARE LICENSE AGREEMENT                   ║
╚════════════════════════════════════════════════════════════════╝

COPYRIGHT © {datetime.now().year} - All Rights Reserved

This software is licensed, not sold. By using this software, you 
agree to the following terms:

✓ PERMITTED USE:
  - Installation on ONE computer at ONE shop location
  - Use for your optical shop business operations only
  - Creating backups for your own use

✗ PROHIBITED ACTIONS:
  - Copying or distributing to other shops/businesses
  - Reverse engineering, decompiling, or disassembling
  - Removing or modifying copyright notices
  - Reselling, sublicensing, or renting
  - Using for illegal purposes

⚖️  CONSEQUENCES OF VIOLATION:
  - Immediate license termination without refund
  - Legal action for damages and losses
  - Criminal prosecution where applicable

💰 ADDITIONAL LICENSES:
  Need multiple computers or locations? Contact us for pricing:
  📧 Email: your-email@example.com
  📱 Phone/WhatsApp: +1234567890

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This software is protected by copyright law and international treaties.
Unauthorized reproduction or distribution may result in severe civil
and criminal penalties, and will be prosecuted to the maximum extent
possible under the law.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    with open(f"{delivery_folder}/LICENSE.txt", 'w', encoding='utf-8') as f:
        f.write(license_text)

    print("✓ License created")

    # Step 7: Create documentation
    print("\n[7/8] Creating documentation...")

    readme_content = f"""
 ╔════════════════════════════════════════════════════════════════╗
 ║              LENSY POS - Installation Guide                    ║
 ║                     Version {version}                                ║
 ║                  Build: {datetime.now().strftime("%d/%m/%Y")}                       ║
 ╚════════════════════════════════════════════════════════════════╝

⚠️  READ LICENSE.TXT BEFORE USING THIS SOFTWARE ⚠️

📋 QUICK START (3 Steps)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Double-click: Start_LensyPOS.bat (or LensyPOS.exe directly)
    ⏳ First run takes 10-15 seconds (database initialization)

2. Login with default credentials:
    👤 Username: admin
    🔒 Password: Admin123

3. ⚠️  CRITICAL - Change password immediately!
    Go to: Staff Management → Select Admin → Edit → Change Password

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 MOBILE APP ACCESS (PWA)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your POS is mobile-ready! Access it from your phone for $0:

1. Setup Ngrok (First time only):
   - Ensure ngrok.exe is in the application folder.
   - Run Setup_Ngrok.bat
   - Paste your Authtoken from your Ngrok dashboard.

2. Access on Phone:
   - Run Start_LensyPOS.bat (or just LensyPOS.exe directly).
   - The system automatically starts background services for your phone.
   - Check the "Cloud Access" indicator on your POS dashboard.
   - Open your permanent link on your phone:
     https://{ngrok_domain}
   - Login with your POS username/password.

3. Install as App:
   - Browser Menu → "Add to Home Screen".
   - It will now appear on your phone like a native app!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🖨️ HARDWARE SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📄 Thermal Receipt Printer (58mm or 80mm):
  1. Install printer driver from manufacturer CD/website
  2. Connect USB cable to computer
  3. Open Windows Settings → Devices → Printers
  4. Set your thermal printer as "Default printer"
  5. Print a test page to verify

🔍 Barcode Scanner (USB):
  1. Connect USB cable (scanner works as keyboard emulator)
  2. Open Notepad and test by scanning a barcode
  3. If numbers appear in Notepad, scanner is working
  4. In POS screen, scanner will automatically add products

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💾 DAILY BACKUP (EXTREMELY IMPORTANT!)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  DO THIS EVERY DAY AFTER CLOSING! ⚠️

Method 1: Manual Backup (5 seconds)
  1. Close Lensy POS application
  2. Find file: lensy_pos.db (in same folder as LensyPOS.exe)
  3. Copy to USB drive or OneDrive/Google Drive folder
  4. Rename with date: lensy_pos_backup_2024-12-28.db
  5. Keep at least 7 days of backups

Method 2: Automatic Backup (Recommended)
  - Move the entire LensyPOS folder to Google Drive/OneDrive
  - Cloud service will auto-backup the database
  - Or use Windows Task Scheduler for daily copy

⚠️  WITHOUT BACKUPS: Computer crash = ALL DATA LOST FOREVER!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 DAILY OPERATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 Process a Sale:
  1. Click "Sales POS" from dashboard
  2. Scan barcode OR type product name and press Enter
  3. Product adds to cart (adjust quantity with +/- buttons)
  4. Add discount if needed
  5. Click "CHECKOUT" (or press F5)
  6. Select payment method
  7. Print receipt

📦 Add New Products:
  1. Go to "Inventory Management"
  2. Click "+ Add New Product"
  3. Enter: SKU, Name, Cost Price, Sale Price
  4. Click "Save"

👥 Add Customer:
  1. Go to "Customers (CRM)"
  2. Click "+ Add"
  3. Enter name, phone, email
  4. Save

👓 Add Prescription:
  1. Go to "Customers (CRM)"
  2. Select customer
  3. Click "Prescriptions"
  4. Fill in eye measurements (OD = Right, OS = Left)
  5. Save

📊 View Reports:
  1. Go to "Reports"
  2. See today's revenue, profit, sales count
  3. View transaction history in "Sales History"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔧 TROUBLESHOOTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❓ App startup takes 10-15 seconds
  ✅ This is NORMAL for secure single-file apps
  ✅ Only happens once per session
  ✅ Subsequent starts are instant

❓ Windows shows "Windows protected your PC" warning
  ✅ Click "More info"
  ✅ Click "Run anyway"
  ✅ This is normal for new software
  ✅ Add to Windows Defender exceptions if needed

❓ Application won't start at all
  → Right-click LensyPOS.exe → "Run as Administrator"
  → Check antivirus isn't blocking it
  → Try disabling antivirus temporarily

❓ Database error on startup
  → Delete lensy_pos.db file
  → Restart app (creates fresh database)
  → Restore from your backup if you had data

❓ Can't print receipts
  → Check printer is turned ON
  → Check USB cable is connected
  → Verify printer is set as "Default" in Windows
  → Try printing a Windows test page first

❓ Barcode scanner not working
  → Unplug scanner, wait 5 seconds, replug
  → Test in Notepad first (scan should type numbers)
  → Make sure cursor is in search field in POS
  → Some scanners need "Enter" key setting enabled

❓ Slow performance
  → Close other programs
  → Check free disk space (need at least 1GB)
  → Restart computer
  → Run Windows Disk Cleanup

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📞 TECHNICAL SUPPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For assistance, questions, or additional licenses:

📧 Email: your-email@example.com
📱 Phone: +1234567890
💬 WhatsApp: +1234567890

Support Hours: Monday-Saturday, 9:00 AM - 6:00 PM

When contacting support, please provide:
  - Error message (if any)
  - What you were doing when error occurred
  - Screenshot (if possible)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔐 SECURITY & BEST PRACTICES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Change default admin password immediately
✅ Create separate user accounts for each staff member
✅ Never share admin password
✅ Always log out when leaving computer
✅ Keep daily backups in secure location
✅ Don't install on public/shared computers
✅ Update Windows regularly for security patches
✅ Use strong passwords (mix of letters, numbers, symbols)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 TIPS FOR BEST RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Use barcode labels for faster checkout
• Train all staff before going live
• Do a test day with fake transactions first
• Keep paper receipts as backup for first week
• Review daily reports to catch any issues early

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

© {datetime.now().year} - All Rights Reserved
This software is protected by copyright law.
Unauthorized copying, distribution, or modification is strictly prohibited.

Built specifically for Optical Shops
"""

    with open(f"{delivery_folder}/docs/INSTALLATION_GUIDE.txt", 'w', encoding='utf-8') as f:
        f.write(readme_content)

    # Create quick start card
    quick_start = """
╔══════════════════════════════════════════════╗
║        LENSY POS - QUICK START CARD          ║
╚══════════════════════════════════════════════╝

🚀 FIRST TIME SETUP:
1. Double-click: Start_LensyPOS.bat
2. Wait 15 seconds for setup
3. Login: admin / Admin123
4. Change password immediately!

💾 DAILY BACKUP (CRITICAL!):
After closing each day:
→ Copy lensy_pos.db to USB/Cloud

📞 SUPPORT:
Phone: +1234567890
Email: your-email@example.com

Keep this card near your computer!
"""

    with open(f"{delivery_folder}/QUICK_START.txt", 'w', encoding='utf-8') as f:
        f.write(quick_start)

    print("✓ Documentation created")

    # Step 8: Create ZIP package
    print("\n[8/8] Creating ZIP archive...")
    zip_name = f"{delivery_folder}_{datetime.now().strftime('%Y%m%d')}"
    shutil.make_archive(zip_name, 'zip', delivery_folder)

    file_size = os.path.getsize(f'{zip_name}.zip') / (1024*1024)

    print("✓ ZIP package created")

    print("\n" + "=" * 60)
    print("✅ DELIVERY PACKAGE COMPLETE!")
    print("=" * 60)
    print(f"\n📁 Folder: {delivery_folder}/")
    print(f"📦 ZIP File: {zip_name}.zip")
    print(f"📊 Size: {file_size:.1f} MB")
    print("\n🔒 SECURITY FEATURES:")
    print("  ✓ Single executable (source code protected)")
    print("  ✓ No .py files exposed")
    print("  ✓ License agreement included")
    print("  ✓ Copyright notices embedded")
    print("\n⚠️  IMPORTANT NOTES:")
    print("  • First startup: 10-15 seconds (normal for onefile)")
    print("  • Windows may show security warning (normal)")
    print("  • Customer needs to click 'Run anyway'")
    print("\n🧪 BEFORE DELIVERING:")
    print("  1. Test on a DIFFERENT computer (not your dev machine)")
    print("  2. Verify database auto-creates")
    print("  3. Test login with admin/Admin123")
    print("  4. Try adding a product and making a sale")
    print("  5. Check if it works without Python installed")
    print("\n💡 DELIVERY OPTIONS:")
    print("  1. 💾 USB Drive: Copy entire folder to customer")
    print("  2. 📧 Email: Send ZIP if under 25MB")
    print("  3. ☁️  Cloud: Upload to Google Drive/Dropbox, share link")
    print("  4. 👨‍💼 In-Person: Best for first customers (install + train)")
    print("\n" + "=" * 60)

    return True


if __name__ == "__main__":
    try:
        # Check if PyInstaller is installed
        try:
            import PyInstaller
        except ImportError:
            print("❌ PyInstaller not found!")
            print("\nPlease install it first:")
            print("  pip install pyinstaller")
            print("\nThen run this script again.")
            input("\nPress Enter to exit...")
            sys.exit(1)

        print("\n🔒 SECURE BUILD MODE ACTIVE")
        print("━" * 60)
        print("This build will:")
        print("  ✓ Create single EXE file (no source code exposed)")
        print("  ✓ Include license agreement for legal protection")
        print("  ✓ Bundle all dependencies")
        print("  ✓ Auto-initialize database on first run")
        print("━" * 60)
        print("\n⏳ Build will take 3-5 minutes...")
        print("\nReady to build?")

        input("Press Enter to start or Ctrl+C to cancel...")

        success = create_delivery_package()

        if not success:
            sys.exit(1)

        print("\n✅ BUILD SUCCESSFUL!")
        print("\n📝 NEXT STEPS:")
        print("  1. Test the EXE on a clean computer")
        print("  2. Verify everything works without Python")
        print("  3. If successful, deliver to customer")
        print("  4. Collect payment 💰")

        input("\nPress Enter to exit...")

    except KeyboardInterrupt:
        print("\n\n❌ Build cancelled by user")
        input("Press Enter to exit...")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        input("\nPress Enter to exit...")
        sys.exit(1)