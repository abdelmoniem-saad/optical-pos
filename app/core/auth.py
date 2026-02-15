# app/core/auth.py
import bcrypt
# Patch for passlib compatibility with bcrypt 4.x
if not hasattr(bcrypt, "__about__"):
    class About:
        __version__ = getattr(bcrypt, "__version__", "4.0.0")
    bcrypt.__about__ = About()

from passlib.hash import bcrypt as passlib_bcrypt
from app.database.models import User

def hash_password(password):
    """Hash a plain password."""
    return passlib_bcrypt.hash(password)

def verify_password(password, hashed_password):
    """Verify a plain password against its hash."""
    return passlib_bcrypt.verify(password, hashed_password)

def authenticate_user(session, username, password):
    """
    Check if user exists and password is correct.
    Returns User object if successful, None otherwise.
    """
    user = session.query(User).filter_by(username=username, is_active=True).first()
    if user and verify_password(password, user.password_hash):
        return user
    return None
