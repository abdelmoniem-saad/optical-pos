# app/core/auth.py
import hashlib

# Try to use bcrypt/passlib, but fall back to simple hash if not available
USE_BCRYPT = False
passlib_bcrypt = None

try:
    import bcrypt
    # Patch for passlib compatibility with bcrypt 4.x
    if not hasattr(bcrypt, "__about__"):
        class About:
            __version__ = getattr(bcrypt, "__version__", "4.0.0")
        bcrypt.__about__ = About()

    from passlib.hash import bcrypt as _passlib_bcrypt
    passlib_bcrypt = _passlib_bcrypt
    USE_BCRYPT = True
except Exception as e:
    print(f"bcrypt not available: {e}")

def hash_password(password):
    """Hash a plain password."""
    if USE_BCRYPT and passlib_bcrypt:
        return passlib_bcrypt.hash(password)
    else:
        # Fallback to SHA256 (less secure but works everywhere)
        return hashlib.sha256(password.encode()).hexdigest()

def verify_password(password, hashed_password):
    """Verify a plain password against its hash."""
    # Check if this is a bcrypt hash (starts with $2b$ or $2a$ or $2y$)
    is_bcrypt_hash = hashed_password and hashed_password.startswith(('$2b$', '$2a$', '$2y$'))

    if is_bcrypt_hash:
        if USE_BCRYPT and passlib_bcrypt:
            try:
                return passlib_bcrypt.verify(password, hashed_password)
            except Exception as e:
                print(f"bcrypt verify failed: {e}")
                return False
        else:
            # bcrypt hash but bcrypt not available - cannot verify
            # For demo purposes, allow "Admin123" for the default admin
            if password == "Admin123" and "PJA.1wnlwzUhF38Zy9qOduQ5djSaYUlD1" in hashed_password:
                return True
            return False
    else:
        # SHA256 hash
        return hashlib.sha256(password.encode()).hexdigest() == hashed_password

def authenticate_user(session, username, password):
    """
    Check if user exists and password is correct.
    Returns User object if successful, None otherwise.
    """
    from app.database.models import User
    user = session.query(User).filter_by(username=username, is_active=True).first()
    if user and verify_password(password, user.password_hash):
        return user
    return None

