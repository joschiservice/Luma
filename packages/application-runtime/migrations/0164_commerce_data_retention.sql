-- Closed workspaces and redacted shops lose their retained data instead of keeping it forever.
-- Every public table with a tenant_id column has a retention class in `data_retention_classes`:
-- `purge_on_closure` rows are deleted once a closed workspace's deletion date has passed,
-- `keep_with_organization` rows stay with the organization row and follow their own lifecycle
-- (account deletion, staff and support retention), and `legal_retention` rows (audit entries)
-- are deleted by a separate, longer retention pass. A migration that adds a tenant table must
-- classify it; purges refuse to run while any tenant table is unclassified. A Shopify shop/redact
-- queues the bound connection's rows for the same batched removal. Both run in the commerce
-- sync process.

-- Closure time starts the retention window. Workspaces closed before this migration start now.
-- `data_deletion_at` is the date owners were told; it is set once by the retention pass and only
-- ever moves later, so data is never deleted before the announced date.
ALTER TABLE organizations
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN data_deletion_at timestamptz,
 ADD COLUMN purge_started_at timestamptz,
 ADD COLUMN data_purged_at timestamptz;
UPDATE organizations SET closed_at=now() WHERE status='closed';

-- Reopening is refused once removal has started, because the workspace would be incomplete.
-- Reopening before then clears the closure, its deletion date and its queued notices.
CREATE FUNCTION organization_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status='closed' THEN
  NEW.closed_at := CASE WHEN OLD.status='closed' THEN OLD.closed_at ELSE now() END;
  NEW.data_deletion_at := CASE WHEN OLD.status='closed' THEN OLD.data_deletion_at END;
 ELSIF OLD.purge_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'workspace data was removed after closure' USING ERRCODE='55000';
 ELSE
  NEW.closed_at := NULL;
  NEW.data_deletion_at := NULL;
 END IF;
 NEW.purge_started_at := OLD.purge_started_at;
 NEW.data_purged_at := OLD.data_purged_at;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_closure BEFORE UPDATE OF status ON organizations
 FOR EACH ROW EXECUTE FUNCTION organization_closure();
-- Purge bookkeeping writes the columns directly; the trigger above only follows status changes.
CREATE INDEX organizations_closed ON organizations(closed_at) WHERE status='closed' AND data_purged_at IS NULL;

CREATE TABLE data_retention_classes (
 table_name text PRIMARY KEY,
 class text NOT NULL CHECK(class IN ('purge_on_closure','keep_with_organization','legal_retention'))
);

-- Tenant tables without a retention class. Purges stop while this returns anything, so a table
-- added without a class is neither deleted nor silently kept; tests fail on it first.
CREATE FUNCTION data_retention_unclassified() RETURNS SETOF text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT c.relname::text FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace AND s.nspname='public'
 WHERE c.relkind IN ('r','p')
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
  AND NOT EXISTS (SELECT 1 FROM public.data_retention_classes r WHERE r.table_name=c.relname)
 ORDER BY 1
$$;
REVOKE ALL ON FUNCTION data_retention_unclassified() FROM PUBLIC;

-- Marks the current transaction as a purge of one tenant. Only the purge functions write it, and
-- they remove their row before returning, so the table stays empty outside a purge.
CREATE TABLE data_purge_sessions (
 xact text PRIMARY KEY,
 tenant_id uuid NOT NULL
);
ALTER TABLE data_purge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_purge_sessions FORCE ROW LEVEL SECURITY;

CREATE FUNCTION data_purge_active(target uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (SELECT 1 FROM public.data_purge_sessions s
  WHERE s.xact=pg_current_xact_id()::text AND s.tenant_id=target)
$$;
-- Delete triggers evaluate it as whichever role deletes; it only reveals the caller's own purge.
GRANT EXECUTE ON FUNCTION data_purge_active(uuid) TO PUBLIC;

-- Refuses deleting retained evidence except inside a purge of the row's tenant. Immutable tables
-- attach this one BEFORE DELETE trigger instead of handling deletes in their own guard, so every
-- such table follows the same rule.
CREATE FUNCTION refuse_delete_outside_purge() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.data_purge_active(OLD.tenant_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION '% rows are retained', TG_TABLE_NAME USING ERRCODE='23514';
END $$;

-- Immutable evidence stays immutable to every caller except a purge of its own tenant. Deletes
-- move to the shared guard; updates and inserts keep their table's guard.
DO $$ DECLARE entry text[]; BEGIN
 FOREACH entry SLICE 1 IN ARRAY ARRAY[
  ['inventory_ledger_entries_immutable','inventory_ledger_entries','UPDATE','inventory_ledger_immutable'],
  ['inventory_ledger_postings_immutable','inventory_ledger_postings','UPDATE','inventory_ledger_immutable'],
  ['inventory_ledger_commands_immutable','inventory_ledger_commands','UPDATE','inventory_ledger_immutable'],
  ['inventory_ledger_checkpoints_immutable','inventory_ledger_checkpoints','UPDATE','inventory_ledger_immutable'],
  ['inventory_shadow_immutable','inventory_shadow_reconciliations','UPDATE','inventory_ledger_immutable'],
  ['inventory_ledger_openings_immutable','inventory_ledger_openings','UPDATE','inventory_ledger_immutable'],
  ['inventory_native_commands_immutable','inventory_native_stock_commands','UPDATE','inventory_ledger_immutable'],
  ['inventory_native_reads_immutable','inventory_native_shipment_reads','UPDATE','inventory_ledger_immutable'],
  ['inventory_native_consumptions_immutable','inventory_native_shipment_consumptions','UPDATE','inventory_ledger_immutable'],
  ['inventory_native_transitions_immutable','inventory_stock_ownership_transitions','UPDATE','inventory_ledger_immutable'],
  ['inventory_native_stock_read_immutable','inventory_native_stock_read_checks','UPDATE','inventory_ledger_immutable'],
  ['shopify_native_replica_immutable','shopify_native_stock_replicas','UPDATE','inventory_ledger_immutable'],
  ['adaptive_event_immutable','adaptive_field_events','UPDATE','adaptive_event_immutable'],
  ['inventory_ledger_account_guard','inventory_ledger_accounts','INSERT OR UPDATE','inventory_ledger_account_guard'],
  ['inventory_ledger_review_guard','inventory_ledger_reviews','INSERT OR UPDATE','inventory_ledger_review_guard'],
  ['inventory_native_reservation_guard','inventory_native_reservations','INSERT OR UPDATE','inventory_native_reservation_guard'],
  ['inventory_stock_review_guard','inventory_stock_ownership_reviews','INSERT OR UPDATE','inventory_stock_review_guard'],
  ['inventory_stock_scope_guard','inventory_stock_ownership_scopes','INSERT OR UPDATE','inventory_stock_scope_guard'],
  ['inventory_native_claim_guard','inventory_native_shipment_claims','INSERT OR UPDATE','inventory_native_claim_guard']
 ] LOOP
  EXECUTE format('DROP TRIGGER %I ON %I',entry[1],entry[2]);
  EXECUTE format('CREATE TRIGGER %I BEFORE %s ON %I FOR EACH ROW EXECUTE FUNCTION %I()',entry[1],entry[3],entry[2],entry[4]);
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION refuse_delete_outside_purge()',
   entry[1]||'_delete',entry[2]);
 END LOOP;
END $$;

-- Deletes up to `budget` rows of one tenant, or of one of its connections, from every table
-- classified `purge_on_closure` except `kept`. While a tenant table is unclassified it deletes
-- nothing and reports that table as blocked. A connection covers tables with a connection_id and rows that reference
-- them through foreign keys. Tables are retried until a pass makes no progress, so referencing
-- rows go first whatever the order; a self-referencing scope is removed in one statement.
-- Returns the rows deleted, whether nothing is left, and a table still blocked by a reference.
CREATE FUNCTION purge_scoped_rows(target uuid, connection uuid, budget integer, kept text[])
 RETURNS TABLE(deleted integer, done boolean, blocked text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 scopes jsonb := '{}'::jsonb; added boolean; rel record; fk record; depth integer := 0;
 total integer := 0; n integer; removed integer; progress boolean; stuck text; parent text; joined text; alias text;
BEGIN
 SELECT u INTO stuck FROM public.data_retention_unclassified() u LIMIT 1;
 IF stuck IS NOT NULL THEN
  deleted := 0; done := false; blocked := 'unclassified:'||stuck;
  RETURN NEXT;
  RETURN;
 END IF;
 INSERT INTO public.data_purge_sessions(xact,tenant_id) VALUES(pg_current_xact_id()::text,target)
  ON CONFLICT (xact) DO UPDATE SET tenant_id=EXCLUDED.tenant_id;
 -- Predicates take the row alias as %1$s; $1 is the tenant and $2 the connection.
 FOR rel IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace AND s.nspname='public'
  WHERE c.relkind='r' AND NOT c.relname=ANY(kept)
   AND EXISTS (SELECT 1 FROM public.data_retention_classes r WHERE r.table_name=c.relname AND r.class='purge_on_closure')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
   AND (connection IS NULL OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
    AND a.attname='connection_id' AND a.atttypid='uuid'::regtype AND NOT a.attisdropped)) LOOP
  scopes := scopes || jsonb_build_object(rel.relname, CASE WHEN connection IS NULL THEN '%1$s.tenant_id=$1'
   ELSE '%1$s.tenant_id=$1 AND %1$s.connection_id=$2' END);
 END LOOP;
 IF connection IS NOT NULL THEN
  LOOP
   added := false; depth := depth+1;
   FOR fk IN SELECT c.conrelid::regclass::text child,c.confrelid::regclass::text parent,
     (SELECT string_agg(format('%%2$s.%I=%%1$s.%I',pa.attname,ca.attname),' AND ')
      FROM unnest(c.conkey,c.confkey) k(ck,pk)
      JOIN pg_attribute ca ON ca.attrelid=c.conrelid AND ca.attnum=k.ck
      JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=k.pk) cond
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace s ON s.oid=r.relnamespace AND s.nspname='public'
    WHERE c.contype='f' AND c.conrelid<>c.confrelid AND NOT r.relname=ANY(kept)
     AND EXISTS (SELECT 1 FROM public.data_retention_classes rc WHERE rc.table_name=r.relname AND rc.class='purge_on_closure')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='tenant_id' AND NOT a.attisdropped)
     AND scopes ? c.confrelid::regclass::text AND NOT scopes ? c.conrelid::regclass::text LOOP
    alias := 'p'||depth;
    joined := format('%%1$s.tenant_id=$1 AND EXISTS (SELECT 1 FROM public.%I %s WHERE %s AND (%s))',
     fk.parent,alias,replace(fk.cond,'%2$s',alias),format(scopes->>fk.parent,alias));
    -- A table referencing several scoped parents matches through any of them.
    scopes := scopes || jsonb_build_object(fk.child, COALESCE((scopes->>fk.child)||' OR ','')||joined);
    added := true;
   END LOOP;
   EXIT WHEN NOT added OR depth>=4;
  END LOOP;
 END IF;
 LOOP
  progress := false; stuck := NULL;
  FOR rel IN SELECT key relname,value pred FROM jsonb_each_text(scopes) ORDER BY key LOOP
   EXIT WHEN total>=budget;
   BEGIN
    EXECUTE format('DELETE FROM public.%I t WHERE t.ctid IN (SELECT x.ctid FROM public.%I x WHERE %s LIMIT $3)',
     rel.relname,rel.relname,format(rel.pred,'x')) USING target,connection,budget-total;
    GET DIAGNOSTICS n = ROW_COUNT;
   EXCEPTION WHEN foreign_key_violation THEN
    BEGIN
     EXECUTE format('DELETE FROM public.%I t WHERE %s',rel.relname,format(rel.pred,'t')) USING target,connection;
     GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION WHEN foreign_key_violation THEN
     n := 0; stuck := rel.relname;
    END;
   END;
   total := total+n;
   progress := progress OR n>0;
  END LOOP;
  EXIT WHEN total>=budget OR NOT progress;
 END LOOP;
 -- Deferred references are checked before returning, so a batch never ends between the two
 -- sides of a reference cycle; the rest of such a cycle goes in this transaction.
 LOOP
  BEGIN
   SET CONSTRAINTS ALL IMMEDIATE;
   EXIT;
  EXCEPTION WHEN foreign_key_violation THEN
   removed := 0;
   FOR rel IN SELECT key relname,value pred FROM jsonb_each_text(scopes) ORDER BY key LOOP
    BEGIN
     EXECUTE format('DELETE FROM public.%I t WHERE %s',rel.relname,format(rel.pred,'t')) USING target,connection;
     GET DIAGNOSTICS n = ROW_COUNT;
     removed := removed+n;
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
   END LOOP;
   IF removed=0 THEN RAISE; END IF;
   total := total+removed;
   progress := true;
  END;
 END LOOP;
 DELETE FROM public.data_purge_sessions WHERE xact=pg_current_xact_id()::text;
 deleted := total;
 done := total<budget AND NOT progress AND stuck IS NULL;
 blocked := CASE WHEN total<budget AND NOT progress THEN stuck END;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION purge_scoped_rows(uuid,uuid,integer,text[]) FROM PUBLIC;

-- Owner notices about a closed workspace's deletion: when it is scheduled and about a week before.
-- One notice per owner, kind and announced date, so restarts never send twice and a later date
-- is announced again. Only the functions below read or write it; identity delivers through them.
CREATE TABLE workspace_closure_mail (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('closure_scheduled','closure_reminder')),
 deletion_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 first_attempt_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE(tenant_id,user_id,kind,deletion_at)
);
CREATE INDEX workspace_closure_mail_due ON workspace_closure_mail(next_attempt_at) WHERE state='queued';
ALTER TABLE workspace_closure_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_closure_mail FORCE ROW LEVEL SECURITY;

-- Announces deletion dates for closed workspaces and queues owner notices. A first date is the
-- closure plus `retention_days`, but at least seven days after it is announced, so owners always
-- hear before deletion. A longer window moves an announced date later; a shorter one never
-- moves it earlier. Returns the workspaces whose date was set or moved.
CREATE FUNCTION schedule_closed_workspace_deletions(retention_days integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scheduled integer;
BEGIN
 IF retention_days IS NULL OR retention_days<30 THEN
  RAISE EXCEPTION 'retention must be at least 30 days' USING ERRCODE='22023';
 END IF;
 UPDATE public.organizations o SET data_deletion_at=GREATEST(o.closed_at+make_interval(days=>retention_days),
   COALESCE(o.data_deletion_at,now()+interval '7 days'))
 WHERE o.status='closed' AND o.purge_started_at IS NULL AND o.closed_at IS NOT NULL
  AND (o.data_deletion_at IS NULL OR o.data_deletion_at<o.closed_at+make_interval(days=>retention_days));
 GET DIAGNOSTICS scheduled = ROW_COUNT;
 -- The reminder is skipped when the first notice already went out within eight days of deletion.
 INSERT INTO public.workspace_closure_mail(id,tenant_id,user_id,kind,deletion_at)
  SELECT gen_random_uuid(),o.id,m.user_id,k.kind,o.data_deletion_at
  FROM public.organizations o
  JOIN public.memberships m ON m.tenant_id=o.id AND m.role='owner' AND m.status='active'
  CROSS JOIN (VALUES ('closure_scheduled'),('closure_reminder')) k(kind)
  WHERE o.status='closed' AND o.purge_started_at IS NULL AND o.data_deletion_at IS NOT NULL
   AND (k.kind='closure_scheduled' OR (o.data_deletion_at<=now()+interval '7 days'
    AND EXISTS (SELECT 1 FROM public.workspace_closure_mail f WHERE f.tenant_id=o.id AND f.user_id=m.user_id
     AND f.kind='closure_scheduled' AND f.deletion_at=o.data_deletion_at
     AND f.created_at<o.data_deletion_at-interval '8 days')))
  ON CONFLICT (tenant_id,user_id,kind,deletion_at) DO NOTHING;
 RETURN scheduled;
END $$;
REVOKE ALL ON FUNCTION schedule_closed_workspace_deletions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schedule_closed_workspace_deletions(integer) TO luma_commerce_sync;

-- Removes one batch of the oldest closed workspace whose announced deletion date has passed.
-- Only `purge_on_closure` tables are deleted; the organization and the tables classified to stay
-- with it remain, and audit entries wait for their own retention pass.
CREATE FUNCTION purge_closed_workspace_data(batch integer)
 RETURNS TABLE(tenant_id uuid, deleted integer, done boolean, blocked text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid; result record;
BEGIN
 SELECT o.id INTO target FROM public.organizations o
  WHERE o.status='closed' AND o.data_purged_at IS NULL AND o.data_deletion_at<=now()
  ORDER BY o.data_deletion_at,o.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF target IS NULL THEN RETURN; END IF;
 SELECT * INTO result FROM public.purge_scoped_rows(target,NULL,LEAST(GREATEST(batch,1),5000),'{}');
 IF result.blocked LIKE 'unclassified:%' THEN
  tenant_id := target; deleted := 0; done := false; blocked := result.blocked;
  RETURN NEXT;
  RETURN;
 END IF;
 UPDATE public.organizations o SET purge_started_at=COALESCE(o.purge_started_at,now()),
  data_purged_at=CASE WHEN result.done THEN now() END WHERE o.id=target;
 UPDATE public.workspace_closure_mail m SET state='cancelled' WHERE m.tenant_id=target AND m.state='queued';
 tenant_id := target; deleted := result.deleted; done := result.done; blocked := result.blocked;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION purge_closed_workspace_data(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_closed_workspace_data(integer) TO luma_commerce_sync;

-- Deletes up to `batch` audit entries of workspaces closed at least `audit_days` ago whose other
-- data is already removed. Active workspaces and closures still inside the window keep every entry.
CREATE FUNCTION purge_closed_workspace_audit(audit_days integer, batch integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE removed integer;
BEGIN
 IF audit_days IS NULL OR audit_days<30 THEN
  RAISE EXCEPTION 'audit retention must be at least 30 days' USING ERRCODE='22023';
 END IF;
 DELETE FROM public.audit_entries a WHERE a.ctid IN (
  SELECT x.ctid FROM public.audit_entries x JOIN public.organizations o ON o.id=x.tenant_id
  WHERE o.status='closed' AND o.data_purged_at IS NOT NULL
   AND o.closed_at<=now()-make_interval(days=>audit_days)
  LIMIT LEAST(GREATEST(batch,1),5000));
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION purge_closed_workspace_audit(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_closed_workspace_audit(integer,integer) TO luma_commerce_sync;

-- Reserves the next due closure notice for delivery: its attempt is counted before sending, as for
-- account notices, and it fails after five attempts or 23 hours. `valid` is false when the person
-- is no longer an active owner, the workspace was reopened, its date changed or removal started.
CREATE FUNCTION reserve_workspace_closure_mail()
 RETURNS TABLE(id uuid, kind text, state text, attempts integer, email text, locale text,
  workspace text, deletion_at timestamptz, valid boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE message record;
BEGIN
 SELECT m.* INTO message FROM public.workspace_closure_mail m
  WHERE m.state='queued' AND m.next_attempt_at<=now() ORDER BY m.next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF message IS NULL THEN RETURN; END IF;
 UPDATE public.workspace_closure_mail m SET
  state=CASE WHEN m.attempts>=5 OR m.first_attempt_at<=now()-interval '23 hours' THEN 'failed' ELSE 'queued' END,
  attempts=CASE WHEN m.attempts>=5 OR m.first_attempt_at<=now()-interval '23 hours' THEN m.attempts ELSE m.attempts+1 END,
  first_attempt_at=COALESCE(m.first_attempt_at,now()),next_attempt_at=now()+interval '60 seconds'
 WHERE m.id=message.id RETURNING m.state,m.attempts INTO state,attempts;
 id := message.id; kind := message.kind; deletion_at := message.deletion_at;
 SELECT u.email,u.locale,o.name,
  o.status='closed' AND o.purge_started_at IS NULL AND o.data_deletion_at=message.deletion_at
   AND EXISTS (SELECT 1 FROM public.memberships s WHERE s.tenant_id=o.id AND s.user_id=u.id
    AND s.role='owner' AND s.status='active')
  INTO email,locale,workspace,valid
  FROM public.users u JOIN public.organizations o ON o.id=message.tenant_id WHERE u.id=message.user_id;
 valid := COALESCE(valid,false);
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION reserve_workspace_closure_mail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_workspace_closure_mail() TO luma_identity;

-- Records a reserved notice's outcome: `sent`, `failed` (retried after `delay` seconds until its
-- attempts run out), `deferred` (rate limited; the attempt is returned) or `cancelled`. Applies
-- only to the reserved attempt, so a stale result is ignored.
CREATE FUNCTION record_workspace_closure_mail(message uuid, attempt integer, outcome text, delay integer)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE public.workspace_closure_mail m SET
  state=CASE outcome WHEN 'sent' THEN 'sent' WHEN 'cancelled' THEN 'cancelled'
   WHEN 'failed' THEN CASE WHEN m.attempts>=5 THEN 'failed' ELSE 'queued' END ELSE 'queued' END,
  attempts=CASE WHEN outcome='deferred' THEN m.attempts-1 ELSE m.attempts END,
  sent_at=CASE WHEN outcome='sent' THEN now() ELSE m.sent_at END,
  next_attempt_at=now()+make_interval(secs=>GREATEST(delay,0))
 WHERE m.id=message AND m.state='queued' AND m.attempts=attempt
$$;
REVOKE ALL ON FUNCTION record_workspace_closure_mail(uuid,integer,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_workspace_closure_mail(uuid,integer,text,integer) TO luma_identity;

-- Connections whose retained shop data must be removed. Only the purge functions read or write it.
CREATE TABLE connection_data_purges (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 connection_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('shopify_shop_redact')),
 requested_at timestamptz NOT NULL,
 completed_at timestamptz,
 outcome text CHECK(outcome IS NULL OR outcome IN ('purged','superseded')),
 PRIMARY KEY(tenant_id,connection_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK((completed_at IS NULL)=(outcome IS NULL))
);
CREATE INDEX connection_data_purges_pending ON connection_data_purges(requested_at) WHERE completed_at IS NULL;
ALTER TABLE connection_data_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_data_purges FORCE ROW LEVEL SECURITY;

-- Queues every installation of the shop for removal. Uninstall already erased its credentials;
-- a connection that is active again belongs to a newer installation and is left to the operator.
CREATE FUNCTION erase_shopify_shop_data(app_key text, shop_domain text) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE queued integer;
BEGIN
 INSERT INTO public.connection_data_purges(tenant_id,connection_id,reason,requested_at)
  SELECT b.tenant_id,b.connection_id,'shopify_shop_redact',now()
  FROM public.shopify_installation_bindings b
  JOIN public.connector_installations i ON i.tenant_id=b.tenant_id AND i.id=b.connection_id
  WHERE b.app=app_key AND b.shop=shop_domain AND i.secret IS NULL
   AND i.document->>'status' IN ('revoked','disconnected')
  ON CONFLICT (tenant_id,connection_id) DO UPDATE
   SET requested_at=EXCLUDED.requested_at,completed_at=NULL,outcome=NULL;
 GET DIAGNOSTICS queued = ROW_COUNT;
 RETURN queued;
END $$;
REVOKE ALL ON FUNCTION erase_shopify_shop_data(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_shopify_shop_data(text,text) TO luma_connectors;

-- Removes one batch of the oldest queued connection. A reconnect before removal finishes stops
-- it, so a newer installation's data is never deleted. The connection row, its lifecycle, the
-- shop binding and customer erasure markers stay, so later requests and imports still resolve.
CREATE FUNCTION purge_requested_connection_data(batch integer)
 RETURNS TABLE(tenant_id uuid, connection_id uuid, deleted integer, done boolean, blocked text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request record; result record;
BEGIN
 SELECT p.tenant_id,p.connection_id INTO request FROM public.connection_data_purges p
  WHERE p.completed_at IS NULL ORDER BY p.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF request IS NULL THEN RETURN; END IF;
 tenant_id := request.tenant_id; connection_id := request.connection_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('customers:'||request.tenant_id||':'||request.connection_id,0));
 IF NOT EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=request.tenant_id
   AND i.id=request.connection_id AND i.secret IS NULL AND i.document->>'status' IN ('revoked','disconnected')) THEN
  UPDATE public.connection_data_purges p SET completed_at=now(),outcome='superseded'
   WHERE p.tenant_id=request.tenant_id AND p.connection_id=request.connection_id;
  deleted := 0; done := true; blocked := NULL;
  RETURN NEXT;
  RETURN;
 END IF;
 SELECT * INTO result FROM public.purge_scoped_rows(request.tenant_id,request.connection_id,
  LEAST(GREATEST(batch,1),5000),
  ARRAY['connector_lifecycle_events','shopify_installation_bindings','customer_erasures','connection_data_purges']);
 IF result.done THEN
  UPDATE public.connection_data_purges p SET completed_at=now(),outcome='purged'
   WHERE p.tenant_id=request.tenant_id AND p.connection_id=request.connection_id;
 END IF;
 deleted := result.deleted; done := result.done; blocked := result.blocked;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION purge_requested_connection_data(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_requested_connection_data(integer) TO luma_commerce_sync;

-- Counts open privacy requests near their deadline without revealing their content or shop.
CREATE FUNCTION shopify_privacy_requests_due(within_days integer)
 RETURNS TABLE(due integer, overdue integer, next_due_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT count(*)::integer,count(*) FILTER (WHERE r.due_at<=now())::integer,min(r.due_at)
 FROM public.shopify_privacy_requests r
 WHERE r.completed_at IS NULL AND r.due_at<now()+make_interval(days=>GREATEST(within_days,0))
$$;
REVOKE ALL ON FUNCTION shopify_privacy_requests_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_privacy_requests_due(integer) TO luma_commerce_sync;

-- Classifies every tenant table that exists now. Later migrations classify their own tables.
INSERT INTO data_retention_classes(table_name,class)
 SELECT t,'keep_with_organization' FROM unnest(ARRAY[
  'memberships','invitations','workspace_invitations','workspace_roles','workspace_role_permissions',
  'workspace_people','workspace_settings','workspace_commands','workspace_access_events','workspace_mail',
  'notification_preferences','workspace_support_access','workspace_support_access_requests',
  'support_view_sessions','identity_support_commands','identity_support_membership_commands',
  'staff_audit','staff_support_grants','workspace_inspection_requests','shopify_privacy_requests',
  'data_purge_sessions','workspace_closure_mail']) t
 WHERE to_regclass('public.'||t) IS NOT NULL;
INSERT INTO data_retention_classes(table_name,class) VALUES('audit_entries','legal_retention');
INSERT INTO data_retention_classes(table_name,class)
 SELECT u,'purge_on_closure' FROM data_retention_unclassified() u;
