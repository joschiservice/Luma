-- Reviews pin the administrator's exact version, policy and resource selection.
CREATE TABLE playbook_activation_reviews (
 tenant_id uuid NOT NULL, id uuid NOT NULL, definition_id text NOT NULL,
 actor_id text NOT NULL, request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,definition_id) REFERENCES playbook_definitions(tenant_id,id),
 CHECK(COALESCE(request->>'id'=id::text AND (request->>'scopeReviewed')::boolean,false))
);
GRANT SELECT,INSERT ON playbook_activation_reviews TO luma_desk;
ALTER TABLE playbook_activation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbook_activation_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON playbook_activation_reviews TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX playbook_runs_recent ON playbook_runs(tenant_id,definition_id,(document->>'createdAt') DESC);
