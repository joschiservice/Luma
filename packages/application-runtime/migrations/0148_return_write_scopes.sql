-- Requesters with return writes that still need a background step: an approval to apply or
-- expire, an approved write to send, or a sent or uncertain write to check by reading. Returns
-- routing identities only; the pass reauthorizes each requester in tenant scope.
CREATE FUNCTION orders_return_write_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH live AS (
  SELECT c.tenant_id,c.principal_id FROM public.orders_return_creations c
  WHERE c.state IN ('approval_required','approved','sending','uncertain')
  UNION
  SELECT a.tenant_id,a.document->>'requestedBy' FROM public.orders_return_actions a
  WHERE a.state IN ('approval_required','approved','sending','uncertain','pending')
  UNION
  SELECT s.tenant_id,s.document->>'requestedBy' FROM public.orders_return_exchange_steps s
  WHERE s.state IN ('approval_required','approved','sending','uncertain')
 )
 SELECT l.tenant_id,l.principal_id FROM live l
 JOIN public.organizations o ON o.id=l.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=l.tenant_id AND m.user_id::text=l.principal_id AND m.status='suspended')
  AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=l.principal_id)
  AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=l.principal_id AND x.status='erased')
 LIMIT 1000
$$;
REVOKE ALL ON FUNCTION orders_return_write_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders_return_write_scopes() TO luma_desk;

-- Discovery and the pass read only live writes; partial indexes keep both off ended history.
CREATE INDEX orders_return_creations_live_state ON orders_return_creations(tenant_id,principal_id)
 WHERE state IN ('approval_required','approved','sending','uncertain');
CREATE INDEX orders_return_actions_live_state ON orders_return_actions(tenant_id)
 WHERE state IN ('approval_required','approved','sending','uncertain','pending');
CREATE INDEX orders_return_exchange_steps_live_state ON orders_return_exchange_steps(tenant_id)
 WHERE state IN ('approval_required','approved','sending','uncertain');
