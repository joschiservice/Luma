-- Simulated provider truth for local development and tests. This database is separate from
-- Luma's: Luma only sees it through provider APIs, as observations.

CREATE SEQUENCE sim_record_seq;

CREATE TABLE sim_runs (
  id text PRIMARY KEY,
  seed bigint NOT NULL,
  profile_name text NOT NULL,
  profile jsonb NOT NULL,
  chaos jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed')),
  progress jsonb,
  error text,
  now bigint NOT NULL,
  running boolean NOT NULL,
  speed double precision NOT NULL,
  -- Real time of the last clock update, used to advance a running clock.
  wall_at bigint NOT NULL,
  -- Per-instance service health overrides and timed outages.
  health jsonb NOT NULL DEFAULT '{}',
  -- Engine cursors and counters that are not provider records.
  state jsonb NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

-- Provider records share one shape; each provider owns its table and record kinds.
CREATE TABLE sim_shopify_records (
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  instance text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  parent text,
  key text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('sim_record_seq'),
  data jsonb NOT NULL,
  PRIMARY KEY (run_id, instance, kind, id)
);
CREATE INDEX sim_shopify_records_seq ON sim_shopify_records (run_id, instance, kind, seq);
CREATE INDEX sim_shopify_records_updated ON sim_shopify_records (run_id, instance, kind, updated_at, seq);
CREATE INDEX sim_shopify_records_parent ON sim_shopify_records (run_id, instance, kind, parent, seq) WHERE parent IS NOT NULL;
CREATE INDEX sim_shopify_records_key ON sim_shopify_records (run_id, instance, kind, key, seq) WHERE key IS NOT NULL;

CREATE TABLE sim_jtl_records (LIKE sim_shopify_records INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE sim_jtl_records ADD PRIMARY KEY (run_id, instance, kind, id);
ALTER TABLE sim_jtl_records ADD FOREIGN KEY (run_id) REFERENCES sim_runs(id) ON DELETE CASCADE;
CREATE INDEX sim_jtl_records_seq ON sim_jtl_records (run_id, instance, kind, seq);
CREATE INDEX sim_jtl_records_updated ON sim_jtl_records (run_id, instance, kind, updated_at, seq);
CREATE INDEX sim_jtl_records_parent ON sim_jtl_records (run_id, instance, kind, parent, seq) WHERE parent IS NOT NULL;
CREATE INDEX sim_jtl_records_key ON sim_jtl_records (run_id, instance, kind, key, seq) WHERE key IS NOT NULL;

-- The merchant world's own state: scheduled events, integration links, warehouse queues, sync
-- markers and ground-truth incidents. Luma never reads this table.
CREATE TABLE sim_world_records (LIKE sim_shopify_records INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE sim_world_records ADD PRIMARY KEY (run_id, instance, kind, id);
ALTER TABLE sim_world_records ADD FOREIGN KEY (run_id) REFERENCES sim_runs(id) ON DELETE CASCADE;
CREATE INDEX sim_world_records_seq ON sim_world_records (run_id, instance, kind, seq);
CREATE INDEX sim_world_records_updated ON sim_world_records (run_id, instance, kind, updated_at, seq);
CREATE INDEX sim_world_records_parent ON sim_world_records (run_id, instance, kind, parent, seq) WHERE parent IS NOT NULL;
CREATE INDEX sim_world_records_key ON sim_world_records (run_id, instance, kind, key, seq) WHERE key IS NOT NULL;

CREATE TABLE sim_sequences (
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  instance text NOT NULL,
  name text NOT NULL,
  value bigint NOT NULL,
  PRIMARY KEY (run_id, instance, name)
);

CREATE TABLE sim_journal (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  time bigint NOT NULL,
  kind text NOT NULL,
  instance text,
  resource text,
  detail jsonb NOT NULL
);
CREATE INDEX sim_journal_run ON sim_journal (run_id, id DESC);
CREATE INDEX sim_journal_kind ON sim_journal (run_id, kind, id DESC);

CREATE TABLE sim_faults (
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  id text NOT NULL,
  position bigserial,
  rule jsonb NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE sim_metrics (
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  instance text NOT NULL DEFAULT '',
  bucket bigint NOT NULL,
  value double precision NOT NULL,
  PRIMARY KEY (run_id, name, instance, bucket)
);

CREATE TABLE sim_webhook_targets (
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  instance text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  PRIMARY KEY (run_id, instance)
);

CREATE TABLE sim_webhooks (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  instance text NOT NULL,
  topic text NOT NULL,
  event_id text NOT NULL,
  body jsonb NOT NULL,
  -- Real time; webhooks are real HTTP deliveries.
  due_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'dropped'))
);
CREATE INDEX sim_webhooks_due ON sim_webhooks (due_at) WHERE status = 'pending';

-- Committed provider writes per idempotency key or request digest, for duplicate detection.
CREATE TABLE sim_writes (
  run_id text NOT NULL REFERENCES sim_runs(id) ON DELETE CASCADE,
  instance text NOT NULL,
  operation text NOT NULL,
  key text NOT NULL,
  keyed boolean NOT NULL,
  count integer NOT NULL,
  first_at bigint NOT NULL,
  last_at bigint NOT NULL,
  PRIMARY KEY (run_id, instance, operation, key)
);
