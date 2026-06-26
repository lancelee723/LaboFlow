-- Migration 000060 (down): remove organizations.external_id
--
-- Drops the unique partial index before the column so the index doesn't
-- leak as an orphan. Both guards are idempotent so re-running down on
-- an already-rolled-back schema is a no-op.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_organizations_external_id_unique'
    ) THEN
        DROP INDEX idx_organizations_external_id_unique;
        RAISE NOTICE '[Migration 000060 down] Dropped external_id unique index';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'external_id'
    ) THEN
        ALTER TABLE organizations DROP COLUMN external_id;
        RAISE NOTICE '[Migration 000060 down] Dropped organizations.external_id';
    END IF;
END $$;
