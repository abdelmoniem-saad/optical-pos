# Lensy POS - Vendor Distribution Guide

## Overview

Lensy POS can be distributed to vendors with **license protection** to prevent unauthorized sharing and piracy.

### Protection Features:
- ✅ **License Key Activation** - Each vendor needs a unique license key
- ✅ **Machine Binding** - License is locked to specific computer hardware
- ✅ **Expiration Support** - Time-limited licenses (trial, annual, etc.)
- ✅ **Remote Revocation** - Disable licenses remotely if needed
- ✅ **License Transfer** - Optional: allow moving to new machines
- ✅ **Offline Grace Period** - Works offline for up to 7 days

---

## Quick Start for Distribution

### 1. Set Up License Server (One Time)

Run the licensing schema in your Supabase SQL Editor:
```sql
-- Copy content from supabase_licensing_schema.sql
```

### 2. Generate a License for a Vendor

```powershell
# Set your Supabase credentials
$env:SUPABASE_URL = "https://your-project.supabase.co"
$env:SUPABASE_KEY = "your-anon-key"

# Generate a 1-year license
python license_admin.py generate --name "Acme Optical Store" --email "acme@example.com" --days 365

# Output:
# ============================================
# ✅ LICENSE GENERATED SUCCESSFULLY
# ============================================
#   License Key: ABCD-EFGH-IJKL-MNOP
#   ...
```

### 3. Build the Protected Application

```powershell
# Build Windows app with licensing enabled
python build_production.py --windows

# Or build Android APK
python build_production.py --android
```

### 4. Distribute to Vendor

1. Send the built application (.exe or .apk)
2. Send the license key separately (email, SMS, etc.)
3. Vendor enters the license key on first launch

---

## License Management Commands

```powershell
# Generate a new license
python license_admin.py generate --name "Store Name" --email "email@example.com" --days 365

# Generate a trial license (30 days)
python license_admin.py generate --name "Trial Store" --type trial --days 30

# Generate transferable license (can move between machines)
python license_admin.py generate --name "Store Name" --transfer --days 365

# List all licenses
python license_admin.py list

# Get license details
python license_admin.py info XXXX-XXXX-XXXX-XXXX

# Revoke a license (immediate deactivation)
python license_admin.py revoke XXXX-XXXX-XXXX-XXXX

# Reset license (allow re-activation on new machine)
python license_admin.py reset XXXX-XXXX-XXXX-XXXX

# Extend license by 30 days
python license_admin.py extend XXXX-XXXX-XXXX-XXXX --days 30
```

---

## License Types

| Type | Description | Typical Duration |
|------|-------------|------------------|
| `trial` | Free evaluation | 14-30 days |
| `standard` | Basic features | 1 year |
| `professional` | All features | 1 year |
| `enterprise` | Multi-store, priority support | Custom |

---

## Performance Tips

### Desktop App Advantages

- ✅ Faster startup
- ✅ Better performance
- ✅ Works offline
- ✅ No browser overhead
- ✅ Native OS integration

### Web App Considerations

- ⚠️ Slower due to browser overhead
- ⚠️ Requires internet connection
- ✅ Accessible from any device
- ✅ No installation needed
- ✅ Auto-updates

---

## Troubleshooting

### "Cannot find module 'bcrypt'"

Install bcrypt: `pip install bcrypt`

### "Password verification failed"

1. Check the password is correct
2. Default password is `Admin123`
3. Reset by updating the user in Supabase or local JSON

### "Connection timeout"

1. Check internet connection
2. Verify Supabase credentials
3. The app will fall back to local mode

### Build Fails

1. Update Flet: `pip install --upgrade flet`
2. Clear build cache: Delete `build/` folder
3. Check Flutter installation

---

## Support

For technical support, contact your system administrator.

© 2026 Lensy - All Rights Reserved


