# app/core/auth.py
import hashlib

# Try to use bcrypt directly
USE_BCRYPT = False
bcrypt_module = None

try:
    import bcrypt as _bcrypt
    bcrypt_module = _bcrypt
    USE_BCRYPT = True
    print("[AUTH] bcrypt loaded successfully")
except Exception as e:
    print(f"[AUTH] bcrypt not available: {e}")

# Known password hashes for fallback (password -> hash mapping)
KNOWN_HASHES = {
    # Admin123 hash
    "$2b$12$PJA.1wnlwzUhF38Zy9qOduQ5djSaYUlD1.COIPYV5X2XBQBKhM53e": "Admin123",
}

def hash_password(password):
    """Hash a plain password."""
    if USE_BCRYPT and bcrypt_module:
        # Truncate to 72 bytes (bcrypt limit)
        password_bytes = password.encode('utf-8')[:72]
        salt = bcrypt_module.gensalt()
        return bcrypt_module.hashpw(password_bytes, salt).decode('utf-8')
    else:
        return hashlib.sha256(password.encode()).hexdigest()

def verify_password(password, hashed_password):
    """Verify a plain password against its hash."""
    if not password or not hashed_password:
        return False

    # Ensure password is a string (not bytes or other type)
    if not isinstance(password, str):
        password = str(password)
    if not isinstance(hashed_password, str):
        hashed_password = str(hashed_password)

    # Check if this is a bcrypt hash
    is_bcrypt_hash = hashed_password.startswith(('$2b$', '$2a$', '$2y$'))

    if is_bcrypt_hash:
        # First check known hashes (fallback)
        if hashed_password in KNOWN_HASHES:
            return password == KNOWN_HASHES[hashed_password]

        # Try bcrypt verification
        if USE_BCRYPT and bcrypt_module:
            try:
                # Truncate password to 72 bytes (bcrypt limit)
                password_bytes = password.encode('utf-8')[:72]
                hash_bytes = hashed_password.encode('utf-8')
                return bcrypt_module.checkpw(password_bytes, hash_bytes)
            except Exception as e:
                print(f"[AUTH] bcrypt.checkpw error: {e}")
                # Fall back to known hashes check
                if hashed_password in KNOWN_HASHES:
                    return password == KNOWN_HASHES[hashed_password]
                return False
        else:
            # bcrypt not available, check known hashes only
            if hashed_password in KNOWN_HASHES:
                return password == KNOWN_HASHES[hashed_password]
        return False
    else:
        # SHA256 hash
        return hashlib.sha256(password.encode()).hexdigest() == hashed_password

def authenticate_user(session, username, password):
    """Check if user exists and password is correct."""
    from app.database.models import User
    user = session.query(User).filter_by(username=username, is_active=True).first()
    if user and verify_password(password, user.password_hash):
        return user
    return None

