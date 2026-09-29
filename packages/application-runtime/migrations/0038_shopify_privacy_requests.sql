-- Compliance delivery is app-wide and must survive workspace removal and uninstall.
CREATE TABLE shopify_privacy_requests (
 tenant_id uuid NOT NULL CHECK (tenant_id='00000000-0000-4000-8000-000000000000'),
 app text NOT NULL,
 event_key text NOT NULL,
 topic text NOT NULL CHECK (topic IN ('customers/data_request','customers/redact','shop/redact')),
 payload text,
 received_at timestamptz NOT NULL DEFAULT now(),
 due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
 completed_at timestamptz,
 evidence text,
 PRIMARY KEY(app,event_key),
 CHECK ((completed_at IS NULL AND payload IS NOT NULL AND evidence IS NULL)
     OR (completed_at IS NOT NULL AND payload IS NULL AND evidence IS NOT NULL AND length(evidence)>0))
);
CREATE INDEX shopify_privacy_pending ON shopify_privacy_requests(due_at) WHERE completed_at IS NULL;
ALTER TABLE shopify_privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_privacy_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY intake ON shopify_privacy_requests FOR INSERT TO luma_connectors
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT INSERT ON shopify_privacy_requests TO luma_connectors;
