-- Immutable quantity postings and maintained balances use per-account version chains.
-- The chain and commit checks avoid rescanning a hot account's complete history on each write.
CREATE TABLE inventory_ledger_accounts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, sku_id uuid NOT NULL, location_id uuid NOT NULL,
 sku_kind text GENERATED ALWAYS AS ('sku'::text) STORED,
 location_kind text GENERATED ALWAYS AS ('location'::text) STORED,
 unit text NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
 state text NOT NULL CHECK(state IN ('available','reserved','held','quarantine','damaged','returned_inspection','incoming','in_transit','supplier','customer','loss','adjustment','production','external')),
 connection_id uuid,
 balance numeric(24,6) NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 current_posting_version bigint GENERATED ALWAYS AS (NULLIF(version,0)) STORED,
 nonzero_since_effective timestamptz, nonzero_since_recorded timestamptz, aging_entry_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,sku_id,unit), UNIQUE(tenant_id,id,sku_id,location_id,unit),
 UNIQUE NULLS NOT DISTINCT(tenant_id,sku_id,location_id,unit,state,connection_id),
 FOREIGN KEY(tenant_id,sku_kind,sku_id) REFERENCES inventory_entities(tenant_id,kind,id),
 FOREIGN KEY(tenant_id,location_kind,location_id) REFERENCES inventory_entities(tenant_id,kind,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK((state='external')=(connection_id IS NOT NULL)),
 CHECK(state IN ('supplier','customer','loss','adjustment','production','external') OR balance>=0)
);
CREATE INDEX inventory_ledger_pool ON inventory_ledger_accounts(tenant_id,sku_id,location_id,unit,state);
CREATE INDEX inventory_ledger_aging ON inventory_ledger_accounts(tenant_id,state,nonzero_since_recorded,id) WHERE balance<>0;

CREATE TABLE inventory_ledger_reviews (
 tenant_id uuid NOT NULL, id uuid NOT NULL, command_key text NOT NULL, intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'), command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 command_document jsonb NOT NULL, source_bindings jsonb NOT NULL,
 prepared_by text NOT NULL CHECK(length(prepared_by)>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 reviewed_by text, reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_key),
 CHECK((state='pending')=(reviewed_by IS NULL AND reviewed_at IS NULL)),
 CHECK(reviewed_by IS NULL OR reviewed_by<>prepared_by)
);
CREATE TABLE inventory_ledger_entries (
 tenant_id uuid NOT NULL, id uuid NOT NULL, command_key text NOT NULL CHECK(length(command_key) BETWEEN 1 AND 256),
 command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 purpose text NOT NULL CHECK(purpose IN ('opening','movement','correction','reversal','reservation','release','dispatch','reconciliation','production')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1024), actor_id text NOT NULL,
 evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(evidence_refs)='array' AND jsonb_array_length(evidence_refs)<=128),
 effective_at timestamptz, recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 reversal_of uuid, review_id uuid,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_key), UNIQUE(tenant_id,reversal_of), UNIQUE(tenant_id,review_id),
 FOREIGN KEY(tenant_id,reversal_of) REFERENCES inventory_ledger_entries(tenant_id,id),
 FOREIGN KEY(tenant_id,review_id) REFERENCES inventory_ledger_reviews(tenant_id,id),
 CHECK((purpose='reversal')=(reversal_of IS NOT NULL)), CHECK(reversal_of IS NULL OR reversal_of<>id),
 CHECK(purpose NOT IN ('opening','correction','reversal','production') OR review_id IS NOT NULL)
);
CREATE INDEX inventory_ledger_entry_history ON inventory_ledger_entries(tenant_id,recorded_at,id);
ALTER TABLE inventory_ledger_accounts ADD FOREIGN KEY(tenant_id,aging_entry_id) REFERENCES inventory_ledger_entries(tenant_id,id);

CREATE TABLE inventory_ledger_postings (
 tenant_id uuid NOT NULL, entry_id uuid NOT NULL, account_id uuid NOT NULL,
 sku_id uuid NOT NULL, unit text NOT NULL, account_version bigint NOT NULL CHECK(account_version>0),
 previous_version bigint GENERATED ALWAYS AS (CASE WHEN account_version>1 THEN account_version-1 END) STORED,
 quantity numeric(24,6) NOT NULL CHECK(quantity<>0), balance_before numeric(24,6) NOT NULL, balance_after numeric(24,6) NOT NULL,
 effective_at timestamptz, recorded_at timestamptz(3) NOT NULL,
 PRIMARY KEY(tenant_id,entry_id,account_id), UNIQUE(tenant_id,account_id,account_version),
 UNIQUE(tenant_id,account_id,account_version,balance_after),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES inventory_ledger_entries(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id,sku_id,unit) REFERENCES inventory_ledger_accounts(tenant_id,id,sku_id,unit),
 FOREIGN KEY(tenant_id,account_id,previous_version,balance_before) REFERENCES inventory_ledger_postings(tenant_id,account_id,account_version,balance_after) DEFERRABLE INITIALLY DEFERRED,
 CHECK(balance_after=balance_before+quantity), CHECK(account_version>1 OR balance_before=0)
);
ALTER TABLE inventory_ledger_accounts ADD FOREIGN KEY(tenant_id,id,current_posting_version,balance)
 REFERENCES inventory_ledger_postings(tenant_id,account_id,account_version,balance_after) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX inventory_ledger_posting_history ON inventory_ledger_postings(tenant_id,account_id,recorded_at,account_version);

CREATE TABLE inventory_ledger_commands (
 tenant_id uuid NOT NULL, command_key text NOT NULL, command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,command_key)
);
CREATE TABLE inventory_ledger_checkpoints (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0),
 known_quantity numeric NOT NULL, unknown_quantity numeric NOT NULL,
 unknown_count bigint NOT NULL CHECK(unknown_count>=0), maximum_effective_at timestamptz,
 recorded_at timestamptz(3) NOT NULL, PRIMARY KEY(tenant_id,account_id,version),
 FOREIGN KEY(tenant_id,account_id,version) REFERENCES inventory_ledger_postings(tenant_id,account_id,account_version)
);
CREATE TABLE inventory_shadow_reconciliations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, command_key text NOT NULL,
 connection_id uuid NOT NULL, sku_id uuid NOT NULL, location_id uuid NOT NULL, unit text NOT NULL,
 native_account_id uuid NOT NULL, native_version bigint NOT NULL CHECK(native_version>=0), native_versions jsonb NOT NULL, native_quantity numeric(24,6) NOT NULL,
 provider_quantity numeric(24,6) NOT NULL, source_document jsonb NOT NULL, observation_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 observed_at timestamptz NOT NULL, recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 drift_account_id uuid NOT NULL, drift_quantity numeric(24,6) NOT NULL, entry_id uuid,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_key),
 FOREIGN KEY(tenant_id,connection_id,observation_id) REFERENCES connector_observations(tenant_id,connection_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,id),
 FOREIGN KEY(tenant_id,native_account_id,sku_id,location_id,unit) REFERENCES inventory_ledger_accounts(tenant_id,id,sku_id,location_id,unit),
 FOREIGN KEY(tenant_id,drift_account_id,sku_id,location_id,unit) REFERENCES inventory_ledger_accounts(tenant_id,id,sku_id,location_id,unit),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES inventory_ledger_entries(tenant_id,id),
 CHECK(drift_quantity=provider_quantity-native_quantity)
);
CREATE INDEX inventory_shadow_latest ON inventory_shadow_reconciliations(tenant_id,connection_id,sku_id,location_id,unit,recorded_at DESC,id);

CREATE FUNCTION inventory_ledger_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Posted quantity evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER inventory_ledger_entries_immutable BEFORE UPDATE OR DELETE ON inventory_ledger_entries FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_ledger_postings_immutable BEFORE UPDATE OR DELETE ON inventory_ledger_postings FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_ledger_commands_immutable BEFORE UPDATE OR DELETE ON inventory_ledger_commands FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_ledger_checkpoints_immutable BEFORE UPDATE OR DELETE ON inventory_ledger_checkpoints FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_shadow_immutable BEFORE UPDATE OR DELETE ON inventory_shadow_reconciliations FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();

CREATE FUNCTION inventory_ledger_posting_times() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE entry_txid xid8; entry_key text;
BEGIN
 SELECT created_txid,command_key INTO entry_txid,entry_key FROM public.inventory_ledger_entries WHERE tenant_id=NEW.tenant_id AND id=NEW.entry_id;
 IF entry_txid IS DISTINCT FROM pg_current_xact_id() OR EXISTS(SELECT 1 FROM public.inventory_ledger_commands WHERE tenant_id=NEW.tenant_id AND command_key=entry_key) THEN
  RAISE EXCEPTION 'Posted entries cannot acquire later postings' USING ERRCODE='23514';
 END IF;
 SELECT effective_at,recorded_at INTO NEW.effective_at,NEW.recorded_at FROM public.inventory_ledger_entries WHERE tenant_id=NEW.tenant_id AND id=NEW.entry_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Quantity entry is unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_ledger_posting_times BEFORE INSERT ON inventory_ledger_postings FOR EACH ROW EXECUTE FUNCTION inventory_ledger_posting_times();

CREATE FUNCTION inventory_ledger_account_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE posting public.inventory_ledger_postings;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Quantity accounts are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.balance<>0 OR NEW.version<>0 THEN RAISE EXCEPTION 'Accounts start at zero' USING ERRCODE='23514'; END IF;
  NEW.nonzero_since_effective=NULL; NEW.nonzero_since_recorded=NULL; NEW.aging_entry_id=NULL;
  RETURN NEW;
 END IF;
 IF (NEW.tenant_id,NEW.id,NEW.sku_id,NEW.location_id,NEW.unit,NEW.state,NEW.connection_id,NEW.created_at)
  IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.sku_id,OLD.location_id,OLD.unit,OLD.state,OLD.connection_id,OLD.created_at)
  OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Account identity is immutable and versions advance once' USING ERRCODE='23514'; END IF;
 SELECT * INTO posting FROM public.inventory_ledger_postings WHERE tenant_id=NEW.tenant_id AND account_id=NEW.id AND account_version=NEW.version;
 IF NOT FOUND OR posting.balance_before<>OLD.balance OR posting.balance_after<>NEW.balance THEN
  RAISE EXCEPTION 'Balance change needs its exact posting' USING ERRCODE='23514';
 END IF;
 IF NEW.balance=0 THEN NEW.nonzero_since_effective=NULL; NEW.nonzero_since_recorded=NULL; NEW.aging_entry_id=NULL;
 ELSIF OLD.balance=0 OR sign(OLD.balance)<>sign(NEW.balance) THEN
  NEW.nonzero_since_effective=posting.effective_at; NEW.nonzero_since_recorded=posting.recorded_at; NEW.aging_entry_id=posting.entry_id;
 ELSE
  NEW.nonzero_since_effective=OLD.nonzero_since_effective; NEW.nonzero_since_recorded=OLD.nonzero_since_recorded; NEW.aging_entry_id=OLD.aging_entry_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_ledger_account_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_ledger_accounts FOR EACH ROW EXECUTE FUNCTION inventory_ledger_account_guard();

CREATE FUNCTION inventory_ledger_commit_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE entry public.inventory_ledger_entries; account_version_now bigint;
BEGIN
 IF TG_TABLE_NAME='inventory_ledger_postings' THEN
  SELECT version INTO account_version_now FROM public.inventory_ledger_accounts WHERE tenant_id=NEW.tenant_id AND id=NEW.account_id;
  IF account_version_now IS NULL OR account_version_now<NEW.account_version THEN
   RAISE EXCEPTION 'Posting must advance its account balance' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
 ELSE entry=NEW;
 END IF;
 IF (SELECT count(*) FROM public.inventory_ledger_postings WHERE tenant_id=entry.tenant_id AND entry_id=entry.id)<2
  OR EXISTS (SELECT 1 FROM public.inventory_ledger_postings WHERE tenant_id=entry.tenant_id AND entry_id=entry.id GROUP BY sku_id,unit HAVING sum(quantity)<>0) THEN
  RAISE EXCEPTION 'Quantity entries must balance for each SKU and unit' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inventory_ledger_commands WHERE tenant_id=entry.tenant_id AND command_key=entry.command_key AND command_hash=entry.command_hash AND receipt->>'entryId'=entry.id::text) THEN
  RAISE EXCEPTION 'Posted entries need their retained receipt' USING ERRCODE='23514';
 END IF;
 IF entry.review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.inventory_ledger_reviews WHERE tenant_id=entry.tenant_id AND id=entry.review_id AND command_hash=entry.command_hash AND state='approved') THEN
  RAISE EXCEPTION 'Entry does not match its approved review' USING ERRCODE='23514';
 END IF;
 IF entry.reversal_of IS NOT NULL AND EXISTS (
  SELECT 1 FROM (SELECT account_id,quantity FROM public.inventory_ledger_postings WHERE tenant_id=entry.tenant_id AND entry_id=entry.id) n
  FULL JOIN (SELECT account_id,quantity FROM public.inventory_ledger_postings WHERE tenant_id=entry.tenant_id AND entry_id=entry.reversal_of) o USING(account_id)
  WHERE n.account_id IS NULL OR o.account_id IS NULL OR n.quantity<>-o.quantity
 ) THEN RAISE EXCEPTION 'Reversal must oppose every original posting' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_ledger_entry_commit AFTER INSERT ON inventory_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_ledger_commit_check();
CREATE CONSTRAINT TRIGGER inventory_ledger_posting_commit AFTER INSERT ON inventory_ledger_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_ledger_commit_check();

GRANT SELECT ON inventory_ledger_accounts,inventory_ledger_entries,inventory_ledger_postings,inventory_ledger_commands,inventory_ledger_reviews,inventory_ledger_checkpoints,inventory_shadow_reconciliations TO luma_inventory;
GRANT INSERT(tenant_id,id,sku_id,location_id,unit,state,connection_id) ON inventory_ledger_accounts TO luma_inventory;
GRANT UPDATE(balance,version) ON inventory_ledger_accounts TO luma_inventory;
GRANT INSERT(tenant_id,entry_id,account_id,sku_id,unit,account_version,quantity,balance_before,balance_after) ON inventory_ledger_postings TO luma_inventory;
GRANT INSERT(tenant_id,id,command_key,command_hash,purpose,reason,actor_id,evidence_refs,effective_at,reversal_of,review_id) ON inventory_ledger_entries TO luma_inventory;
GRANT INSERT ON inventory_ledger_commands,inventory_ledger_checkpoints,inventory_shadow_reconciliations TO luma_inventory;
GRANT INSERT(tenant_id,id,command_key,intent_hash,command_hash,command_document,source_bindings,prepared_by) ON inventory_ledger_reviews TO luma_inventory;
GRANT UPDATE(state,reviewed_by,reviewed_at) ON inventory_ledger_reviews TO luma_inventory;
GRANT SELECT ON inventory_ledger_accounts,inventory_ledger_entries,inventory_ledger_postings,inventory_ledger_reviews,inventory_ledger_checkpoints,inventory_shadow_reconciliations TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['inventory_ledger_accounts','inventory_ledger_entries','inventory_ledger_postings','inventory_ledger_commands','inventory_ledger_reviews','inventory_ledger_checkpoints','inventory_shadow_reconciliations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_inventory USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  IF name<>'inventory_ledger_commands' THEN
   EXECUTE format($policy$CREATE POLICY workspace_read ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  END IF;
 END LOOP;
END $$;

-- A decision is retained once made; later role changes invalidate dispatch, not its history.
CREATE FUNCTION inventory_ledger_review_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Quantity reviews are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
   RAISE EXCEPTION 'Reviews start pending' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.state<>'pending' OR NEW.state NOT IN ('approved','rejected')
  OR (NEW.tenant_id,NEW.id,NEW.command_key,NEW.intent_hash,NEW.command_hash,NEW.command_document,NEW.source_bindings,NEW.prepared_by,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.command_key,OLD.intent_hash,OLD.command_hash,OLD.command_document,OLD.source_bindings,OLD.prepared_by,OLD.created_at) THEN
  RAISE EXCEPTION 'A review preserves its prepared content and final decision' USING ERRCODE='23514';
 END IF;
 NEW.reviewed_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_ledger_review_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_ledger_reviews FOR EACH ROW EXECUTE FUNCTION inventory_ledger_review_guard();

-- Checkpoints summarize a verified version prefix; they never replace the immutable journal.
CREATE FUNCTION inventory_ledger_checkpoint_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous public.inventory_ledger_checkpoints; known numeric; unknown numeric; unknowns bigint; last_effective timestamptz; last_recorded timestamptz;
BEGIN
 SELECT * INTO previous FROM public.inventory_ledger_checkpoints WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND version<NEW.version ORDER BY version DESC LIMIT 1;
 SELECT COALESCE(sum(quantity) FILTER(WHERE effective_at IS NOT NULL),0),
  COALESCE(sum(quantity) FILTER(WHERE effective_at IS NULL),0),count(*) FILTER(WHERE effective_at IS NULL),max(effective_at)
 INTO known,unknown,unknowns,last_effective FROM public.inventory_ledger_postings
 WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND account_version>COALESCE(previous.version,0) AND account_version<=NEW.version;
 SELECT recorded_at INTO last_recorded FROM public.inventory_ledger_postings WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND account_version=NEW.version;
 IF last_recorded IS NULL OR NEW.known_quantity<>COALESCE(previous.known_quantity,0)+known
  OR NEW.unknown_quantity<>COALESCE(previous.unknown_quantity,0)+unknown
  OR NEW.unknown_count<>COALESCE(previous.unknown_count,0)+unknowns
  OR NEW.maximum_effective_at IS DISTINCT FROM greatest(previous.maximum_effective_at,last_effective)
  OR NEW.recorded_at<>last_recorded THEN
  RAISE EXCEPTION 'Checkpoint must match its exact posting prefix' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_ledger_checkpoint_guard BEFORE INSERT ON inventory_ledger_checkpoints FOR EACH ROW EXECUTE FUNCTION inventory_ledger_checkpoint_guard();

CREATE TABLE inventory_ledger_openings (
 tenant_id uuid NOT NULL,sku_id uuid NOT NULL,location_id uuid NOT NULL,unit text NOT NULL,
 review_id uuid NOT NULL,command_key text NOT NULL,entry_id uuid,recorded_at timestamptz(3) NOT NULL,
 PRIMARY KEY(tenant_id,sku_id,location_id,unit),
 FOREIGN KEY(tenant_id,review_id) REFERENCES inventory_ledger_reviews(tenant_id,id),
 FOREIGN KEY(tenant_id,command_key) REFERENCES inventory_ledger_commands(tenant_id,command_key),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES inventory_ledger_entries(tenant_id,id)
);
GRANT SELECT,INSERT ON inventory_ledger_openings TO luma_inventory;
GRANT SELECT ON inventory_ledger_openings TO luma_case_reader;
ALTER TABLE inventory_ledger_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_ledger_openings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_ledger_openings TO luma_inventory USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY workspace_read ON inventory_ledger_openings FOR SELECT TO luma_case_reader USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER inventory_ledger_openings_immutable BEFORE UPDATE OR DELETE ON inventory_ledger_openings FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
