-- Each current stock report keeps its available quantity, when that quantity was first seen
-- and whether it is a quantity Luma wrote, so detection compares sources and finds recent
-- changes from this table instead of every report's history.
ALTER TABLE inventory_projections
 ADD COLUMN available numeric(20,6),
 ADD COLUMN available_changed_at timestamptz,
 ADD COLUMN luma_written boolean NOT NULL DEFAULT false;

CREATE FUNCTION inventory_projection_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE report record;
BEGIN
 SELECT s.available,s.observed_at,s.document INTO report FROM inventory_snapshots s
 WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.snapshot_id;
 NEW.available := CASE WHEN COALESCE((report.document->>'deleted')::boolean,false) THEN NULL ELSE report.available END;
 NEW.luma_written := COALESCE(report.document->'data'->'writeAttribution'->>'quantityMatches','false')='true';
 -- A report with the same quantity keeps the time the quantity was first seen.
 IF TG_OP='INSERT' OR NEW.available IS DISTINCT FROM OLD.available OR OLD.available_changed_at IS NULL THEN
  NEW.available_changed_at := report.observed_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_projection_quantity BEFORE INSERT OR UPDATE OF snapshot_id ON inventory_projections
 FOR EACH ROW EXECUTE FUNCTION inventory_projection_quantity();

-- Existing reports: the quantity was first seen after the latest earlier report with another one.
UPDATE inventory_projections p SET
 available=CASE WHEN COALESCE((s.document->>'deleted')::boolean,false) THEN NULL ELSE s.available END,
 luma_written=COALESCE(s.document->'data'->'writeAttribution'->>'quantityMatches','false')='true',
 available_changed_at=COALESCE((SELECT min(h.observed_at) FROM inventory_snapshots h
   WHERE h.tenant_id=p.tenant_id AND h.entity_id=p.entity_id AND h.connection_id=p.connection_id AND h.kind=s.kind
    AND h.observed_at<=s.observed_at AND h.observed_at>COALESCE((SELECT max(d.observed_at) FROM inventory_snapshots d
     WHERE d.tenant_id=p.tenant_id AND d.entity_id=p.entity_id AND d.connection_id=p.connection_id AND d.kind=s.kind
      AND d.observed_at<s.observed_at AND d.available IS DISTINCT FROM s.available),'-infinity')),s.observed_at)
FROM inventory_snapshots s WHERE s.tenant_id=p.tenant_id AND s.id=p.snapshot_id;

CREATE INDEX inventory_projection_changes ON inventory_projections(tenant_id,connection_id,available_changed_at);
