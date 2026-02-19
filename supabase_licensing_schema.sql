-- ============================================
-- Lensy POS - License Management Schema
-- Run this in Supabase SQL Editor AFTER the main schema
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
    created_by UUID REFERENCES users(id)
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
    license_key TEXT NOT NULL,
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
-- Note: In production, you may want to restrict this further
CREATE POLICY "Allow license lookup" ON licenses
    FOR SELECT USING (true);

CREATE POLICY "Allow license update for activation" ON licenses
    FOR UPDATE USING (true);

CREATE POLICY "Allow read updates" ON app_updates
    FOR SELECT USING (true);

CREATE POLICY "Allow insert logs" ON license_logs
    FOR INSERT WITH CHECK (true);

-- ============================================
-- Sample licenses (for testing)
-- Remove in production!
-- ============================================

-- Insert a test perpetual license
INSERT INTO licenses (license_key, licensee_name, licensee_email, license_type, notes)
VALUES ('TEST-XXXX-XXXX-XXXX', 'Test License', 'test@example.com', 'professional', 'Test license - remove in production')
ON CONFLICT (license_key) DO NOTHING;

-- Insert a demo 30-day trial license
INSERT INTO licenses (license_key, licensee_name, license_type, expires_at, notes)
VALUES ('DEMO-TRIA-L30D-AYSS', 'Demo Store', 'trial', NOW() + INTERVAL '30 days', 'Demo trial license')
ON CONFLICT (license_key) DO NOTHING;

-- ============================================
-- Useful queries for license management
-- ============================================

-- View all active licenses
-- SELECT * FROM licenses WHERE is_active = TRUE AND is_revoked = FALSE;

-- View expiring licenses (next 30 days)
-- SELECT * FROM licenses WHERE expires_at IS NOT NULL AND expires_at < NOW() + INTERVAL '30 days' AND expires_at > NOW();

-- View expired licenses
-- SELECT * FROM licenses WHERE expires_at IS NOT NULL AND expires_at < NOW();

-- Count licenses by type
-- SELECT license_type, COUNT(*) FROM licenses GROUP BY license_type;

-- Recent activation logs
-- SELECT * FROM license_logs ORDER BY created_at DESC LIMIT 50;

