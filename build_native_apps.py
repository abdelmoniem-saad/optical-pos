"""
Lensy POS - Native App Builder
Build native desktop and mobile applications using Flet

Supported platforms:
- Windows (.exe)
- macOS (.app)
- Linux
- Android (.apk / .aab)
- iOS (.ipa)
- Web (static files)

Requirements:
- Flet >= 0.21.0
- Flutter SDK (auto-installed by flet build)
- For Android: Android SDK
- For iOS: Xcode (macOS only)
- For Windows: Visual Studio Build Tools
"""

import os
import sys
import subprocess
import shutil
import argparse
from datetime import datetime


# App Configuration
APP_NAME = "LensyPOS"
APP_VERSION = "1.0.0"
APP_DESCRIPTION = "Lensy POS - Point of Sale System for Optical Stores"
APP_ORG = "com.lensy"
APP_PACKAGE = f"{APP_ORG}.pos"

# Enable licensing in production builds
ENABLE_LICENSING = True


def run_command(cmd, description, show_output=True):
    """Run a shell command and handle errors."""
    print(f"\n{'='*60}")
    print(f"🔧 {description}")
    print(f"{'='*60}")
    print(f"Running: {' '.join(cmd)}\n")

    try:
        if show_output:
            result = subprocess.run(cmd, check=True)
        else:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Error: {description} failed!")
        if hasattr(e, 'stderr') and e.stderr:
            print(e.stderr)
        return False
    except FileNotFoundError:
        print(f"❌ Command not found: {cmd[0]}")
        return False


def check_prerequisites():
    """Check if required tools are installed."""
    print("\n🔍 Checking prerequisites...")

    # Check Python
    print(f"  ✅ Python {sys.version.split()[0]}")

    # Check Flet
    try:
        import flet
        flet_version = getattr(flet, '__version__', 'unknown')
        print(f"  ✅ Flet {flet_version}")
    except ImportError:
        print("  ❌ Flet not installed. Run: pip install flet")
        return False

    # Check Flutter (optional, flet build will install if needed)
    try:
        result = subprocess.run(["flutter", "--version"], capture_output=True, text=True)
        if result.returncode == 0:
            version_line = result.stdout.split('\n')[0]
            print(f"  ✅ {version_line}")
    except FileNotFoundError:
        print("  ⚠️  Flutter not found (will be installed automatically)")

    return True


def build_windows():
    """Build Windows executable using Flet."""
    print("\n" + "="*60)
    print("🪟 Building Windows Application")
    print("="*60)

    cmd = [
        "flet", "build", "windows",
        "--project", APP_NAME,
        "--description", APP_DESCRIPTION,
        "--product", APP_NAME,
        "--org", APP_ORG,
        "--company", "Lensy",
        "--copyright", f"(c) {datetime.now().year} Lensy",
        "--module-name", "main",
    ]

    return run_command(cmd, "Building Windows executable")


def build_macos():
    """Build macOS application using Flet."""
    print("\n" + "="*60)
    print("🍎 Building macOS Application")
    print("="*60)

    cmd = [
        "flet", "build", "macos",
        "--project", APP_NAME,
        "--description", APP_DESCRIPTION,
        "--product", APP_NAME,
        "--org", APP_ORG,
        "--company", "Lensy",
        "--copyright", f"(c) {datetime.now().year} Lensy",
        "--module-name", "main",
    ]

    return run_command(cmd, "Building macOS application")


def build_linux():
    """Build Linux application using Flet."""
    print("\n" + "="*60)
    print("🐧 Building Linux Application")
    print("="*60)

    cmd = [
        "flet", "build", "linux",
        "--project", APP_NAME,
        "--description", APP_DESCRIPTION,
        "--product", APP_NAME,
        "--org", APP_ORG,
        "--module-name", "main",
    ]

    return run_command(cmd, "Building Linux application")


def build_android(apk=True, aab=False):
    """Build Android application using Flet."""
    print("\n" + "="*60)
    print("🤖 Building Android Application")
    print("="*60)

    build_type = "apk" if apk else "aab"

    cmd = [
        "flet", "build", build_type,
        "--project", APP_NAME,
        "--description", APP_DESCRIPTION,
        "--product", APP_NAME,
        "--org", APP_ORG,
        "--module-name", "main",
        "--android-adaptive-icon-background", "#2196F3",
    ]

    return run_command(cmd, f"Building Android {build_type.upper()}")


def build_ios():
    """Build iOS application using Flet."""
    print("\n" + "="*60)
    print("📱 Building iOS Application")
    print("="*60)

    if sys.platform != "darwin":
        print("❌ iOS builds require macOS with Xcode installed.")
        return False

    cmd = [
        "flet", "build", "ipa",
        "--project", APP_NAME,
        "--description", APP_DESCRIPTION,
        "--product", APP_NAME,
        "--org", APP_ORG,
        "--module-name", "main",
    ]

    return run_command(cmd, "Building iOS application")


def build_web():
    """Build web application using Flet."""
    print("\n" + "="*60)
    print("🌐 Building Web Application")
    print("="*60)

    cmd = [
        "flet", "build", "web",
        "--project", APP_NAME,
        "--base-url", "/",
        "--module-name", "main",
    ]

    return run_command(cmd, "Building Web application")


def create_distribution_package(platforms):
    """Create a distribution package with all built apps."""
    print("\n" + "="*60)
    print("📦 Creating Distribution Package")
    print("="*60)

    dist_dir = f"dist/LensyPOS_v{APP_VERSION}"
    os.makedirs(dist_dir, exist_ok=True)

    # Copy build artifacts
    build_dir = "build"
    if os.path.exists(build_dir):
        for platform in platforms:
            platform_build = os.path.join(build_dir, platform)
            if os.path.exists(platform_build):
                dest = os.path.join(dist_dir, platform)
                if os.path.exists(dest):
                    shutil.rmtree(dest)
                shutil.copytree(platform_build, dest)
                print(f"  ✅ Copied {platform} build")

    # Create README
    readme_content = f"""
# Lensy POS v{APP_VERSION}

## Installation Instructions

### Windows
1. Navigate to the `windows` folder
2. Run `{APP_NAME}.exe`

### macOS
1. Navigate to the `macos` folder
2. Open `{APP_NAME}.app`
3. If blocked by Gatekeeper, right-click and select "Open"

### Linux
1. Navigate to the `linux` folder
2. Run `./{APP_NAME}`
3. You may need to: chmod +x {APP_NAME}

### Android
1. Transfer the APK file to your Android device
2. Enable "Install from unknown sources" in settings
3. Tap the APK file to install

### Web
1. Deploy the `web` folder to your web server
2. Or run locally with: python -m http.server 8000

## Default Login
- Username: admin
- Password: Admin123

## Support
Contact your system administrator for support.

© {datetime.now().year} Lensy - All Rights Reserved
"""

    with open(os.path.join(dist_dir, "README.md"), "w") as f:
        f.write(readme_content)

    print(f"\n✅ Distribution package created at: {dist_dir}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Build Lensy POS native applications",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python build_native_apps.py --windows          # Build Windows only
  python build_native_apps.py --android          # Build Android APK
  python build_native_apps.py --all              # Build all platforms
  python build_native_apps.py --windows --web    # Build Windows and Web
        """
    )

    parser.add_argument("--windows", action="store_true", help="Build Windows executable")
    parser.add_argument("--macos", action="store_true", help="Build macOS application")
    parser.add_argument("--linux", action="store_true", help="Build Linux application")
    parser.add_argument("--android", action="store_true", help="Build Android APK")
    parser.add_argument("--android-aab", action="store_true", help="Build Android App Bundle (for Play Store)")
    parser.add_argument("--ios", action="store_true", help="Build iOS application (requires macOS)")
    parser.add_argument("--web", action="store_true", help="Build web application")
    parser.add_argument("--all", action="store_true", help="Build all supported platforms")
    parser.add_argument("--package", action="store_true", help="Create distribution package after building")

    args = parser.parse_args()

    # If no platform specified, show help
    if not any([args.windows, args.macos, args.linux, args.android,
                args.android_aab, args.ios, args.web, args.all]):
        parser.print_help()
        print("\n⚠️  Please specify at least one platform to build.")
        return 1

    print("""
╔════════════════════════════════════════════════════════════════╗
║              LENSY POS - Native App Builder                    ║
║                    Version {version}                               ║
╚════════════════════════════════════════════════════════════════╝
    """.format(version=APP_VERSION))

    # Check prerequisites
    if not check_prerequisites():
        return 1

    results = {}
    platforms_built = []

    # Build requested platforms
    if args.all or args.windows:
        results["Windows"] = build_windows()
        if results["Windows"]:
            platforms_built.append("windows")

    if args.all or args.macos:
        results["macOS"] = build_macos()
        if results["macOS"]:
            platforms_built.append("macos")

    if args.all or args.linux:
        results["Linux"] = build_linux()
        if results["Linux"]:
            platforms_built.append("linux")

    if args.all or args.android:
        results["Android APK"] = build_android(apk=True)
        if results["Android APK"]:
            platforms_built.append("apk")

    if args.android_aab:
        results["Android AAB"] = build_android(apk=False, aab=True)
        if results["Android AAB"]:
            platforms_built.append("aab")

    if args.all or args.ios:
        results["iOS"] = build_ios()
        if results["iOS"]:
            platforms_built.append("ipa")

    if args.all or args.web:
        results["Web"] = build_web()
        if results["Web"]:
            platforms_built.append("web")

    # Create distribution package if requested
    if args.package and platforms_built:
        create_distribution_package(platforms_built)

    # Print summary
    print("\n" + "="*60)
    print("📊 Build Summary")
    print("="*60)

    for platform, success in results.items():
        status = "✅ Success" if success else "❌ Failed"
        print(f"  {platform}: {status}")

    success_count = sum(1 for s in results.values() if s)
    total_count = len(results)

    print(f"\n  Total: {success_count}/{total_count} platforms built successfully")

    if success_count == total_count:
        print("\n🎉 All builds completed successfully!")
        return 0
    else:
        print("\n⚠️  Some builds failed. Check the output above for details.")
        return 1


if __name__ == "__main__":
    sys.exit(main())







