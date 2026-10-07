-- An owner's or admin's decision to let one built-in workflow act on new cases as them. It grants
-- no approval: every change still passes policy, approval by a different person and admission.
CREATE TABLE workflow_case_activations (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 definition_id text NOT NULL,
 principal_id text NOT NULL,
 document jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true,
 revoked_at timestamptz,
 revoked_by text,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'definitionId'=definition_id AND document->>'principalId'=principal_id)
);
CREATE UNIQUE INDEX workflow_case_activations_active ON workflow_case_activations(tenant_id,definition_id) WHERE active;
ALTER TABLE workflow_case_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_case_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_case_activations TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_case_activations TO luma_desk;
GRANT UPDATE(active,revoked_at,revoked_by) ON workflow_case_activations TO luma_desk;

-- Discovery reveals routing identities only. Revoked activations stay listed so their unfinished
-- runs can still reconcile. Every read and start reauthorizes in tenant scope.
CREATE FUNCTION case_workflow_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT tenant_id,principal_id FROM public.workflow_case_activations
$$;
REVOKE ALL ON FUNCTION case_workflow_worker_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION case_workflow_worker_scopes() TO luma_desk;
