-- Native allocations and location authority remain Inventory-owned; source reads never create them.
CREATE TABLE inventory_stock_ownership_scopes (
 tenant_id uuid NOT NULL,location_id uuid NOT NULL,connection_id uuid NOT NULL,
 location_kind text GENERATED ALWAYS AS ('location'::text) STORED,
 version bigint NOT NULL CHECK(version>0),mode text NOT NULL CHECK(mode IN ('observe','shadow','propose','own')),
 authority_revision bigint NOT NULL CHECK(authority_revision>=0),last_transition_id uuid NOT NULL,
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,location_id),
 FOREIGN KEY(tenant_id,location_kind,location_id) REFERENCES inventory_entities(tenant_id,kind,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE TABLE inventory_stock_ownership_reviews (
 tenant_id uuid NOT NULL,id uuid NOT NULL,command_key text NOT NULL CHECK(length(command_key) BETWEEN 1 AND 256),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 from_mode text NOT NULL CHECK(from_mode IN ('observe','shadow','propose','own')),
 to_mode text NOT NULL CHECK(to_mode IN ('observe','shadow','propose','own')),
 binding jsonb NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1024),prepared_by text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),reviewed_by text,reviewed_at timestamptz(3),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,command_key),
 CHECK((state='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (state<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),CHECK(reviewed_by IS NULL OR reviewed_by<>prepared_by),
 CHECK((from_mode='observe' AND to_mode='shadow') OR (from_mode='shadow' AND to_mode='propose') OR (from_mode='propose' AND to_mode='own') OR (from_mode IN ('shadow','propose','own') AND to_mode='observe'))
);
CREATE TABLE inventory_stock_ownership_transitions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,location_id uuid NOT NULL,connection_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0),review_id uuid NOT NULL,command_key text NOT NULL,
 from_mode text NOT NULL,to_mode text NOT NULL,binding jsonb NOT NULL,actor_id text NOT NULL,reviewer_id text NOT NULL,
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,location_id,version),UNIQUE(tenant_id,review_id),UNIQUE(tenant_id,command_key),
 FOREIGN KEY(tenant_id,review_id) REFERENCES inventory_stock_ownership_reviews(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),CHECK(actor_id<>reviewer_id)
);
ALTER TABLE inventory_stock_ownership_scopes ADD FOREIGN KEY(tenant_id,last_transition_id) REFERENCES inventory_stock_ownership_transitions(tenant_id,id);

CREATE TABLE inventory_native_reservations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,order_id uuid NOT NULL,order_line_id uuid NOT NULL,sku_id uuid NOT NULL,location_id uuid NOT NULL,unit text NOT NULL,
 order_kind text GENERATED ALWAYS AS ('order'::text) STORED,order_line_kind text GENERATED ALWAYS AS ('order_line'::text) STORED,
 sku_kind text GENERATED ALWAYS AS ('sku'::text) STORED,location_kind text GENERATED ALWAYS AS ('location'::text) STORED,
 version bigint NOT NULL CHECK(version>0),allocated numeric(24,6) NOT NULL CHECK(allocated>0),remaining numeric(24,6) NOT NULL CHECK(remaining>=0),
 consumed numeric(24,6) NOT NULL CHECK(consumed>=0),released numeric(24,6) NOT NULL CHECK(released>=0),
 expires_at timestamptz,state text NOT NULL CHECK(state IN ('active','released','consumed','expired')),
 created_at timestamptz(3) NOT NULL,updated_at timestamptz(3) NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,order_kind,order_id) REFERENCES orders_entities(tenant_id,kind,id),
 FOREIGN KEY(tenant_id,order_line_kind,order_line_id) REFERENCES orders_entities(tenant_id,kind,id),
 FOREIGN KEY(tenant_id,sku_kind,sku_id) REFERENCES inventory_entities(tenant_id,kind,id),
 FOREIGN KEY(tenant_id,location_kind,location_id) REFERENCES inventory_entities(tenant_id,kind,id),
 CHECK(allocated=remaining+consumed+released),CHECK((state='active')=(remaining>0)),CHECK(length(unit) BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX inventory_native_reservation_active ON inventory_native_reservations(tenant_id,order_id,order_line_id,location_id,unit) WHERE state='active';
CREATE INDEX inventory_native_reservation_order ON inventory_native_reservations(tenant_id,order_id,id);
CREATE INDEX inventory_native_reservation_pool ON inventory_native_reservations(tenant_id,sku_id,location_id,unit) WHERE state='active';
CREATE INDEX inventory_native_reservation_expiry ON inventory_native_reservations(tenant_id,expires_at,id) WHERE state='active' AND expires_at IS NOT NULL;

CREATE TABLE inventory_native_stock_commands (
 tenant_id uuid NOT NULL,command_key text NOT NULL CHECK(length(command_key) BETWEEN 1 AND 256),command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN ('allocation','release','consumption','amendment')),receipt jsonb NOT NULL,
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,command_key)
);
CREATE TABLE inventory_native_shipment_reads (
 tenant_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,order_id uuid NOT NULL,
 observed_at timestamptz(3) NOT NULL,complete boolean NOT NULL,document jsonb NOT NULL,
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX inventory_native_shipment_order ON inventory_native_shipment_reads(tenant_id,order_id,connection_id,observed_at DESC,recorded_at DESC,id);
CREATE TABLE inventory_native_shipment_claims (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,shipment_id text NOT NULL,order_id uuid NOT NULL,order_line_id uuid NOT NULL,unit text NOT NULL,
 quantity numeric(24,6) NOT NULL CHECK(quantity>0),read_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 baseline_quantity numeric(24,6) NOT NULL DEFAULT 0 CHECK(baseline_quantity>=0 AND baseline_quantity<=quantity),
 basis text NOT NULL CHECK(basis IN ('before_opening','consumed')),CHECK((basis='before_opening')=(baseline_quantity>0)),recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,connection_id,shipment_id,order_line_id),FOREIGN KEY(tenant_id,read_id) REFERENCES inventory_native_shipment_reads(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX inventory_native_claim_order ON inventory_native_shipment_claims(tenant_id,order_id,order_line_id,unit);
CREATE TABLE inventory_native_shipment_consumptions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,shipment_id text NOT NULL,order_line_id uuid NOT NULL,
 reservation_id uuid NOT NULL,read_id uuid NOT NULL,entry_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,read_id,shipment_id,order_line_id,reservation_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES inventory_native_reservations(tenant_id,id),
 FOREIGN KEY(tenant_id,read_id) REFERENCES inventory_native_shipment_reads(tenant_id,id),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES inventory_ledger_entries(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);

CREATE FUNCTION inventory_native_reservation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservations are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'active' OR NEW.consumed<>0 OR NEW.released<>0 OR NEW.allocated<>NEW.remaining THEN RAISE EXCEPTION 'Reservations begin with exact active remaining units' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.state<>'active' OR NEW.version<>OLD.version+1
   OR (NEW.tenant_id,NEW.id,NEW.order_id,NEW.order_line_id,NEW.sku_id,NEW.location_id,NEW.unit,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.order_line_id,OLD.sku_id,OLD.location_id,OLD.unit,OLD.expires_at,OLD.created_at)
   OR NEW.allocated<OLD.allocated OR NEW.consumed<OLD.consumed OR NEW.released<OLD.released THEN RAISE EXCEPTION 'Reservation identity and consumed/released history are retained' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_native_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_native_reservations FOR EACH ROW EXECUTE FUNCTION inventory_native_reservation_guard();

CREATE FUNCTION inventory_native_reserved_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE sku uuid;location uuid;stock_unit text;reserved numeric;represented numeric;
BEGIN
 IF TG_TABLE_NAME='inventory_native_reservations' THEN sku=NEW.sku_id;location=NEW.location_id;stock_unit=NEW.unit;
 ELSE
  IF NEW.state<>'reserved' THEN RETURN NULL; END IF;
  sku=NEW.sku_id;location=NEW.location_id;stock_unit=NEW.unit;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inventory_stock_ownership_scopes WHERE tenant_id=NEW.tenant_id AND location_id=location AND mode<>'observe') THEN RETURN NULL; END IF;
 SELECT COALESCE(sum(remaining),0) INTO represented FROM public.inventory_native_reservations WHERE tenant_id=NEW.tenant_id AND sku_id=sku AND location_id=location AND unit=stock_unit;
 SELECT balance INTO reserved FROM public.inventory_ledger_accounts WHERE tenant_id=NEW.tenant_id AND sku_id=sku AND location_id=location AND unit=stock_unit AND state='reserved';
 IF reserved IS NULL OR reserved<>represented THEN RAISE EXCEPTION 'Reserved stock must equal represented remaining reservations' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_native_reservation_commit AFTER INSERT OR UPDATE ON inventory_native_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_native_reserved_check();
CREATE CONSTRAINT TRIGGER inventory_native_account_commit AFTER INSERT OR UPDATE ON inventory_ledger_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_native_reserved_check();

CREATE TRIGGER inventory_native_commands_immutable BEFORE UPDATE OR DELETE ON inventory_native_stock_commands FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_native_reads_immutable BEFORE UPDATE OR DELETE ON inventory_native_shipment_reads FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_native_consumptions_immutable BEFORE UPDATE OR DELETE ON inventory_native_shipment_consumptions FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER inventory_native_transitions_immutable BEFORE UPDATE OR DELETE ON inventory_stock_ownership_transitions FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();

GRANT SELECT,INSERT ON inventory_native_reservations,inventory_native_stock_commands,inventory_native_shipment_reads,inventory_native_shipment_claims,inventory_native_shipment_consumptions,inventory_stock_ownership_scopes,inventory_stock_ownership_reviews,inventory_stock_ownership_transitions TO luma_inventory;
GRANT UPDATE(version,allocated,remaining,consumed,released,state,updated_at) ON inventory_native_reservations TO luma_inventory;
GRANT UPDATE(quantity,read_id,version,recorded_at) ON inventory_native_shipment_claims TO luma_inventory;
GRANT UPDATE(version,mode,connection_id,authority_revision,last_transition_id,updated_at) ON inventory_stock_ownership_scopes TO luma_inventory;
GRANT UPDATE(state,reviewed_by,reviewed_at) ON inventory_stock_ownership_reviews TO luma_inventory;
GRANT SELECT ON inventory_native_reservations,inventory_native_shipment_reads,inventory_native_shipment_claims,inventory_native_shipment_consumptions,inventory_stock_ownership_scopes,inventory_stock_ownership_reviews,inventory_stock_ownership_transitions TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['inventory_native_reservations','inventory_native_stock_commands','inventory_native_shipment_reads','inventory_native_shipment_claims','inventory_native_shipment_consumptions','inventory_stock_ownership_scopes','inventory_stock_ownership_reviews','inventory_stock_ownership_transitions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_inventory USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  IF name<>'inventory_native_stock_commands' THEN EXECUTE format($policy$CREATE POLICY workspace_read ON %I FOR SELECT TO luma_case_reader USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name); END IF;
 END LOOP;
END $$;

CREATE FUNCTION inventory_stock_review_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership reviews are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'Ownership reviews start pending' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.state<>'pending' OR NEW.state NOT IN ('approved','rejected') OR (NEW.tenant_id,NEW.id,NEW.command_key,NEW.intent_hash,NEW.from_mode,NEW.to_mode,NEW.binding,NEW.reason,NEW.prepared_by,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.command_key,OLD.intent_hash,OLD.from_mode,OLD.to_mode,OLD.binding,OLD.reason,OLD.prepared_by,OLD.created_at) THEN RAISE EXCEPTION 'Ownership reviews preserve prepared content and the final decision' USING ERRCODE='23514'; END IF;
  NEW.reviewed_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_stock_review_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stock_ownership_reviews FOR EACH ROW EXECUTE FUNCTION inventory_stock_review_guard();

CREATE FUNCTION inventory_stock_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE transition public.inventory_stock_ownership_transitions;review public.inventory_stock_ownership_reviews;previous_mode text;previous_version bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership history is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN previous_mode='observe';previous_version=0;
 ELSE
  previous_mode=OLD.mode;previous_version=OLD.version;
  IF (NEW.tenant_id,NEW.location_id) IS DISTINCT FROM (OLD.tenant_id,OLD.location_id) OR (NEW.connection_id<>OLD.connection_id AND NOT(OLD.mode='observe' AND NEW.mode='shadow')) THEN RAISE EXCEPTION 'Owned location identity cannot change silently' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT * INTO transition FROM public.inventory_stock_ownership_transitions WHERE tenant_id=NEW.tenant_id AND id=NEW.last_transition_id;
 SELECT * INTO review FROM public.inventory_stock_ownership_reviews WHERE tenant_id=NEW.tenant_id AND id=transition.review_id;
 IF NEW.version<>previous_version+1 OR transition.location_id<>NEW.location_id OR transition.connection_id<>NEW.connection_id OR transition.version<>NEW.version OR transition.from_mode<>previous_mode OR transition.to_mode<>NEW.mode
  OR review.state IS DISTINCT FROM 'approved' OR review.from_mode<>previous_mode OR review.to_mode<>NEW.mode OR review.binding IS DISTINCT FROM transition.binding
  OR (transition.binding->>'scopeVersion') IS DISTINCT FROM previous_version::text OR (transition.binding->>'authorityRevision') IS DISTINCT FROM NEW.authority_revision::text OR (transition.binding->>'locationId') IS DISTINCT FROM NEW.location_id::text OR (transition.binding->>'connectionId') IS DISTINCT FROM NEW.connection_id::text
  OR review.prepared_by<>transition.actor_id OR review.reviewed_by<>transition.reviewer_id THEN RAISE EXCEPTION 'Location ownership needs its exact approved transition' USING ERRCODE='23514'; END IF;
 IF NEW.mode='observe' AND EXISTS(SELECT 1 FROM public.inventory_native_reservations WHERE tenant_id=NEW.tenant_id AND location_id=NEW.location_id AND remaining>0) THEN RAISE EXCEPTION 'Release or consume active reservations before handback' USING ERRCODE='23514'; END IF;
 IF NEW.mode<>'observe' AND EXISTS(SELECT 1 FROM public.inventory_ledger_accounts a WHERE a.tenant_id=NEW.tenant_id AND a.location_id=NEW.location_id AND a.state='reserved' AND a.balance<>(SELECT COALESCE(sum(r.remaining),0) FROM public.inventory_native_reservations r WHERE r.tenant_id=a.tenant_id AND r.sku_id=a.sku_id AND r.location_id=a.location_id AND r.unit=a.unit)) THEN RAISE EXCEPTION 'Every reserved unit needs its native order-line allocation' USING ERRCODE='23514'; END IF;
 NEW.updated_at=transition.recorded_at;RETURN NEW;
END $$;
CREATE TRIGGER inventory_stock_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stock_ownership_scopes FOR EACH ROW EXECUTE FUNCTION inventory_stock_scope_guard();

CREATE FUNCTION inventory_native_claim_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Shipment claims are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN IF NEW.version<>1 THEN RAISE EXCEPTION 'Shipment claims start at version one' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.version<>OLD.version+1 OR NEW.quantity<=OLD.quantity OR (NEW.tenant_id,NEW.connection_id,NEW.shipment_id,NEW.order_id,NEW.order_line_id,NEW.unit,NEW.basis,NEW.baseline_quantity) IS DISTINCT FROM (OLD.tenant_id,OLD.connection_id,OLD.shipment_id,OLD.order_id,OLD.order_line_id,OLD.unit,OLD.basis,OLD.baseline_quantity) THEN RAISE EXCEPTION 'Shipment identity and consumed history cannot be rewritten' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_native_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_native_shipment_claims FOR EACH ROW EXECUTE FUNCTION inventory_native_claim_guard();

-- Final decisions retain both reviewer identity and decision time.
ALTER TABLE inventory_ledger_reviews ADD CONSTRAINT inventory_ledger_review_final_identity
 CHECK((state='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (state<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));

-- Native updates wake inventory and order views after the same committing transaction.
DO $$ DECLARE entry text[]; BEGIN
 FOREACH entry SLICE 1 IN ARRAY ARRAY[
  ['inventory_native_reservations','inventory,orders'],
  ['inventory_stock_ownership_scopes','inventory,orders'],
  ['inventory_stock_ownership_reviews','inventory,decisions'],
  ['inventory_ledger_accounts','inventory'],
  ['inventory_ledger_reviews','inventory,decisions']
 ] LOOP
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change(%L)',entry[1],entry[2]);
 END LOOP;
END $$;


-- A failed point read is retained uncertainty, not a zero quantity or a provider tombstone.
CREATE TABLE inventory_native_stock_read_checks (
 tenant_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,sku_id uuid NOT NULL,location_id uuid NOT NULL,
 unit text NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),actor_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('complete','unavailable')),snapshot_id uuid,
 recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,location_id) REFERENCES inventory_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,id),
 CHECK((state='complete')=(snapshot_id IS NOT NULL))
);
CREATE INDEX inventory_native_stock_read_scope ON inventory_native_stock_read_checks(tenant_id,connection_id,sku_id,location_id,unit,recorded_at DESC,id);
ALTER TABLE inventory_native_stock_read_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_native_stock_read_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_native_stock_read_checks TO luma_inventory USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY workspace_read ON inventory_native_stock_read_checks FOR SELECT TO luma_case_reader USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON inventory_native_stock_read_checks TO luma_inventory,luma_case_reader;
GRANT INSERT(tenant_id,id,connection_id,sku_id,location_id,unit,actor_id,state,snapshot_id) ON inventory_native_stock_read_checks TO luma_inventory;
CREATE TRIGGER inventory_native_stock_read_immutable BEFORE UPDATE OR DELETE ON inventory_native_stock_read_checks FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON inventory_native_stock_read_checks FOR EACH ROW EXECUTE FUNCTION notify_metric_change('inventory');
