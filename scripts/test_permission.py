# scripts/test_permission.py
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.db_manager import get_engine, get_session
from app.database.models import User, Base
from app.core.permissions import has_permission, seed_permissions, seed_roles_and_bindings

if __name__ == '__main__':
    engine = get_engine()
    Base.metadata.create_all(engine)
    session = get_session(engine)

    # ensure permissions and roles exist
    seed_permissions(session)
    seed_roles_and_bindings(session)

    # find admin user
    admin = session.query(User).filter_by(username='admin').first()
    if not admin:
        print("No admin user found. Run scripts/init_db.py first.")
    else:
        print("Admin id:", admin.id)
        # check a few permissions
        for code in ["CREATE_SALE", "EDIT_SALE", "SALE_EDIT_MAX_DAYS", "VIEW_COST_PRICE", "REPORT_PROFIT"]:
            allowed, value = has_permission(session, admin.id, code)
            print(f"Permission {code}: allowed={allowed}, value={value}")

    session.close()

