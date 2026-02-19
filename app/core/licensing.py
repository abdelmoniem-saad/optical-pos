"""
Lensy POS - Software Licensing System
Protects against unauthorized distribution and manages vendor licenses.
"""

import os
import json
import uuid
import hashlib
import platform
import datetime
import base64
from pathlib import Path


class LicenseManager:
    """Manages software licensing and activation."""

    # License server URL (your Supabase or custom server)
    LICENSE_SERVER = os.environ.get("LICENSE_SERVER_URL", "")

    # License file location
    LICENSE_FILE = Path.home() / ".lensy_pos" / "license.dat"

    # Grace period for offline use (days)
    OFFLINE_GRACE_DAYS = 7

    def __init__(self, supabase_client=None):
        self.supabase = supabase_client
        self._license_data = None
        self._machine_id = None

    @property
    def machine_id(self) -> str:
        """Generate a unique machine identifier."""
        if self._machine_id:
            return self._machine_id

        # Collect hardware identifiers
        identifiers = []

        # Platform info
        identifiers.append(platform.node())  # Computer name
        identifiers.append(platform.machine())  # CPU architecture
        identifiers.append(platform.processor())  # CPU type

        # Try to get more unique identifiers
        try:
            # Windows: Get volume serial number
            if platform.system() == "Windows":
                import subprocess
                result = subprocess.run(
                    ["wmic", "diskdrive", "get", "serialnumber"],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    lines = [l.strip() for l in result.stdout.split('\n') if l.strip() and l.strip() != "SerialNumber"]
                    if lines:
                        identifiers.append(lines[0])
        except Exception:
            pass

        try:
            # Get MAC address
            import uuid as uuid_module
            mac = ':'.join(['{:02x}'.format((uuid_module.getnode() >> i) & 0xff) for i in range(0, 48, 8)])
            identifiers.append(mac)
        except Exception:
            pass

        # Create hash of all identifiers
        combined = "|".join(identifiers)
        self._machine_id = hashlib.sha256(combined.encode()).hexdigest()[:32]
        return self._machine_id

    def _encode_license(self, data: dict) -> str:
        """Encode license data with simple obfuscation."""
        json_str = json.dumps(data)
        # Add machine-specific salt
        salted = f"{self.machine_id[:8]}|{json_str}|{self.machine_id[-8:]}"
        encoded = base64.b64encode(salted.encode()).decode()
        # Add checksum
        checksum = hashlib.md5(encoded.encode()).hexdigest()[:8]
        return f"{encoded}.{checksum}"

    def _decode_license(self, encoded: str) -> dict:
        """Decode license data."""
        try:
            parts = encoded.split('.')
            if len(parts) != 2:
                return None

            data, checksum = parts
            # Verify checksum
            if hashlib.md5(data.encode()).hexdigest()[:8] != checksum:
                return None

            decoded = base64.b64decode(data).decode()
            # Remove salt
            parts = decoded.split('|')
            if len(parts) >= 3:
                json_str = '|'.join(parts[1:-1])
                return json.loads(json_str)
            return None
        except Exception:
            return None

    def _save_license(self, data: dict):
        """Save license to local file."""
        self.LICENSE_FILE.parent.mkdir(parents=True, exist_ok=True)
        encoded = self._encode_license(data)
        self.LICENSE_FILE.write_text(encoded)
        self._license_data = data

    def _load_license(self) -> dict:
        """Load license from local file."""
        if self._license_data:
            return self._license_data

        if not self.LICENSE_FILE.exists():
            return None

        try:
            encoded = self.LICENSE_FILE.read_text()
            self._license_data = self._decode_license(encoded)
            return self._license_data
        except Exception:
            return None

    def get_license_info(self) -> dict:
        """Get current license information."""
        return self._load_license()

    def is_licensed(self) -> tuple[bool, str]:
        """
        Check if the software is properly licensed.
        Returns (is_valid, message)
        """
        license_data = self._load_license()

        if not license_data:
            return False, "No license found. Please activate with a license key."

        # Check if license is for this machine
        if license_data.get("machine_id") != self.machine_id:
            return False, "License is not valid for this computer."

        # Check expiration
        expiry_str = license_data.get("expires_at")
        if expiry_str:
            try:
                expiry = datetime.datetime.fromisoformat(expiry_str)
                if datetime.datetime.now() > expiry:
                    return False, "License has expired. Please renew your license."
            except Exception:
                pass

        # Check if license is revoked (online check)
        if self.supabase:
            try:
                result = self.supabase.table("licenses").select("*").eq(
                    "license_key", license_data.get("license_key")
                ).execute()

                if result.data:
                    db_license = result.data[0]
                    if not db_license.get("is_active", False):
                        return False, "License has been deactivated."
                    if db_license.get("is_revoked", False):
                        return False, "License has been revoked."

                    # Update last check time
                    license_data["last_online_check"] = datetime.datetime.now().isoformat()
                    self._save_license(license_data)
            except Exception:
                # Offline mode - check grace period
                last_check = license_data.get("last_online_check")
                if last_check:
                    try:
                        last_check_dt = datetime.datetime.fromisoformat(last_check)
                        days_offline = (datetime.datetime.now() - last_check_dt).days
                        if days_offline > self.OFFLINE_GRACE_DAYS:
                            return False, f"Please connect to the internet to verify your license."
                    except Exception:
                        pass

        return True, f"Licensed to: {license_data.get('licensee_name', 'Unknown')}"

    def activate(self, license_key: str, licensee_name: str = "") -> tuple[bool, str]:
        """
        Activate software with a license key.
        Returns (success, message)
        """
        if not license_key or len(license_key) < 10:
            return False, "Invalid license key format."

        license_key = license_key.strip().upper()

        # Validate license key with server
        if self.supabase:
            try:
                # Check if license exists and is valid
                result = self.supabase.table("licenses").select("*").eq(
                    "license_key", license_key
                ).execute()

                if not result.data:
                    return False, "License key not found."

                license_record = result.data[0]

                # Check if already activated on another machine
                if license_record.get("machine_id") and license_record.get("machine_id") != self.machine_id:
                    # Check if license allows transfer
                    if not license_record.get("allow_transfer", False):
                        return False, "This license is already activated on another computer."

                # Check if revoked
                if license_record.get("is_revoked", False):
                    return False, "This license has been revoked."

                # Check expiration
                if license_record.get("expires_at"):
                    try:
                        expiry = datetime.datetime.fromisoformat(license_record["expires_at"].replace("Z", ""))
                        if datetime.datetime.now() > expiry:
                            return False, "This license has expired."
                    except Exception:
                        pass

                # Activate the license
                update_data = {
                    "machine_id": self.machine_id,
                    "is_active": True,
                    "activated_at": datetime.datetime.now().isoformat(),
                    "last_check": datetime.datetime.now().isoformat(),
                }

                if licensee_name:
                    update_data["licensee_name"] = licensee_name

                self.supabase.table("licenses").update(update_data).eq(
                    "license_key", license_key
                ).execute()

                # Save license locally
                license_data = {
                    "license_key": license_key,
                    "machine_id": self.machine_id,
                    "licensee_name": license_record.get("licensee_name", licensee_name),
                    "license_type": license_record.get("license_type", "standard"),
                    "expires_at": license_record.get("expires_at"),
                    "activated_at": datetime.datetime.now().isoformat(),
                    "last_online_check": datetime.datetime.now().isoformat(),
                    "features": license_record.get("features", {}),
                }
                self._save_license(license_data)

                return True, f"License activated successfully for {license_data['licensee_name']}!"

            except Exception as e:
                return False, f"Failed to validate license: {str(e)}"
        else:
            # Offline activation (for demo/testing)
            # In production, always require online validation
            return False, "Cannot activate offline. Please check your internet connection."

    def deactivate(self) -> tuple[bool, str]:
        """Deactivate the license on this machine."""
        license_data = self._load_license()

        if not license_data:
            return False, "No active license found."

        if self.supabase:
            try:
                # Clear machine_id on server to allow re-activation elsewhere
                self.supabase.table("licenses").update({
                    "machine_id": None,
                    "is_active": False,
                    "deactivated_at": datetime.datetime.now().isoformat(),
                }).eq("license_key", license_data.get("license_key")).execute()
            except Exception:
                pass

        # Remove local license file
        try:
            self.LICENSE_FILE.unlink()
        except Exception:
            pass

        self._license_data = None
        return True, "License deactivated. You can now activate on another computer."

    def check_for_updates(self) -> dict:
        """Check for software updates."""
        current_version = "1.0.0"  # Update this with actual version

        if self.supabase:
            try:
                result = self.supabase.table("app_updates").select("*").eq(
                    "app_name", "LensyPOS"
                ).order("version", desc=True).limit(1).execute()

                if result.data:
                    latest = result.data[0]
                    return {
                        "current_version": current_version,
                        "latest_version": latest.get("version"),
                        "download_url": latest.get("download_url"),
                        "release_notes": latest.get("release_notes"),
                        "is_mandatory": latest.get("is_mandatory", False),
                        "update_available": latest.get("version") > current_version,
                    }
            except Exception:
                pass

        return {
            "current_version": current_version,
            "latest_version": current_version,
            "update_available": False,
        }


def generate_license_key() -> str:
    """Generate a new license key (for admin use)."""
    # Format: XXXX-XXXX-XXXX-XXXX
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # Removed confusing chars (0,O,1,I)
    key_parts = []
    for _ in range(4):
        part = ''.join([chars[ord(os.urandom(1)) % len(chars)] for _ in range(4)])
        key_parts.append(part)
    return '-'.join(key_parts)


# SQL Schema for licenses table (add to Supabase)
LICENSES_SCHEMA = """
-- Add this to your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS licenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    license_key TEXT NOT NULL UNIQUE,
    licensee_name TEXT,
    licensee_email TEXT,
    license_type TEXT DEFAULT 'standard',  -- 'trial', 'standard', 'professional', 'enterprise'
    machine_id TEXT,
    is_active BOOLEAN DEFAULT FALSE,
    is_revoked BOOLEAN DEFAULT FALSE,
    allow_transfer BOOLEAN DEFAULT FALSE,
    max_activations INTEGER DEFAULT 1,
    current_activations INTEGER DEFAULT 0,
    features JSONB DEFAULT '{}',
    expires_at TIMESTAMP WITH TIME ZONE,
    activated_at TIMESTAMP WITH TIME ZONE,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    last_check TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

-- App updates table
CREATE TABLE IF NOT EXISTS app_updates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    app_name TEXT NOT NULL,
    version TEXT NOT NULL,
    download_url TEXT,
    release_notes TEXT,
    is_mandatory BOOLEAN DEFAULT FALSE,
    min_version TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_machine ON licenses(machine_id);

-- Enable Row Level Security
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_updates ENABLE ROW LEVEL SECURITY;

-- Policies (adjust based on your needs)
CREATE POLICY "Allow read for authenticated" ON licenses FOR SELECT USING (true);
CREATE POLICY "Allow read updates" ON app_updates FOR SELECT USING (true);
"""

