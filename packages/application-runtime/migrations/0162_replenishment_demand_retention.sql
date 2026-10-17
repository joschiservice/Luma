-- Replenishment review contexts begin recording the order reads behind a known demand estimate
-- with this migration's release. Contexts frozen earlier relied on such reads but name none, so
-- the evidence view lists their demand reads as not retained, dated by this start. The storing
-- code runs only after this migration was applied, and the runner applies it in one transaction,
-- so now() is the time the ledger records for it. Rows never change after this migration.
ALTER TABLE evidence_retention_starts DROP CONSTRAINT evidence_retention_starts_kind_check;
ALTER TABLE evidence_retention_starts ADD CONSTRAINT evidence_retention_starts_kind_check
 CHECK(kind IN ('procurement_reads','return_reads','write_receipts','replenishment_demand_reads'));
INSERT INTO evidence_retention_starts(kind,migration,started_at) VALUES
 ('replenishment_demand_reads','0162_replenishment_demand_retention.sql',now());
