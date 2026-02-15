# app/core/auth.py
import hashlib

# Try to use bcrypt/passlib, but fall back to simple hash if not available
try:
    import bcrypt
    # Patch for passlib compatibility with bcrypt 4.x
    if not hasattr(bcrypt, "__about__"):
        class About:
            __version__ = getattr(bcrypt, "__version__", "4.0.0")
        bcrypt.__about__ = About()

    from passlib.hash import bcrypt as passlib_bcrypt

    USE_BCRYPT = True
except Exception:
    USE_BCRYPT = False

def hash_password(password):
    """Hash a plain password."""
    if USE_BCRYPT:
        return passlib_bcrypt.hash(password)
    else:
        # Fallback to SHA256 (less secure but works everywhere)
        return hashlib.sha256(password.encode()).hexdigest()

def verify_password(password, hashed_password):
    """Verify a plain password against its hash."""
    if USE_BCRYPT:
        try:
            return passlib_bcrypt.verify(password, hashed_password)
        except Exception:
            # If bcrypt hash verification fails, try SHA256
            return hashlib.sha256(password.encode()).hexdigest() == hashed_password
    else:
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

