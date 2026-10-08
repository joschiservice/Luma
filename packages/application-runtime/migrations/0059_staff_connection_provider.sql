-- Preserve the restricted view owner and grants while using the connection owner's provider field.
CREATE OR REPLACE VIEW staff_connection_summary WITH (security_barrier=true) AS
SELECT c.tenant_id,c.id,COALESCE(c.document->>'provider',c.document->>'appId','unknown') AS provider,
 c.document->>'status' AS status,
 (SELECT max(s.last_success_at) FROM commerce_sync_streams s WHERE s.tenant_id=c.tenant_id AND s.connection_id=c.id) AS last_sync_at
FROM connector_installations c;
