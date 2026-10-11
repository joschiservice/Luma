-- Background mailbox reads never act as a suspended, disabled or erased account, as for the
-- other workers; a manager reading the mailbox again takes it over.
CREATE OR REPLACE FUNCTION messaging_sync_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT m.tenant_id,m.principal_id FROM public.messaging_mailboxes m
 JOIN public.organizations o ON o.id=m.tenant_id AND o.status='active'
 WHERE NOT m.paused AND m.blocked IS NULL AND (m.lease_until IS NULL OR m.lease_until<now())
  AND (m.due_at<=now() OR m.hint_at<=now()
   OR EXISTS (SELECT 1 FROM public.messaging_documents d WHERE d.tenant_id=m.tenant_id AND d.state='pending')
   OR EXISTS (SELECT 1 FROM public.messaging_outbound b WHERE b.tenant_id=m.tenant_id AND b.connection_id=m.connection_id
    AND b.state IN ('sending','uncertain')))
  AND NOT EXISTS (SELECT 1 FROM public.memberships s WHERE s.tenant_id=m.tenant_id AND s.user_id::text=m.principal_id AND s.status='suspended')
  AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=m.principal_id)
  AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=m.principal_id AND x.status='erased')
 LIMIT 1000
$$;

-- Shopify redaction also removes the text of messages to or from the erased customers' email
-- addresses, with their attachment content and thread snippets, and removes customer links.
-- Message metadata stays. Otherwise unchanged from 0061.
CREATE OR REPLACE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[])
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased integer := 0; binding record; removed integer; emails text[]; profiles text[]; purged uuid[];
BEGIN
 FOR binding IN SELECT b.tenant_id,b.connection_id FROM public.shopify_installation_bindings b
  WHERE b.app=app_key AND b.shop=shop_domain LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('customers:'||binding.tenant_id||':'||binding.connection_id,0));
  IF customer_ids IS NOT NULL THEN
   INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
    SELECT binding.tenant_id,binding.connection_id,sha256(convert_to(c,'UTF8')) FROM unnest(customer_ids) c
    ON CONFLICT DO NOTHING;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT lower(p.email)) FILTER (WHERE p.email IS NOT NULL),'{}'),COALESCE(array_agg(p.id::text),'{}')
   INTO emails,profiles FROM public.customer_profiles p
   WHERE p.tenant_id=binding.tenant_id AND p.connection_id=binding.connection_id
   AND (customer_ids IS NULL OR p.external_id=ANY(customer_ids));
  DELETE FROM public.customer_orders o WHERE o.tenant_id=binding.tenant_id AND o.connection_id=binding.connection_id
   AND (customer_ids IS NULL OR o.customer_external_id=ANY(customer_ids));
  DELETE FROM public.customer_profiles p WHERE p.tenant_id=binding.tenant_id AND p.connection_id=binding.connection_id
   AND (customer_ids IS NULL OR p.external_id=ANY(customer_ids));
  GET DIAGNOSTICS removed = ROW_COUNT;
  erased := erased + removed;
  DELETE FROM public.commerce_sync_items i WHERE i.tenant_id=binding.tenant_id AND i.connection_id=binding.connection_id
   AND i.record_type='customers' AND (customer_ids IS NULL OR i.external_id=ANY(customer_ids));
  IF cardinality(emails)>0 THEN
   WITH erased_messages AS (
    UPDATE public.messaging_messages m SET body=NULL,purged_at=now(),purge_reason='erasure'
    WHERE m.tenant_id=binding.tenant_id AND m.purged_at IS NULL AND (m.from_address=ANY(emails)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(m.document->'to','[]')||COALESCE(m.document->'cc','[]')) a
      WHERE lower(a->>'address')=ANY(emails)))
    RETURNING m.id,m.thread_id
   ), documents AS (
    UPDATE public.messaging_documents d SET content=NULL,representation=NULL,purged_at=now(),updated_at=now()
    FROM erased_messages e WHERE d.tenant_id=binding.tenant_id AND d.message_id=e.id AND d.purged_at IS NULL
    RETURNING d.id
   ) SELECT COALESCE(array_agg(DISTINCT thread_id),'{}') INTO purged FROM erased_messages;
   UPDATE public.messaging_threads t SET document=jsonb_set(t.document,'{snippet}','""'::jsonb),updated_at=now()
   WHERE t.tenant_id=binding.tenant_id AND t.id=ANY(purged);
  END IF;
  UPDATE public.messaging_links l SET state='removed',removed_by='erasure',removed_at=now()
  WHERE l.tenant_id=binding.tenant_id AND l.record_kind='customer' AND l.record_id=ANY(profiles) AND l.state<>'removed';
 END LOOP;
 RETURN erased;
END $$;
