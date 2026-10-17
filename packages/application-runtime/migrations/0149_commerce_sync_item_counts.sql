-- Data sync shows per-stream ledger counts while syncs run. Counting the ledger on every poll
-- reads one row per source record, so ledger writes append signed count changes here in the
-- same statement and the page commit folds a stream's changes into one row. A stream's counts
-- are the sum of its rows, exact in every snapshot whichever path wrote the ledger.
CREATE TABLE commerce_sync_item_counts (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, record_type text NOT NULL,
 id bigint GENERATED ALWAYS AS IDENTITY,
 total bigint NOT NULL, current bigint NOT NULL, pending bigint NOT NULL, failed bigint NOT NULL,
 retired bigint NOT NULL, missing bigint NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,record_type,id)
);

-- Missing matches the ledger's missing filter: flagged by a full read and not confirmed deleted.
-- Updates count the difference between the old and new rows of each stream.
CREATE FUNCTION commerce_sync_count_items() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.commerce_sync_item_counts(tenant_id,connection_id,record_type,total,current,pending,failed,retired,missing)
   SELECT tenant_id,connection_id,record_type,count(*),count(*) FILTER (WHERE status='current'),
    count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='failed'),
    count(*) FILTER (WHERE status='retired'),count(*) FILTER (WHERE missing_since IS NOT NULL AND status<>'retired')
   FROM new_items GROUP BY 1,2,3;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO public.commerce_sync_item_counts(tenant_id,connection_id,record_type,total,current,pending,failed,retired,missing)
   SELECT tenant_id,connection_id,record_type,-count(*),-count(*) FILTER (WHERE status='current'),
    -count(*) FILTER (WHERE status='pending'),-count(*) FILTER (WHERE status='failed'),
    -count(*) FILTER (WHERE status='retired'),-count(*) FILTER (WHERE missing_since IS NOT NULL AND status<>'retired')
   FROM old_items GROUP BY 1,2,3;
 ELSE
  INSERT INTO public.commerce_sync_item_counts(tenant_id,connection_id,record_type,total,current,pending,failed,retired,missing)
   SELECT tenant_id,connection_id,record_type,sum(n),sum(n*(status='current')::int),sum(n*(status='pending')::int),
    sum(n*(status='failed')::int),sum(n*(status='retired')::int),sum(n*(missing_since IS NOT NULL AND status<>'retired')::int)
   FROM (SELECT 1 AS n,tenant_id,connection_id,record_type,status,missing_since FROM new_items
    UNION ALL SELECT -1,tenant_id,connection_id,record_type,status,missing_since FROM old_items) d
   GROUP BY 1,2,3
   HAVING sum(n)<>0 OR sum(n*(status='current')::int)<>0 OR sum(n*(status='pending')::int)<>0
    OR sum(n*(status='failed')::int)<>0 OR sum(n*(status='retired')::int)<>0
    OR sum(n*(missing_since IS NOT NULL AND status<>'retired')::int)<>0;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER commerce_sync_count_inserts AFTER INSERT ON commerce_sync_items
 REFERENCING NEW TABLE AS new_items FOR EACH STATEMENT EXECUTE FUNCTION commerce_sync_count_items();
CREATE TRIGGER commerce_sync_count_updates AFTER UPDATE ON commerce_sync_items
 REFERENCING OLD TABLE AS old_items NEW TABLE AS new_items FOR EACH STATEMENT EXECUTE FUNCTION commerce_sync_count_items();
CREATE TRIGGER commerce_sync_count_deletes AFTER DELETE ON commerce_sync_items
 REFERENCING OLD TABLE AS old_items FOR EACH STATEMENT EXECUTE FUNCTION commerce_sync_count_items();

-- Truncation fires no delete triggers; it empties the ledger, so its counts go with it.
CREATE FUNCTION commerce_sync_clear_item_counts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 DELETE FROM public.commerce_sync_item_counts;
 RETURN NULL;
END $$;
CREATE TRIGGER commerce_sync_clear_counts AFTER TRUNCATE ON commerce_sync_items
 FOR EACH STATEMENT EXECUTE FUNCTION commerce_sync_clear_item_counts();

INSERT INTO commerce_sync_item_counts(tenant_id,connection_id,record_type,total,current,pending,failed,retired,missing)
 SELECT tenant_id,connection_id,record_type,count(*),count(*) FILTER (WHERE status='current'),
  count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='failed'),
  count(*) FILTER (WHERE status='retired'),count(*) FILTER (WHERE missing_since IS NOT NULL AND status<>'retired')
 FROM commerce_sync_items GROUP BY 1,2,3;

GRANT SELECT,INSERT,DELETE ON commerce_sync_item_counts TO luma_commerce_sync;
ALTER TABLE commerce_sync_item_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_sync_item_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON commerce_sync_item_counts TO luma_commerce_sync
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
