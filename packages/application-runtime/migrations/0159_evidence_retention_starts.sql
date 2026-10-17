-- When this database began storing each kind of cited provider evidence. Records written before
-- then cite read and receipt IDs whose evidence was never captured and cannot be backfilled.
-- The evidence view compares a citation's time with these starts, so it can say that an
-- unresolved ID was recorded before Luma kept evidence instead of guessing. The starts come from
-- the migration ledger, because the storing code runs only after its migration was applied; a
-- database built without the ledger, such as a test database, starts now. Not tenant data, so
-- readers need no row security. Rows never change after this migration.
CREATE TABLE evidence_retention_starts (
 kind text PRIMARY KEY CHECK(kind IN ('procurement_reads','return_reads','write_receipts')),
 migration text NOT NULL,
 started_at timestamptz NOT NULL
);
INSERT INTO evidence_retention_starts(kind,migration,started_at) VALUES
 ('procurement_reads','0156_procurement_read_evidence.sql',now()),
 ('return_reads','0157_orders_return_read_evidence.sql',now()),
 ('write_receipts','0158_write_receipt_evidence.sql',now());
DO $$ BEGIN
 IF to_regclass('identity_migrations') IS NOT NULL THEN
  EXECUTE 'UPDATE evidence_retention_starts s SET started_at=m.applied_at
   FROM identity_migrations m WHERE m.name=s.migration';
 END IF;
END $$;
GRANT SELECT(kind,started_at) ON evidence_retention_starts TO luma_desk;
