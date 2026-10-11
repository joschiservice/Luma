-- Operations inbox: connected mailboxes, the rules that decide which messages Luma reads, message
-- threads with their links to records, internal work on threads, documents read from attachments
-- with reviewable facts, and replies sent through Action Admission. Messaging owns every write.

CREATE TABLE messaging_mailboxes (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 -- The member background reads act as; reauthorized on every pass.
 principal_id text NOT NULL,
 document jsonb NOT NULL,
 -- Messages are read up to `cursor->>'coveredUntil'`; set only after a complete scan.
 cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
 paused boolean NOT NULL DEFAULT false,
 blocked text CHECK(blocked IS NULL OR length(blocked) BETWEEN 1 AND 100),
 due_at timestamptz NOT NULL,
 hint_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_synced_at timestamptz,
 last_error text CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 100),
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,connection_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX messaging_mailboxes_due ON messaging_mailboxes(due_at) WHERE NOT paused AND blocked IS NULL;

CREATE TABLE messaging_rules (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('sender_domain','sender_address','recipient_address','label')),
 value text NOT NULL CHECK(length(value) BETWEEN 1 AND 320),
 party jsonb NOT NULL CHECK(party->>'kind' IN ('supplier','customer','other')),
 backfilled_at timestamptz,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL,
 removed_by text,
 removed_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES messaging_mailboxes(tenant_id,connection_id)
);
CREATE UNIQUE INDEX messaging_rules_active ON messaging_rules(tenant_id,connection_id,kind,value) WHERE removed_at IS NULL;

CREATE TABLE messaging_threads (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 provider_thread_id text NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 300),
 subject text NOT NULL,
 document jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('open','waiting','closed')),
 owner_id text,
 -- Set by a person; null uses the automatic deadline in `reply_due_at`.
 manual_due_at timestamptz,
 reply_due_at timestamptz,
 last_message_at timestamptz NOT NULL,
 last_inbound_at timestamptz,
 last_outbound_at timestamptz,
 message_count integer NOT NULL CHECK(message_count>=0),
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,connection_id,provider_thread_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES messaging_mailboxes(tenant_id,connection_id)
);
CREATE INDEX messaging_threads_recent ON messaging_threads(tenant_id,last_message_at DESC,id);
CREATE INDEX messaging_threads_owner ON messaging_threads(tenant_id,owner_id) WHERE status<>'closed';
CREATE INDEX messaging_threads_due ON messaging_threads(tenant_id,reply_due_at) WHERE status<>'closed' AND reply_due_at IS NOT NULL;

CREATE TABLE messaging_messages (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 thread_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 300),
 rfc_message_id text CHECK(rfc_message_id IS NULL OR length(rfc_message_id) BETWEEN 1 AND 998),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 from_address text NOT NULL,
 -- Snapshot without the text: addresses, subject, dates, labels, attachments and a content digest.
 document jsonb NOT NULL,
 body text,
 origin text NOT NULL CHECK(origin IN ('sync','luma')),
 received_at timestamptz NOT NULL,
 retain_until timestamptz NOT NULL,
 purged_at timestamptz,
 purge_reason text CHECK(purge_reason IS NULL OR purge_reason IN ('retention','request','erasure')),
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,connection_id,provider_message_id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES messaging_threads(tenant_id,id),
 CHECK(purged_at IS NULL OR body IS NULL)
);
CREATE INDEX messaging_messages_thread ON messaging_messages(tenant_id,thread_id,received_at);
CREATE INDEX messaging_messages_rfc ON messaging_messages(tenant_id,connection_id,rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX messaging_messages_from ON messaging_messages(tenant_id,from_address);
CREATE INDEX messaging_messages_retention ON messaging_messages(retain_until) WHERE purged_at IS NULL;

CREATE TABLE messaging_links (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 thread_id uuid NOT NULL,
 record_kind text NOT NULL CHECK(record_kind IN ('order','customer','supplier','purchase_order','case')),
 record_id text NOT NULL CHECK(length(record_id) BETWEEN 1 AND 200),
 method text NOT NULL CHECK(method IN ('rule','address','reference','manual')),
 state text NOT NULL CHECK(state IN ('active','suggested','removed')),
 evidence jsonb NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL,
 removed_by text,
 removed_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES messaging_threads(tenant_id,id),
 CHECK((state='removed')=(removed_at IS NOT NULL))
);
-- One current link per record; a removed link stays so automatic linking does not add it again.
CREATE UNIQUE INDEX messaging_links_current ON messaging_links(tenant_id,thread_id,record_kind,record_id) WHERE state<>'removed';
CREATE INDEX messaging_links_record ON messaging_links(tenant_id,record_kind,record_id) WHERE state='active';

CREATE TABLE messaging_notes (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 thread_id uuid NOT NULL,
 author_id text NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES messaging_threads(tenant_id,id)
);
CREATE INDEX messaging_notes_thread ON messaging_notes(tenant_id,thread_id,created_at);

CREATE TABLE messaging_events (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 thread_id uuid NOT NULL,
 type text NOT NULL CHECK(length(type) BETWEEN 1 AND 60),
 actor jsonb NOT NULL,
 details jsonb NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES messaging_threads(tenant_id,id)
);
CREATE INDEX messaging_events_thread ON messaging_events(tenant_id,thread_id,occurred_at);

CREATE TABLE messaging_documents (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 message_id uuid NOT NULL,
 thread_id uuid NOT NULL,
 provider_attachment_id text NOT NULL CHECK(length(provider_attachment_id) BETWEEN 1 AND 1000),
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 500),
 mime_type text NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 200),
 size integer NOT NULL CHECK(size>=0),
 sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
 -- Versions of the same document share a family: normalized filename within a thread.
 family_key text NOT NULL CHECK(length(family_key) BETWEEN 1 AND 700),
 version integer NOT NULL CHECK(version>0),
 previous_id uuid,
 duplicate_of uuid,
 state text NOT NULL CHECK(state IN ('pending','reading','ready','failed','unsupported','unreadable','duplicate')),
 failure text CHECK(failure IS NULL OR length(failure) BETWEEN 1 AND 100),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 content bytea,
 representation jsonb,
 retain_until timestamptz NOT NULL,
 purged_at timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,message_id,provider_attachment_id),
 FOREIGN KEY(tenant_id,message_id) REFERENCES messaging_messages(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES messaging_threads(tenant_id,id),
 FOREIGN KEY(tenant_id,previous_id) REFERENCES messaging_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,duplicate_of) REFERENCES messaging_documents(tenant_id,id),
 CHECK((state='duplicate')=(duplicate_of IS NOT NULL)),
 CHECK(purged_at IS NULL OR (content IS NULL AND representation IS NULL))
);
CREATE INDEX messaging_documents_thread ON messaging_documents(tenant_id,thread_id,created_at);
CREATE INDEX messaging_documents_hash ON messaging_documents(tenant_id,sha256) WHERE sha256 IS NOT NULL AND state<>'duplicate';
CREATE INDEX messaging_documents_family ON messaging_documents(tenant_id,family_key,version DESC);
CREATE INDEX messaging_documents_pending ON messaging_documents(tenant_id,updated_at) WHERE state IN ('pending','reading');
CREATE INDEX messaging_documents_retention ON messaging_documents(retain_until) WHERE purged_at IS NULL;

CREATE TABLE messaging_facts (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 document_id uuid NOT NULL,
 -- Deduplicates repeated reads of the same fact.
 fact_key text NOT NULL CHECK(length(fact_key) BETWEEN 1 AND 400),
 document jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('proposed','needs_correction','confirmed','rejected')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,document_id,fact_key),
 FOREIGN KEY(tenant_id,document_id) REFERENCES messaging_documents(tenant_id,id)
);
CREATE INDEX messaging_facts_review ON messaging_facts(tenant_id,document_id) WHERE status IN ('proposed','needs_correction');

CREATE TABLE messaging_outbound (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 thread_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 document jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','approval_required','approved','rejected','expired','sending','uncertain','sent','failed','withheld','discarded')),
 action_id uuid,
 requested_by text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id) REFERENCES messaging_threads(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES messaging_mailboxes(tenant_id,connection_id)
);
CREATE INDEX messaging_outbound_thread ON messaging_outbound(tenant_id,thread_id,created_at);
CREATE INDEX messaging_outbound_live ON messaging_outbound(tenant_id,state) WHERE state IN ('approval_required','approved','sending','uncertain');

-- Idempotent commands: an exact retry returns the original result.
CREATE TABLE messaging_commands (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 digest text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['messaging_mailboxes','messaging_rules','messaging_threads','messaging_messages',
  'messaging_links','messaging_notes','messaging_events','messaging_documents','messaging_facts',
  'messaging_outbound','messaging_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
 END LOOP;
END $$;
GRANT UPDATE(principal_id,document,cursor,paused,blocked,due_at,hint_at,lease_token,lease_until,attempts,last_synced_at,last_error,revision,updated_at)
 ON messaging_mailboxes TO luma_desk;
GRANT UPDATE(backfilled_at,removed_by,removed_at) ON messaging_rules TO luma_desk;
GRANT UPDATE(subject,document,status,owner_id,manual_due_at,reply_due_at,last_message_at,last_inbound_at,last_outbound_at,message_count,revision,updated_at)
 ON messaging_threads TO luma_desk;
GRANT UPDATE(body,document,purged_at,purge_reason) ON messaging_messages TO luma_desk;
GRANT UPDATE(state,evidence,removed_by,removed_at) ON messaging_links TO luma_desk;
GRANT UPDATE(sha256,family_key,version,previous_id,duplicate_of,state,failure,attempts,content,representation,purged_at,updated_at)
 ON messaging_documents TO luma_desk;
GRANT UPDATE(document,status,updated_at) ON messaging_facts TO luma_desk;
GRANT UPDATE(document,state,action_id,revision,updated_at) ON messaging_outbound TO luma_desk;

-- Live views read again only for their own area; tables that feed Needs you also carry `decisions`.
DO $$ DECLARE entry text[]; BEGIN
 FOREACH entry SLICE 1 IN ARRAY ARRAY[
  ['messaging_mailboxes','messaging'], ['messaging_rules','messaging'],
  ['messaging_threads','messaging,decisions'], ['messaging_messages','messaging'],
  ['messaging_links','messaging'], ['messaging_notes','messaging'], ['messaging_events','messaging'],
  ['messaging_documents','messaging'], ['messaging_facts','messaging,decisions'],
  ['messaging_outbound','messaging,decisions']
 ] LOOP
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change(%L)', entry[1], entry[2]);
 END LOOP;
END $$;

-- Discovery reveals routing identities only: mailboxes due or hinted in active workspaces, and
-- workspaces with documents waiting to be read or replies waiting to be checked.
CREATE FUNCTION messaging_sync_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT m.tenant_id,m.principal_id FROM public.messaging_mailboxes m
 JOIN public.organizations o ON o.id=m.tenant_id AND o.status='active'
 WHERE NOT m.paused AND m.blocked IS NULL AND (m.lease_until IS NULL OR m.lease_until<now())
  AND (m.due_at<=now() OR m.hint_at<=now()
   OR EXISTS (SELECT 1 FROM public.messaging_documents d WHERE d.tenant_id=m.tenant_id AND d.state='pending')
   OR EXISTS (SELECT 1 FROM public.messaging_outbound b WHERE b.tenant_id=m.tenant_id AND b.connection_id=m.connection_id
    AND b.state IN ('sending','uncertain')))
 LIMIT 1000
$$;
REVOKE ALL ON FUNCTION messaging_sync_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_sync_scopes() TO luma_desk;

-- A provider notification that a mailbox changed. Connectors resolve the tenant and connection
-- from their own verified binding first; this only makes the next read happen sooner.
CREATE FUNCTION messaging_request_read(tenant uuid, connection uuid) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE public.messaging_mailboxes SET hint_at=LEAST(COALESCE(hint_at,'infinity'),now()+interval '5 seconds')
 WHERE tenant_id=tenant AND connection_id=connection
$$;
REVOKE ALL ON FUNCTION messaging_request_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_request_read(uuid,uuid) TO luma_connectors;

-- Removes message text and attachment content after their retention period, across tenants.
-- Metadata, digests, links and reviewed facts remain.
CREATE FUNCTION purge_expired_messaging(batch integer) RETURNS integer
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH due_messages AS (
  SELECT tenant_id,id FROM public.messaging_messages
  WHERE purged_at IS NULL AND retain_until<=now() ORDER BY retain_until LIMIT LEAST(GREATEST(batch,1),500)
  FOR UPDATE SKIP LOCKED
 ), messages AS (
  UPDATE public.messaging_messages m SET body=NULL,purged_at=now(),purge_reason='retention'
  FROM due_messages d WHERE m.tenant_id=d.tenant_id AND m.id=d.id RETURNING 1
 ), due_documents AS (
  SELECT tenant_id,id FROM public.messaging_documents
  WHERE purged_at IS NULL AND retain_until<=now() ORDER BY retain_until LIMIT LEAST(GREATEST(batch,1),500)
  FOR UPDATE SKIP LOCKED
 ), documents AS (
  UPDATE public.messaging_documents x SET content=NULL,representation=NULL,purged_at=now(),updated_at=now()
  FROM due_documents d WHERE x.tenant_id=d.tenant_id AND x.id=d.id RETURNING 1
 ) SELECT ((SELECT count(*) FROM messages)+(SELECT count(*) FROM documents))::integer
$$;
REVOKE ALL ON FUNCTION purge_expired_messaging(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_messaging(integer) TO luma_desk;
