# app/core/permissions.py
"""
Seed permissions & roles; provide has_permission(session, user_id, permission_code)
"""

from app.database.models import Permission, Role, RolePermission, UserPermission, User
from sqlalchemy.exc import IntegrityError

PERMISSIONS_LIST = [
    # code, category, description, value_type
    ("CREATE_SALE", "sales", "Create sale invoice", "bool"),
    ("EDIT_SALE", "sales", "Edit sale invoice", "bool"),
    ("SALE_EDIT_MAX_DAYS", "sales", "Max days to edit sale", "int"),
    ("APPLY_DISCOUNT", "sales", "Apply discount", "bool"),

    ("VIEW_PRODUCTS", "products", "View products", "bool"),
    ("EDIT_PRODUCT", "products", "Edit product", "bool"),
    ("VIEW_COST_PRICE", "products", "View cost price", "bool"),

    ("REPORT_DAILY_SALES", "reports", "Daily sales report", "bool"),
    ("REPORT_PROFIT", "reports", "Profit report", "bool"),

    ("MANAGE_USERS", "admin", "Manage staff members", "bool"),
    ("MANAGE_SETTINGS", "admin", "Change system settings", "bool"),

    ("VIEW_LAB", "lab", "View lab orders", "bool"),
    ("EDIT_LAB", "lab", "Update lab status", "bool"),
    ("VIEW_PRESCRIPTIONS", "customers", "View customer prescriptions", "bool"),
]

def seed_permissions(session):
    created = 0
    for code, cat, desc, vtype in PERMISSIONS_LIST:
        if not session.query(Permission).filter_by(code=code).first():
            p = Permission(code=code, category=cat, description=desc, value_type=vtype)
            session.add(p)
            created += 1
    session.commit()
    print(f"Seeded {created} permissions (or already existed).")

def seed_roles_and_bindings(session):
    # create roles Admin, Seller, Technician
    admin = session.query(Role).filter_by(name='Admin').first()
    if not admin:
        admin = Role(name='Admin')
        session.add(admin)
    
    seller = session.query(Role).filter_by(name='Seller').first()
    if not seller:
        seller = Role(name='Seller')
        session.add(seller)
        
    tech = session.query(Role).filter_by(name='Technician').first()
    if not tech:
        tech = Role(name='Technician')
        session.add(tech)
    
    # Also handle legacy 'Cashier' if it exists (rename to Seller or keep)
    cashier = session.query(Role).filter_by(name='Cashier').first()
    if cashier and not seller:
        cashier.name = 'Seller'
        seller = cashier
        
    session.commit()

    perms = session.query(Permission).all()
    # bind all permissions to admin
    for perm in perms:
        exists = session.query(RolePermission).filter_by(role_id=admin.id, permission_id=perm.id).first()
        if not exists:
            rp = RolePermission(role_id=admin.id, permission_id=perm.id, value="999" if perm.value_type == 'int' else None)
            session.add(rp)

    # Seller permissions
    allowed_for_seller = {"CREATE_SALE", "APPLY_DISCOUNT", "VIEW_PRODUCTS", "VIEW_PRESCRIPTIONS"}
    for perm in perms:
        if perm.code in allowed_for_seller:
            exists = session.query(RolePermission).filter_by(role_id=seller.id, permission_id=perm.id).first()
            if not exists:
                rp = RolePermission(role_id=seller.id, permission_id=perm.id)
                session.add(rp)

    # Technician permissions
    allowed_for_tech = {"VIEW_LAB", "EDIT_LAB", "VIEW_PRODUCTS"}
    for perm in perms:
        if perm.code in allowed_for_tech:
            exists = session.query(RolePermission).filter_by(role_id=tech.id, permission_id=perm.id).first()
            if not exists:
                rp = RolePermission(role_id=tech.id, permission_id=perm.id)
                session.add(rp)
                
    session.commit()
    print("Roles and role-permission bindings ensured.")

    # optionally assign role to admin user (if exists)
    admin_user = session.query(User).filter_by(username='admin').first()
    if admin_user:
        admin_user.role_id = admin.id
        session.commit()
        print("Assigned Admin role to 'admin' user.")

def has_permission(session, user_id, permission_code):
    """
    Returns tuple (allowed: bool, value: str|None)
    """
    perm = session.query(Permission).filter_by(code=permission_code).first()
    if not perm:
        return False, None

    # 1) user override
    up = session.query(UserPermission).filter_by(user_id=user_id, permission_id=perm.id).first()
    if up:
        return bool(up.allow), up.value

    # 2) role of user
    user = session.query(User).filter_by(id=user_id).first()
    if not user:
        return False, None
    if not user.role_id:
        return False, None

    rp = session.query(RolePermission).filter_by(role_id=user.role_id, permission_id=perm.id).first()
    if rp:
        return True, rp.value

    return False, None
