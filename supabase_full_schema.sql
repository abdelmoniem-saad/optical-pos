-- ============================================
-- Lensy POS - Supabase Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS & AUTHENTICATION
-- ============================================

-- Roles table
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role_id UUID REFERENCES roles(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Permissions table
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL UNIQUE,
    name TEXT,
    description TEXT
);

-- Role permissions junction
CREATE TABLE IF NOT EXISTS role_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    value TEXT,
    UNIQUE(role_id, permission_id)
);

-- User permissions override
CREATE TABLE IF NOT EXISTS user_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    allow BOOLEAN DEFAULT TRUE,
    value TEXT,
    UNIQUE(user_id, permission_id)
);

-- ============================================
-- CUSTOMERS
-- ============================================

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone TEXT,
    phone2 TEXT,
    email TEXT,
    city TEXT,
    address TEXT,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INVENTORY & PRODUCTS
-- ============================================

CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    sku TEXT UNIQUE,
    barcode TEXT,
    category TEXT,
    brand TEXT,
    frame_type TEXT,
    frame_color TEXT,
    cost_price DECIMAL(10,2) DEFAULT 0,
    sale_price DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Stock movements for tracking inventory changes
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES inventory(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL,
    type TEXT NOT NULL, -- 'initial', 'sale', 'purchase', 'adjustment', 'return'
    ref_no TEXT,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Warehouses
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- SALES & ORDERS
-- ============================================

CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_no TEXT NOT NULL UNIQUE,
    customer_id UUID REFERENCES customers(id),
    user_id UUID REFERENCES users(id),
    total_amount DECIMAL(10,2) DEFAULT 0,
    discount DECIMAL(10,2) DEFAULT 0,
    net_amount DECIMAL(10,2) DEFAULT 0,
    amount_paid DECIMAL(10,2) DEFAULT 0,
    payment_method TEXT DEFAULT 'Cash',
    doctor_name TEXT,
    lab_status TEXT DEFAULT 'Not Started',
    order_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    delivery_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    product_id UUID REFERENCES inventory(id),
    name TEXT,
    qty INTEGER DEFAULT 1,
    unit_price DECIMAL(10,2) DEFAULT 0,
    total_price DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Order examinations (prescriptions attached to orders)
CREATE TABLE IF NOT EXISTS order_examinations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    exam_type TEXT,
    sphere_od TEXT,
    cylinder_od TEXT,
    axis_od TEXT,
    sphere_os TEXT,
    cylinder_os TEXT,
    axis_os TEXT,
    ipd TEXT,
    lens_info TEXT,
    frame_info TEXT,
    frame_color TEXT,
    frame_status TEXT,
    doctor_name TEXT,
    image_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- PRESCRIPTIONS (Standalone, not order-related)
-- ============================================

CREATE TABLE IF NOT EXISTS prescriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    type TEXT,
    doctor_name TEXT,
    sphere_od TEXT,
    cylinder_od TEXT,
    axis_od TEXT,
    ipd_od TEXT,
    sphere_os TEXT,
    cylinder_os TEXT,
    axis_os TEXT,
    ipd_os TEXT,
    notes TEXT,
    image_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- PURCHASES
-- ============================================

CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_id UUID REFERENCES suppliers(id),
    total_amount DECIMAL(10,2) DEFAULT 0,
    amount_paid DECIMAL(10,2) DEFAULT 0,
    purchase_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id UUID REFERENCES purchases(id) ON DELETE CASCADE,
    product_id UUID REFERENCES inventory(id),
    qty INTEGER DEFAULT 1,
    unit_cost DECIMAL(10,2) DEFAULT 0,
    total_cost DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- METADATA TABLES (Optical Settings)
-- ============================================

CREATE TABLE IF NOT EXISTS lens_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS frame_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS frame_colors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_lens_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- SETTINGS
-- ============================================

CREATE TABLE IF NOT EXISTS settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- SEED DATA
-- ============================================

-- Insert default roles
INSERT INTO roles (name) VALUES ('Admin'), ('Seller')
ON CONFLICT (name) DO NOTHING;

-- Insert default admin user (password: Admin123)
INSERT INTO users (username, password_hash, full_name, role_id, is_active)
SELECT 'admin', '$2b$12$PJA.1wnlwzUhF38Zy9qOduQ5djSaYUlD1.COIPYV5X2XBQBKhM53e', 'Administrator', r.id, TRUE
FROM roles r WHERE r.name = 'Admin'
ON CONFLICT (username) DO NOTHING;

-- Insert default settings
INSERT INTO settings (key, value) VALUES
    ('shop_name', 'Lensy Optical'),
    ('currency', 'EGP'),
    ('store_address', 'Your Store Address'),
    ('store_phone', '000-000-0000')
ON CONFLICT (key) DO NOTHING;

-- Insert default lens types
INSERT INTO lens_types (name) VALUES ('Single Vision'), ('Bifocal'), ('Progressive')
ON CONFLICT (name) DO NOTHING;

-- Insert default frame types
INSERT INTO frame_types (name) VALUES ('Full Rim'), ('Half Rim'), ('Rimless')
ON CONFLICT (name) DO NOTHING;

-- Insert default frame colors
INSERT INTO frame_colors (name) VALUES ('Black'), ('Gold'), ('Silver'), ('Brown')
ON CONFLICT (name) DO NOTHING;

-- Insert default warehouse
INSERT INTO warehouses (name) VALUES ('Main Warehouse')
ON CONFLICT DO NOTHING;

-- ============================================
-- LICENSING & UPDATES (for license management)
-- ============================================

-- Licenses table
CREATE TABLE IF NOT EXISTS licenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    license_key TEXT NOT NULL UNIQUE,
    licensee_name TEXT,
    licensee_email TEXT,
    license_type TEXT DEFAULT 'standard',  -- 'trial', 'standard', 'professional', 'enterprise'
    machine_id TEXT,                        -- Hardware fingerprint of activated machine
    is_active BOOLEAN DEFAULT FALSE,        -- True after successful activation
    is_revoked BOOLEAN DEFAULT FALSE,       -- True if license is revoked
    allow_transfer BOOLEAN DEFAULT FALSE,   -- Allow moving license to another machine
    max_activations INTEGER DEFAULT 1,      -- Max simultaneous activations (future use)
    current_activations INTEGER DEFAULT 0,
    features JSONB DEFAULT '{}',            -- Feature flags for different tiers
    expires_at TIMESTAMP WITH TIME ZONE,    -- NULL = perpetual
    activated_at TIMESTAMP WITH TIME ZONE,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    last_check TIMESTAMP WITH TIME ZONE,    -- Last online verification
    notes TEXT,                             -- Admin notes
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- App updates table for auto-update functionality
CREATE TABLE IF NOT EXISTS app_updates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    app_name TEXT NOT NULL,
    version TEXT NOT NULL,
    download_url TEXT,
    release_notes TEXT,
    is_mandatory BOOLEAN DEFAULT FALSE,     -- Force update
    min_version TEXT,                       -- Minimum version required to update
    platform TEXT DEFAULT 'all',            -- 'windows', 'macos', 'linux', 'android', 'ios', 'all'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- License activation logs for auditing
CREATE TABLE IF NOT EXISTS license_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    license_key TEXT,
    event_type TEXT NOT NULL,               -- 'activated', 'deactivated', 'check', 'revoked', 'expired'
    machine_id TEXT,
    ip_address TEXT,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_machine ON licenses(machine_id);
CREATE INDEX IF NOT EXISTS idx_licenses_active ON licenses(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_license_logs_key ON license_logs(license_key);
CREATE INDEX IF NOT EXISTS idx_app_updates_name ON app_updates(app_name, version);

-- Enable Row Level Security
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_logs ENABLE ROW LEVEL SECURITY;

-- Policies - Allow public read for license validation
CREATE POLICY "Allow license lookup" ON licenses
    FOR SELECT USING (true);

CREATE POLICY "Allow license update for activation" ON licenses
    FOR UPDATE USING (true);

CREATE POLICY "Allow read updates" ON app_updates
    FOR SELECT USING (true);

CREATE POLICY "Allow insert logs" ON license_logs
    FOR INSERT WITH CHECK (true);

-- ============================================
-- SAMPLE LICENSES (for testing - REMOVE IN PRODUCTION)
-- ============================================

-- Insert a test perpetual license
INSERT INTO licenses (license_key, licensee_name, licensee_email, license_type, notes)
VALUES ('TEST-XXXX-XXXX-XXXX', 'Test License', 'test@example.com', 'professional', 'Test license - remove in production')
ON CONFLICT (license_key) DO NOTHING;

-- Insert a demo 30-day trial license
INSERT INTO licenses (license_key, licensee_name, license_type, expires_at, notes)
VALUES ('DEMO-TRIA-L30D-AYSS', 'Demo Store', 'trial', NOW() + INTERVAL '30 days', 'Demo trial license')
ON CONFLICT (license_key) DO NOTHING;

-- Insert initial app version record
INSERT INTO app_updates (app_name, version, release_notes, platform)
VALUES ('LensyPOS', '1.0.0', 'Initial release of Lensy POS', 'all')
ON CONFLICT DO NOTHING;
