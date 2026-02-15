# app/database/models.py
from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Text, ForeignKey,
    Boolean, PrimaryKeyConstraint
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
import datetime

Base = declarative_base()

# -------------------------
# Authorization models
# -------------------------
class Role(Base):
    __tablename__ = 'roles'
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)

    role_permissions = relationship('RolePermission', back_populates='role')

class Permission(Base):
    __tablename__ = 'permissions'
    id = Column(Integer, primary_key=True)
    code = Column(String, unique=True, nullable=False)       # e.g. EDIT_SALE
    category = Column(String)                                # e.g. 'sales'
    description = Column(String)
    value_type = Column(String, default='none')              # 'bool', 'int', 'none'

    role_permissions = relationship('RolePermission', back_populates='permission')

class RolePermission(Base):
    __tablename__ = 'role_permissions'
    role_id = Column(Integer, ForeignKey('roles.id'), nullable=False)
    permission_id = Column(Integer, ForeignKey('permissions.id'), nullable=False)
    value = Column(String, nullable=True)  # optional numeric value as string
    __table_args__ = (PrimaryKeyConstraint('role_id', 'permission_id', name='rp_pk'),)

    role = relationship('Role', back_populates='role_permissions')
    permission = relationship('Permission', back_populates='role_permissions')

class UserPermission(Base):
    __tablename__ = 'user_permissions'
    user_id = Column(Integer, nullable=False)
    permission_id = Column(Integer, nullable=False)
    allow = Column(Boolean, nullable=False, default=False)
    value = Column(String, nullable=True)
    __table_args__ = (PrimaryKeyConstraint('user_id', 'permission_id', name='up_pk'),)

# -------------------------
# Core business models
# -------------------------
class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role_id = Column(Integer, ForeignKey('roles.id'), nullable=True)  # can be null initially
    role = relationship('Role')
    full_name = Column(String)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Product(Base):
    __tablename__ = 'products'
    id = Column(Integer, primary_key=True)
    sku = Column(String, unique=True)
    name = Column(String, nullable=False)
    description = Column(Text)
    cost_price = Column(Float, default=0.0)
    sale_price = Column(Float, default=0.0)
    unit = Column(String, default='pcs')

    # Optical metadata
    category = Column(String) # 'Lens', 'Frame', 'Other'
    lens_type = Column(String)
    frame_type = Column(String)
    frame_color = Column(String)
    barcode = Column(String)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Warehouse(Base):
    __tablename__ = 'warehouses'
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    location = Column(String)

class StockMovement(Base):
    __tablename__ = 'stock_movements'
    id = Column(Integer, primary_key=True)
    product_id = Column(Integer, ForeignKey('products.id'), nullable=False)
    warehouse_id = Column(Integer, ForeignKey('warehouses.id'), nullable=True)
    qty = Column(Integer, nullable=False)
    type = Column(String, nullable=False)  # 'purchase', 'sale', 'adjustment', 'transfer'
    ref_no = Column(String, nullable=True)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    product = relationship('Product')
    warehouse = relationship('Warehouse')

class Sale(Base):
    __tablename__ = 'sales'
    id = Column(Integer, primary_key=True)
    invoice_no = Column(String, unique=True, nullable=False)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=True)
    customer_id = Column(Integer, ForeignKey('customers.id'), nullable=True)
    
    total_amount = Column(Float, nullable=False)
    discount = Column(Float, default=0.0)
    offer = Column(Float, default=0.0)
    net_amount = Column(Float, nullable=False)
    amount_paid = Column(Float, default=0.0)
    
    payment_method = Column(String, nullable=False)  # e.g. 'cash'
    is_received = Column(Boolean, default=False)
    order_date = Column(DateTime, default=datetime.datetime.utcnow)
    receiving_date = Column(DateTime, nullable=True)
    
    # Optical specific
    lens_type = Column(String)
    frame_type = Column(String)
    frame_color = Column(String)
    customer_type = Column(String) # 'New', 'Past'
    frame_source = Column(String) # 'Shop', 'External' (bought from different place)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow) # For internal tracking
    
    delivery_date = Column(DateTime, nullable=True)
    lab_status = Column(String, default='Not Started')
    doctor_name = Column(String)

    user = relationship('User')
    customer = relationship('Customer')
    items = relationship('SaleItem', back_populates='sale')
    examinations = relationship('OrderExamination', back_populates='sale')

class SaleItem(Base):
    __tablename__ = 'sale_items'
    id = Column(Integer, primary_key=True)
    sale_id = Column(Integer, ForeignKey('sales.id'), nullable=False)
    product_id = Column(Integer, ForeignKey('products.id'), nullable=False)
    qty = Column(Integer, nullable=False)
    unit_price = Column(Float, nullable=False)
    total_price = Column(Float, nullable=False)

    sale = relationship('Sale', back_populates='items')
    product = relationship('Product')

class OrderExamination(Base):
    __tablename__ = 'order_examinations'
    id = Column(Integer, primary_key=True)
    sale_id = Column(Integer, ForeignKey('sales.id'), nullable=False)
    
    exam_type = Column(String) # Distance/Reading
    
    # Right Eye (OD)
    sphere_od = Column(String)
    cylinder_od = Column(String)
    axis_od = Column(String)
    
    # Left Eye (OS)
    sphere_os = Column(String)
    cylinder_os = Column(String)
    axis_os = Column(String)
    
    ipd = Column(String)
    
    lens_info = Column(String)
    frame_info = Column(String)
    frame_color = Column(String)
    frame_status = Column(String) # New/Old
    image_path = Column(String) # Path to attached picture
    doctor_name = Column(String)
    
    sale = relationship('Sale', back_populates='examinations')

# -------------------------
# Optical Shop Specific Metadata
# -------------------------
class LensType(Base):
    __tablename__ = 'lens_types'
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)

class FrameType(Base):
    __tablename__ = 'frame_types'
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)

class FrameColor(Base):
    __tablename__ = 'frame_colors'
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)

# New: Contact lens specific types
class ContactLensType(Base):
    __tablename__ = 'contact_lens_types'
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)

class Supplier(Base):
    __tablename__ = 'suppliers'
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    phone = Column(String)
    email = Column(String)
    address = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Purchase(Base):
    __tablename__ = 'purchases'
    id = Column(Integer, primary_key=True)
    supplier_id = Column(Integer, ForeignKey('suppliers.id'), nullable=True)
    invoice_no = Column(String)
    total_amount = Column(Float)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    supplier = relationship('Supplier')

class PurchaseItem(Base):
    __tablename__ = 'purchase_items'
    id = Column(Integer, primary_key=True)
    purchase_id = Column(Integer, ForeignKey('purchases.id'), nullable=False)
    product_id = Column(Integer, ForeignKey('products.id'), nullable=False)
    qty = Column(Integer, nullable=False)
    unit_cost = Column(Float)

class Setting(Base):
    __tablename__ = 'settings'
    key = Column(String, primary_key=True)
    value = Column(String)

class Customer(Base):
    __tablename__ = 'customers'
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    phone = Column(String)
    phone2 = Column(String) # Second number
    email = Column(String)
    address = Column(Text)
    city = Column(String) # City Name
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Prescription(Base):
    __tablename__ = 'prescriptions'
    id = Column(Integer, primary_key=True)
    customer_id = Column(Integer, ForeignKey('customers.id'), nullable=False)
    
    # Row: Dist (as requested)
    type = Column(String, default='Dist') 

    # OD (Right Eye)
    sphere_od = Column(String)
    cylinder_od = Column(String)
    axis_od = Column(String)
    ipd_od = Column(String) # IPD Right
    
    # OS (Left Eye)
    sphere_os = Column(String)
    cylinder_os = Column(String)
    axis_os = Column(String)
    ipd_os = Column(String) # IPD Left
    
    doctor_name = Column(String)
    image_path = Column(String) # Path to attached picture
    notes = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    customer = relationship('Customer')
