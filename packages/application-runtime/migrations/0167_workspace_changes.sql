-- Change feed (ADR-017): records which public API records changed, so a copy of a workspace's
-- data stays current without rereading everything. Triggers write one row per record and
-- transaction, in the same transaction as the record, and never the record's content.
--
-- Rows are ordered by the writing transaction's ID, not by a sequence: a sequence value is taken
-- before commit, so a reader could pass it while an earlier value is still uncommitted and skip
-- that change for good. Readers only return rows whose transaction is older than the oldest one
-- still running (pg_snapshot_xmin), so every row before a cursor is committed and visible.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_change_feed') THEN CREATE ROLE luma_change_feed NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_change_feed;

-- Like the record tables they mirror, neither table references organizations; closure purges them.
CREATE TABLE workspace_changes (
 tenant_id uuid NOT NULL,
 xact xid8 NOT NULL DEFAULT pg_current_xact_id(),
 id bigint GENERATED ALWAYS AS IDENTITY,
 record_type text NOT NULL CHECK(record_type IN ('order','fulfillment','return','inventory','product','customer','returnCase','issue')),
 record_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('upserted','deleted')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,xact,id),
 -- One row per record and transaction; its operation is the record's state at the last change.
 UNIQUE(tenant_id,record_type,record_id,xact)
);
CREATE INDEX workspace_changes_recorded ON workspace_changes(recorded_at);

-- The newest position pruning removed per workspace. A cursor before it may have missed changes.
CREATE TABLE workspace_change_horizons (
 tenant_id uuid PRIMARY KEY,
 xact xid8 NOT NULL,
 id bigint NOT NULL
);

GRANT SELECT ON workspace_changes,workspace_change_horizons TO luma_desk;
GRANT SELECT,INSERT,DELETE ON workspace_changes TO luma_change_feed;
GRANT UPDATE(operation) ON workspace_changes TO luma_change_feed;
GRANT SELECT,INSERT,UPDATE ON workspace_change_horizons TO luma_change_feed;
ALTER TABLE workspace_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_change_horizons ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_change_horizons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_changes FOR SELECT TO luma_desk USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON workspace_change_horizons FOR SELECT TO luma_desk USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- luma_change_feed has no login; only the trigger and pruning functions below act as it.
CREATE POLICY change_feed_owner ON workspace_changes TO luma_change_feed USING (true) WITH CHECK (true);
CREATE POLICY change_feed_owner ON workspace_change_horizons TO luma_change_feed USING (true) WITH CHECK (true);
INSERT INTO data_retention_classes(table_name,class) VALUES
 ('workspace_changes','purge_on_closure'),('workspace_change_horizons','purge_on_closure');

-- Records a change of the row's record. Arguments: the record type and the column holding the
-- record ID. A record is `deleted` once no row of its table holds its ID. Changes made while a
-- closed workspace is purged are not recorded; removing one connection's data is.
CREATE FUNCTION record_workspace_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 rec jsonb := to_jsonb(CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END);
 tenant uuid := (rec->>'tenant_id')::uuid;
 record uuid := (rec->>TG_ARGV[1])::uuid;
 present boolean := true;
BEGIN
 IF public.data_purge_active(tenant)
  AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=tenant AND o.status='closed') THEN
  RETURN NULL;
 END IF;
 -- Inventory projections also hold SKUs, locations and products; only positions are records.
 IF TG_ARGV[0]='inventory' AND NOT EXISTS (SELECT 1 FROM public.inventory_entities e
  WHERE e.tenant_id=tenant AND e.id=record AND e.kind='position') THEN
  RETURN NULL;
 END IF;
 IF TG_OP='DELETE' THEN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE tenant_id=$1 AND %I=$2)',TG_TABLE_NAME,TG_ARGV[1])
   INTO present USING tenant,record;
 END IF;
 INSERT INTO public.workspace_changes(tenant_id,record_type,record_id,operation)
  VALUES(tenant,TG_ARGV[0],record,CASE WHEN present THEN 'upserted' ELSE 'deleted' END)
  ON CONFLICT(tenant_id,record_type,record_id,xact) DO UPDATE SET operation=EXCLUDED.operation;
 RETURN NULL;
END $$;
ALTER FUNCTION record_workspace_change() OWNER TO luma_change_feed;
REVOKE ALL ON FUNCTION record_workspace_change() FROM PUBLIC;
GRANT SELECT(id,status) ON organizations TO luma_change_feed;
GRANT SELECT(tenant_id,id,kind) ON inventory_entities TO luma_change_feed;
CREATE POLICY change_feed_reads ON organizations FOR SELECT TO luma_change_feed USING (true);
CREATE POLICY change_feed_reads ON inventory_entities FOR SELECT TO luma_change_feed USING (true);

-- The tables behind each public record. Updates that change nothing are not recorded.
DO $$
DECLARE source record;
BEGIN
 FOR source IN SELECT * FROM (VALUES
  ('orders_list','order','entity_id'),
  ('orders_fulfillment_list','fulfillment','entity_id'),
  ('orders_returns','return','entity_id'),
  ('inventory_projections','inventory','entity_id'),
  ('inventory_product_skus','product','sku_id'),
  ('customer_profiles','customer','id'),
  ('orders_return_cases','returnCase','id'),
  ('exceptions','issue','id')) s(relation,record_type,id_column) LOOP
  EXECUTE format('GRANT SELECT(tenant_id,%I) ON %I TO luma_change_feed',source.id_column,source.relation);
  EXECUTE format('CREATE POLICY change_feed_reads ON %I FOR SELECT TO luma_change_feed USING (true)',source.relation);
  EXECUTE format('CREATE TRIGGER workspace_change AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_workspace_change(%L,%L)',
   source.relation,source.record_type,source.id_column);
  EXECUTE format('CREATE TRIGGER workspace_change_update AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_workspace_change(%L,%L)',
   source.relation,source.record_type,source.id_column);
 END LOOP;
END $$;

-- Deletes up to `batch` changes recorded more than `days` ago, and moves each affected
-- workspace's horizon to the newest position removed. Returns the number of rows deleted.
CREATE FUNCTION prune_workspace_changes(days integer, batch integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE removed integer;
BEGIN
 IF days IS NULL OR days < 1 OR batch IS NULL OR batch NOT BETWEEN 1 AND 100000 THEN
  RAISE EXCEPTION 'pruning needs a positive age and batch' USING ERRCODE='22023';
 END IF;
 WITH due AS (
  SELECT c.tenant_id,c.xact,c.id FROM public.workspace_changes c
  WHERE c.recorded_at < now()-make_interval(days=>days)
  ORDER BY c.recorded_at LIMIT batch FOR UPDATE SKIP LOCKED
 ), gone AS (
  DELETE FROM public.workspace_changes c USING due d
  WHERE c.tenant_id=d.tenant_id AND c.xact=d.xact AND c.id=d.id
  RETURNING c.tenant_id,c.xact,c.id
 ), edges AS (
  SELECT DISTINCT ON (tenant_id) tenant_id,xact,id FROM gone ORDER BY tenant_id,xact DESC,id DESC
 ), moved AS (
  INSERT INTO public.workspace_change_horizons AS h(tenant_id,xact,id) SELECT tenant_id,xact,id FROM edges
  ON CONFLICT (tenant_id) DO UPDATE SET xact=EXCLUDED.xact,id=EXCLUDED.id
   WHERE (h.xact,h.id) < (EXCLUDED.xact,EXCLUDED.id)
 )
 SELECT count(*) INTO removed FROM gone;
 RETURN removed;
END $$;
ALTER FUNCTION prune_workspace_changes(integer,integer) OWNER TO luma_change_feed;
REVOKE ALL ON FUNCTION prune_workspace_changes(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_workspace_changes(integer,integer) TO luma_commerce_sync;
