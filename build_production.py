"""
Lensy POS - Production Build Script
Builds the application with licensing enabled for vendor distribution.

This creates protected builds that require license activation.
"""

import os
import sys
import subprocess


def main():
    print("""
╔════════════════════════════════════════════════════════════════╗
║         LENSY POS - PRODUCTION BUILD (WITH LICENSING)          ║
╚════════════════════════════════════════════════════════════════╝
    """)

    # Enable licensing for this build
    os.environ["ENABLE_LICENSING"] = "true"

    # Get arguments
    args = sys.argv[1:] if len(sys.argv) > 1 else ["--windows"]

    # Run the build
    cmd = [sys.executable, "build_native_apps.py"] + args

    print(f"Building with licensing ENABLED...")
    print(f"Command: {' '.join(cmd)}\n")

    result = subprocess.run(cmd)

    if result.returncode == 0:
        print("""
╔════════════════════════════════════════════════════════════════╗
║                    BUILD COMPLETE                               ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  The built application requires license activation.            ║
║                                                                ║
║  To generate licenses:                                         ║
║    python license_admin.py generate --name "Store Name"        ║
║                                                                ║
║  To view licenses:                                             ║
║    python license_admin.py list                                ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
        """)

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())

