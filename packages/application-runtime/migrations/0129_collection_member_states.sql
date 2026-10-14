-- Owner and sharing scope as plain columns, so view limits and per-member listing stay indexed.
ALTER TABLE adaptive_views
 ADD COLUMN owner_id uuid GENERATED ALWAYS AS ((document->>'ownerId')::uuid) STORED,
 ADD COLUMN sharing_scope text GENERATED ALWAYS AS (document->'sharing'->>'scope') STORED;
CREATE INDEX adaptive_views_owner ON adaptive_views(tenant_id,owner_id) WHERE NOT archived;
CREATE INDEX adaptive_views_shared ON adaptive_views(tenant_id,sharing_scope) WHERE NOT archived;

-- What each member last had open on a list page, synced across their devices. Rows go with the
-- account; `sequence` lets the newest save from a client win over a late, older one.
CREATE TABLE adaptive_collection_states (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 domain text NOT NULL CHECK(domain ~ '^[a-z]{1,40}$'),
 document jsonb NOT NULL CHECK(octet_length(document::text) <= 65536),
 sequence bigint NOT NULL CHECK(sequence > 0),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,user_id,domain)
);
ALTER TABLE adaptive_collection_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_collection_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON adaptive_collection_states TO luma_adaptive
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON adaptive_collection_states TO luma_adaptive;
