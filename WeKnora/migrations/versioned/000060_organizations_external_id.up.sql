-- Migration 000060: add organizations.external_id
--
-- Carries an opaque identifier from the upstream identity system (today:
-- Clawith's tenant_id, which Clawith calls "Enterprise"). When the
-- Clawith→WeKnora JWT bridge mints a token, it now includes the user's
-- Clawith tenant_id as a JWT claim; WeKnora's LoginWithSSO looks up an
-- org by that external_id and joins the new tenant to it. First user of
-- a new Enterprise creates the org and becomes its owner; subsequent
-- users join with the role configured by AUTH_AUTO_JOIN_ROLE.
--
-- Length 64: large enough for any UUID with prefix; nullable because
-- orgs created directly in WeKnora (without a Clawith upstream) have no
-- external identity. The partial unique index excludes both NULLs (so
-- many WeKnora-native orgs can coexist) and soft-deleted rows (so
-- deletion + re-creation by the same Enterprise works without a
-- "duplicate key" surprise).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'external_id'
    ) THEN
        ALTER TABLE organizations ADD COLUMN external_id VARCHAR(64);
        RAISE NOTICE '[Migration 000060] Added organizations.external_id';
    ELSE
        RAISE NOTICE '[Migration 000060] organizations.external_id already exists';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_organizations_external_id_unique'
    ) THEN
        CREATE UNIQUE INDEX idx_organizations_external_id_unique
            ON organizations (external_id)
            WHERE external_id IS NOT NULL AND deleted_at IS NULL;
        RAISE NOTICE '[Migration 000060] Created unique partial index on external_id';
    ELSE
        RAISE NOTICE '[Migration 000060] external_id unique index already exists';
    END IF;
END $$;
