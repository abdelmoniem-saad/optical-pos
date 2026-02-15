# scripts/test_auth.py
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine, get_session
from app.core.auth import authenticate_user

if __name__ == '__main__':
    engine = get_engine()
    session = get_session(engine)

    print("Testing valid login...")
    user = authenticate_user(session, 'admin', 'Admin123')
    if user:
        print(f"SUCCESS: Logged in as {user.username} ({user.full_name})")
    else:
        print("FAILED: Could not login with valid credentials")

    print("\nTesting invalid login...")
    user = authenticate_user(session, 'admin', 'WrongPass')
    if not user:
        print("SUCCESS: Invalid login rejected")
    else:
        print(f"FAILED: Logged in with wrong password as {user.username}")

    session.close()
