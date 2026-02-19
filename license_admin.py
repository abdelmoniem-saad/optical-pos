"""
Lensy POS - License Administration Tool
Command-line tool for generating and managing licenses.

Usage:
    python license_admin.py generate --name "Store Name" --email "email@example.com" --type standard --days 365
    python license_admin.py list
    python license_admin.py revoke LICENSE_KEY
    python license_admin.py info LICENSE_KEY
"""

import os
import sys
import argparse
import datetime
from typing import Optional

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core.licensing import generate_license_key


def get_supabase_client():
    """Get Supabase client from environment."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")

    if not url or not key:
        print("Error: SUPABASE_URL and SUPABASE_KEY environment variables required.")
        print("\nSet them with:")
        print('  $env:SUPABASE_URL = "your-url"')
        print('  $env:SUPABASE_KEY = "your-key"')
        sys.exit(1)

    from supabase import create_client
    return create_client(url, key)


def generate_license(
    name: str,
    email: str = "",
    license_type: str = "standard",
    days: Optional[int] = None,
    allow_transfer: bool = False,
    notes: str = "",
):
    """Generate a new license key and store it in Supabase."""
    supabase = get_supabase_client()

    license_key = generate_license_key()

    expires_at = None
    if days:
        expires_at = (datetime.datetime.now() + datetime.timedelta(days=days)).isoformat()

    license_data = {
        "license_key": license_key,
        "licensee_name": name,
        "licensee_email": email,
        "license_type": license_type,
        "expires_at": expires_at,
        "allow_transfer": allow_transfer,
        "notes": notes,
        "is_active": False,  # Will be True after activation
        "is_revoked": False,
    }

    result = supabase.table("licenses").insert(license_data).execute()

    if result.data:
        print("\n" + "="*50)
        print("✅ LICENSE GENERATED SUCCESSFULLY")
        print("="*50)
        print(f"\n  License Key: {license_key}")
        print(f"  Licensee:    {name}")
        print(f"  Email:       {email or 'N/A'}")
        print(f"  Type:        {license_type}")
        print(f"  Expires:     {expires_at[:10] if expires_at else 'Never'}")
        print(f"  Transfer:    {'Allowed' if allow_transfer else 'Not Allowed'}")
        print("\n" + "="*50)
        print("\n📋 Share this license key with the customer:")
        print(f"\n   {license_key}\n")
        return license_key
    else:
        print("❌ Failed to create license")
        return None


def list_licenses(show_all: bool = False):
    """List all licenses."""
    supabase = get_supabase_client()

    query = supabase.table("licenses").select("*").order("created_at", desc=True)

    if not show_all:
        query = query.eq("is_revoked", False)

    result = query.execute()

    if not result.data:
        print("No licenses found.")
        return

    print("\n" + "="*100)
    print(f"{'License Key':<22} {'Name':<20} {'Type':<12} {'Status':<12} {'Expires':<12} {'Machine':<10}")
    print("="*100)

    for lic in result.data:
        key = lic.get("license_key", "")[:20]
        name = (lic.get("licensee_name") or "")[:18]
        lic_type = (lic.get("license_type") or "standard")[:10]

        if lic.get("is_revoked"):
            status = "REVOKED"
        elif lic.get("is_active"):
            status = "ACTIVE"
        else:
            status = "PENDING"

        expires = (lic.get("expires_at") or "Never")[:10]
        machine = "Yes" if lic.get("machine_id") else "No"

        print(f"{key:<22} {name:<20} {lic_type:<12} {status:<12} {expires:<12} {machine:<10}")

    print("="*100)
    print(f"Total: {len(result.data)} licenses\n")


def get_license_info(license_key: str):
    """Get detailed info about a license."""
    supabase = get_supabase_client()

    result = supabase.table("licenses").select("*").eq("license_key", license_key.upper()).execute()

    if not result.data:
        print(f"License not found: {license_key}")
        return

    lic = result.data[0]

    print("\n" + "="*50)
    print("LICENSE INFORMATION")
    print("="*50)
    print(f"  License Key:    {lic.get('license_key')}")
    print(f"  Licensee Name:  {lic.get('licensee_name', 'N/A')}")
    print(f"  Licensee Email: {lic.get('licensee_email', 'N/A')}")
    print(f"  License Type:   {lic.get('license_type', 'standard')}")
    print(f"  Status:         {'REVOKED' if lic.get('is_revoked') else 'ACTIVE' if lic.get('is_active') else 'PENDING'}")
    print(f"  Allow Transfer: {lic.get('allow_transfer', False)}")
    print(f"  Machine ID:     {lic.get('machine_id') or 'Not activated'}")
    print(f"  Created:        {lic.get('created_at', 'N/A')[:19]}")
    print(f"  Activated:      {lic.get('activated_at', 'N/A')[:19] if lic.get('activated_at') else 'Not activated'}")
    print(f"  Expires:        {lic.get('expires_at', 'Never')[:10] if lic.get('expires_at') else 'Never'}")
    print(f"  Last Check:     {lic.get('last_check', 'N/A')[:19] if lic.get('last_check') else 'Never'}")
    print(f"  Notes:          {lic.get('notes', 'N/A')}")
    print("="*50 + "\n")


def revoke_license(license_key: str):
    """Revoke a license."""
    supabase = get_supabase_client()

    result = supabase.table("licenses").update({
        "is_revoked": True,
        "is_active": False,
    }).eq("license_key", license_key.upper()).execute()

    if result.data:
        print(f"✅ License {license_key} has been revoked.")
    else:
        print(f"❌ Failed to revoke license {license_key}")


def reset_license(license_key: str):
    """Reset a license (clear machine_id to allow re-activation)."""
    supabase = get_supabase_client()

    result = supabase.table("licenses").update({
        "machine_id": None,
        "is_active": False,
        "activated_at": None,
    }).eq("license_key", license_key.upper()).execute()

    if result.data:
        print(f"✅ License {license_key} has been reset. It can now be activated on a new machine.")
    else:
        print(f"❌ Failed to reset license {license_key}")


def extend_license(license_key: str, days: int):
    """Extend a license by N days."""
    supabase = get_supabase_client()

    # Get current license
    result = supabase.table("licenses").select("expires_at").eq("license_key", license_key.upper()).execute()

    if not result.data:
        print(f"License not found: {license_key}")
        return

    current_expiry = result.data[0].get("expires_at")
    if current_expiry:
        base_date = datetime.datetime.fromisoformat(current_expiry.replace("Z", ""))
    else:
        base_date = datetime.datetime.now()

    new_expiry = (base_date + datetime.timedelta(days=days)).isoformat()

    result = supabase.table("licenses").update({
        "expires_at": new_expiry,
    }).eq("license_key", license_key.upper()).execute()

    if result.data:
        print(f"✅ License {license_key} extended to {new_expiry[:10]}")
    else:
        print(f"❌ Failed to extend license {license_key}")


def main():
    parser = argparse.ArgumentParser(
        description="Lensy POS License Administration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate a standard license for 1 year
  python license_admin.py generate --name "Acme Optical" --email "acme@example.com" --days 365

  # Generate a trial license for 30 days
  python license_admin.py generate --name "Test Store" --type trial --days 30

  # List all active licenses
  python license_admin.py list

  # Get details about a license
  python license_admin.py info XXXX-XXXX-XXXX-XXXX

  # Revoke a license
  python license_admin.py revoke XXXX-XXXX-XXXX-XXXX

  # Reset a license (allow re-activation on new machine)
  python license_admin.py reset XXXX-XXXX-XXXX-XXXX

  # Extend a license by 30 days
  python license_admin.py extend XXXX-XXXX-XXXX-XXXX --days 30
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Generate command
    gen_parser = subparsers.add_parser("generate", help="Generate a new license")
    gen_parser.add_argument("--name", required=True, help="Licensee name/business name")
    gen_parser.add_argument("--email", default="", help="Licensee email")
    gen_parser.add_argument("--type", dest="license_type", default="standard",
                           choices=["trial", "standard", "professional", "enterprise"],
                           help="License type")
    gen_parser.add_argument("--days", type=int, help="License validity in days (omit for perpetual)")
    gen_parser.add_argument("--transfer", action="store_true", help="Allow license transfer between machines")
    gen_parser.add_argument("--notes", default="", help="Admin notes")

    # List command
    list_parser = subparsers.add_parser("list", help="List all licenses")
    list_parser.add_argument("--all", action="store_true", help="Include revoked licenses")

    # Info command
    info_parser = subparsers.add_parser("info", help="Get license details")
    info_parser.add_argument("license_key", help="License key to look up")

    # Revoke command
    revoke_parser = subparsers.add_parser("revoke", help="Revoke a license")
    revoke_parser.add_argument("license_key", help="License key to revoke")

    # Reset command
    reset_parser = subparsers.add_parser("reset", help="Reset a license for re-activation")
    reset_parser.add_argument("license_key", help="License key to reset")

    # Extend command
    extend_parser = subparsers.add_parser("extend", help="Extend license expiration")
    extend_parser.add_argument("license_key", help="License key to extend")
    extend_parser.add_argument("--days", type=int, required=True, help="Days to extend")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    if args.command == "generate":
        generate_license(
            name=args.name,
            email=args.email,
            license_type=args.license_type,
            days=args.days,
            allow_transfer=args.transfer,
            notes=args.notes,
        )
    elif args.command == "list":
        list_licenses(show_all=args.all)
    elif args.command == "info":
        get_license_info(args.license_key)
    elif args.command == "revoke":
        revoke_license(args.license_key)
    elif args.command == "reset":
        reset_license(args.license_key)
    elif args.command == "extend":
        extend_license(args.license_key, args.days)


if __name__ == "__main__":
    main()

