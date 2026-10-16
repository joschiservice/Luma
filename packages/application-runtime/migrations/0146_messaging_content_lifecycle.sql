-- Body-derived copies share their source's removal transaction. No content purge permits
-- replay of a send whose result is uncertain.
CREATE FUNCTION messaging_clear_thread_content() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.purged_at IS NOT NULL THEN
  UPDATE public.messaging_threads SET document=jsonb_set(document,'{snippet}','""'::jsonb),
   revision=revision+1,updated_at=now() WHERE tenant_id=NEW.tenant_id AND id=NEW.thread_id;
  UPDATE public.messaging_outbound SET
   document=(document-'attachments'-'citations') || jsonb_build_object('text','','contentPurgedAt',NEW.purged_at,
    'stateReason','Message content was removed. Draft a new reply before sending.'),
   state=CASE WHEN state IN ('draft','approval_required','approved') THEN 'withheld' ELSE state END,
   revision=revision+1,updated_at=now()
   WHERE tenant_id=NEW.tenant_id AND thread_id=NEW.thread_id AND NOT document ? 'contentPurgedAt';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION messaging_clear_thread_content() FROM PUBLIC;
CREATE TRIGGER messaging_remove_content_copies AFTER UPDATE OF purged_at ON messaging_messages
 FOR EACH ROW EXECUTE FUNCTION messaging_clear_thread_content();

-- Assign a content deadline to every existing draft, including ordinary replies. Existing
-- supplier deadlines remain authoritative; otherwise use the source deadline or the default retention window.
UPDATE messaging_outbound o SET document=o.document || jsonb_build_object('contentRetainUntil',
 COALESCE(o.document->>'attachmentsExpireAt',
  (SELECT min(retain_until)::text FROM messaging_messages WHERE tenant_id=o.tenant_id AND thread_id=o.thread_id),
  (o.created_at + interval '365 days')::text))
 FROM messaging_mailboxes m WHERE m.tenant_id=o.tenant_id AND m.connection_id=o.connection_id
 AND NOT o.document ? 'contentRetainUntil';

-- Repair derived copies even when their source was removed before this migration.
UPDATE messaging_messages SET purged_at=purged_at WHERE purged_at IS NOT NULL;

CREATE OR REPLACE FUNCTION purge_expired_messaging(batch integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE purged integer;
BEGIN
 purged := public.purge_expired_messaging_messages(batch);
 WITH due AS (
  SELECT tenant_id,id FROM public.messaging_outbound
  WHERE NOT document ? 'contentPurgedAt'
   AND COALESCE((document->>'contentRetainUntil')::timestamptz,
    (document->>'attachmentsExpireAt')::timestamptz,created_at+interval '365 days')<=now()
  ORDER BY created_at LIMIT LEAST(GREATEST(batch,1),500) FOR UPDATE SKIP LOCKED
 ), removed AS (
  UPDATE public.messaging_outbound o SET
   document=(o.document-'attachments'-'citations') || jsonb_build_object('text','','contentPurgedAt',now(),
    'stateReason','Message content expired. Draft a new reply before sending.'),
   state=CASE WHEN o.state IN ('draft','approval_required','approved') THEN 'withheld' ELSE o.state END,
   revision=revision+1,updated_at=now()
  FROM due d WHERE o.tenant_id=d.tenant_id AND o.id=d.id RETURNING 1
 ) SELECT purged+count(*)::integer INTO purged FROM removed;
 RETURN purged;
END $$;
REVOKE ALL ON FUNCTION purge_expired_messaging(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_messaging(integer) TO luma_desk;

-- Erasure must also visit source rows already removed by retention.
CREATE OR REPLACE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[], order_ids text[] DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased integer := 0; binding record; removed integer; emails text[]; profiles text[]; purged uuid[]; orders text[];
BEGIN
 FOR binding IN SELECT b.tenant_id,b.connection_id FROM public.shopify_installation_bindings b
  WHERE b.app=app_key AND b.shop=shop_domain LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('customers:'||binding.tenant_id||':'||binding.connection_id,0));
  IF customer_ids IS NOT NULL THEN
   INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
    SELECT binding.tenant_id,binding.connection_id,sha256(convert_to(c,'UTF8')) FROM unnest(customer_ids) c
    ON CONFLICT DO NOTHING;
   SELECT COALESCE(array_agg(DISTINCT o.order_external_id),'{}') INTO orders FROM public.customer_orders o
    WHERE o.tenant_id=binding.tenant_id AND o.connection_id=binding.connection_id AND o.customer_external_id=ANY(customer_ids);
   orders := orders||COALESCE(order_ids,'{}');
   INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
    SELECT DISTINCT binding.tenant_id,binding.connection_id,sha256(convert_to(o,'UTF8')) FROM unnest(orders) o
    ON CONFLICT DO NOTHING;
   DELETE FROM public.customer_order_addresses a WHERE a.tenant_id=binding.tenant_id AND a.connection_id=binding.connection_id
    AND a.order_external_id=ANY(orders);
  ELSE
   DELETE FROM public.customer_order_addresses a WHERE a.tenant_id=binding.tenant_id AND a.connection_id=binding.connection_id;
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
   UPDATE public.messaging_outbound o SET
    document=(o.document-'attachments'-'citations') || jsonb_build_object('text','','contentPurgedAt',now(),
     'stateReason','Message content was erased. Draft a new reply before sending.'),
    state=CASE WHEN o.state IN ('draft','approval_required','approved') THEN 'withheld' ELSE o.state END,
    revision=revision+1,updated_at=now()
   WHERE o.tenant_id=binding.tenant_id AND NOT o.document ? 'contentPurgedAt'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.document->'to','[]')||COALESCE(o.document->'cc','[]')) a
     WHERE lower(a->>'address')=ANY(emails));
   WITH erased_messages AS (
    UPDATE public.messaging_messages m SET body=NULL,purged_at=now(),purge_reason='erasure'
    WHERE m.tenant_id=binding.tenant_id AND (m.from_address=ANY(emails)
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
REVOKE ALL ON FUNCTION erase_shopify_customer_data(text,text,text[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_shopify_customer_data(text,text,text[],text[]) TO luma_connectors;
