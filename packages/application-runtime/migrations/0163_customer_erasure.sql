-- Customer erasure removes the customer's identity from the inbox, not only message text: their
-- addresses and display names are replaced by an empty address on messages, replies, threads,
-- events and link evidence; subjects of their messages and threads are cleared; customer party
-- facts read from their attachments, and party facts naming their address, lose their name and
-- email; and mailbox rules for their address are removed. The same erasure now serves every
-- commerce connection, not only Shopify, and accepts addresses that no stored profile holds, such
-- as the email in a signed Shopify redaction request. Shopify erasures are recorded in Activity
-- with their counts.

-- Replaces each address in a JSON address list that belongs to an erased email. The empty address
-- has no `@`, so replies never select it as a recipient.
CREATE FUNCTION messaging_erase_addresses(list jsonb, emails text[]) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(CASE WHEN lower(btrim(e.a->>'address'))=ANY(emails)
   THEN jsonb_build_object('address','','name',NULL) ELSE e.a END ORDER BY e.n),'[]'::jsonb)
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(list)='array' THEN list ELSE '[]'::jsonb END)
  WITH ORDINALITY e(a,n)
$$;
REVOKE ALL ON FUNCTION messaging_erase_addresses(jsonb,text[]) FROM PUBLIC;

-- Whether a fact value names an erased party: a customer party read from an erased attachment,
-- or any party whose email is erased.
CREATE FUNCTION messaging_erased_party(value jsonb, from_erased boolean, emails text[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(value->>'kind'='party' AND ((from_erased AND value->>'role'='customer')
  OR lower(btrim(value->>'email'))=ANY(emails)),false)
$$;
REVOKE ALL ON FUNCTION messaging_erased_party(jsonb,boolean,text[]) FROM PUBLIC;

-- Erases the inbox data of the listed email addresses and removes links to the listed customer
-- profiles in one tenant. Callers hold the tenant's trust; this function is not granted to runtime
-- roles. Returns the messages, threads, replies and mailbox rules it erased.
CREATE FUNCTION erase_messaging_contacts(tenant uuid, emails text[], profiles text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE messages uuid[] := '{}'; threads uuid[] := '{}'; documents uuid[]; replies integer := 0;
 rules integer := 0; touched integer := 0;
BEGIN
 SELECT COALESCE(array_agg(DISTINCT lower(btrim(e))) FILTER (WHERE btrim(e)<>''),'{}') INTO emails
  FROM unnest(COALESCE(emails,'{}')) e;
 IF cardinality(emails)>0 THEN
  UPDATE public.messaging_outbound o SET
   document=(o.document-'attachments'-'citations') || jsonb_build_object('text','','contentPurgedAt',now(),
    'stateReason','Message content was erased. Draft a new reply before sending.'),
   state=CASE WHEN state IN ('draft','approval_required','approved') THEN 'withheld' ELSE o.state END,
   revision=revision+1,updated_at=now()
  WHERE o.tenant_id=tenant AND NOT o.document ? 'contentPurgedAt'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.document->'to','[]')||COALESCE(o.document->'cc','[]')) a
    WHERE lower(btrim(a->>'address'))=ANY(emails));
  UPDATE public.messaging_outbound o SET
   document=o.document || jsonb_build_object('to',public.messaging_erase_addresses(o.document->'to',emails),
    'cc',public.messaging_erase_addresses(o.document->'cc',emails),'subject',''),
   revision=revision+1,updated_at=now()
  WHERE o.tenant_id=tenant
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.document->'to','[]')||COALESCE(o.document->'cc','[]')) a
    WHERE lower(btrim(a->>'address'))=ANY(emails));
  GET DIAGNOSTICS replies = ROW_COUNT;

  -- Re-erasing already erased messages also repairs their derived copies through the purge trigger.
  WITH erased_messages AS (
   UPDATE public.messaging_messages m SET body=NULL,purged_at=now(),purge_reason='erasure',
    from_address=CASE WHEN m.from_address=ANY(emails) THEN '' ELSE m.from_address END,
    document=m.document || jsonb_build_object(
     'from',public.messaging_erase_addresses(jsonb_build_array(m.document->'from'),emails)->0,
     'to',public.messaging_erase_addresses(m.document->'to',emails),
     'cc',public.messaging_erase_addresses(m.document->'cc',emails),
     'replyTo',public.messaging_erase_addresses(m.document->'replyTo',emails),
     'subject','')
   WHERE m.tenant_id=tenant AND (m.from_address=ANY(emails)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(m.document->'to','[]')||COALESCE(m.document->'cc','[]')
     ||COALESCE(m.document->'replyTo','[]')) a WHERE lower(btrim(a->>'address'))=ANY(emails)))
   RETURNING m.id,m.thread_id
  ) SELECT COALESCE(array_agg(id),'{}'),COALESCE(array_agg(DISTINCT thread_id),'{}') INTO messages,threads
   FROM erased_messages;

  UPDATE public.messaging_documents d SET content=NULL,representation=NULL,purged_at=now(),updated_at=now()
  WHERE d.tenant_id=tenant AND d.message_id=ANY(messages) AND d.purged_at IS NULL;
  SELECT COALESCE(array_agg(d.id),'{}') INTO documents FROM public.messaging_documents d
  WHERE d.tenant_id=tenant AND d.message_id=ANY(messages);

  -- Customer party facts from the erased attachments, and party facts naming an erased address
  -- anywhere, lose their identity; the corrected original keeps no copy either. Suppliers named in
  -- a customer's attachment are the merchant's business data and stay.
  UPDATE public.messaging_facts f SET document=f.document
    || CASE WHEN public.messaging_erased_party(f.document->'value',f.document_id=ANY(documents),emails)
     THEN jsonb_build_object('value',(f.document->'value')||'{"name":"","email":null}'::jsonb) ELSE '{}'::jsonb END
    || CASE WHEN public.messaging_erased_party(f.document->'review'->'original',f.document_id=ANY(documents),emails)
     THEN jsonb_build_object('review',(f.document->'review')||jsonb_build_object('original',
      (f.document->'review'->'original')||'{"name":"","email":null}'::jsonb)) ELSE '{}'::jsonb END,
   updated_at=now()
  WHERE f.tenant_id=tenant
   AND (public.messaging_erased_party(f.document->'value',f.document_id=ANY(documents),emails)
    OR public.messaging_erased_party(f.document->'review'->'original',f.document_id=ANY(documents),emails));

  -- Threads keep one empty participant in place of every erased address, as a later refresh from
  -- the erased messages derives it.
  UPDATE public.messaging_threads t SET subject='',
   document=t.document || jsonb_build_object('snippet','',
    'participants',(SELECT COALESCE(jsonb_agg(p.a ORDER BY p.n),'[]'::jsonb) FROM (
      SELECT DISTINCT ON (lower(e.a->>'address')) e.a,e.n
      FROM jsonb_array_elements(public.messaging_erase_addresses(t.document->'participants',emails)) WITH ORDINALITY e(a,n)
      ORDER BY lower(e.a->>'address'),e.n) p),
    'correspondent',CASE WHEN jsonb_typeof(t.document->'correspondent')='object'
     THEN public.messaging_erase_addresses(jsonb_build_array(t.document->'correspondent'),emails)->0
     ELSE 'null'::jsonb END),
   revision=revision+1,updated_at=now()
  WHERE t.tenant_id=tenant AND (t.id=ANY(threads)
   OR lower(btrim(t.document->'correspondent'->>'address'))=ANY(emails)
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.document->'participants','[]')) a
    WHERE lower(btrim(a->>'address'))=ANY(emails)));
  GET DIAGNOSTICS touched = ROW_COUNT;

  UPDATE public.messaging_events v SET details=v.details-'from'-'to'
  WHERE v.tenant_id=tenant AND v.thread_id=ANY(threads) AND v.type IN ('received','sent')
   AND v.details->>'messageId'=ANY(messages::text[]);

  UPDATE public.messaging_links l SET evidence=jsonb_set(l.evidence,'{text}','null'::jsonb)
  WHERE l.tenant_id=tenant AND lower(btrim(l.evidence->>'text'))=ANY(emails);

  -- A rule for the address is itself the customer's address, and would link their next message
  -- to a record that no longer exists. Removed rules keep no copy of the value.
  UPDATE public.messaging_rules r SET value='erased',removed_by='erasure',removed_at=COALESCE(r.removed_at,now())
  WHERE r.tenant_id=tenant AND r.kind IN ('sender_address','recipient_address')
   AND lower(btrim(r.value))=ANY(emails);
  GET DIAGNOSTICS rules = ROW_COUNT;
 END IF;
 UPDATE public.messaging_links l SET state='removed',removed_by='erasure',removed_at=now()
 WHERE l.tenant_id=tenant AND l.record_kind='customer' AND l.record_id=ANY(COALESCE(profiles,'{}')) AND l.state<>'removed';
 RETURN jsonb_build_object('messages',cardinality(messages),'threads',touched,'replies',replies,'rules',rules);
END $$;
REVOKE ALL ON FUNCTION erase_messaging_contacts(uuid,text[],text[]) FROM PUBLIC;

-- Erases the listed source customers of one connection, or all of them when `customer_ids` is
-- null, with their orders' addresses and their inbox data, and prevents their import again.
-- `extra_emails` adds addresses no stored profile holds. Returns the profiles removed with the
-- inbox counts of `erase_messaging_contacts`. Not granted to runtime roles.
CREATE FUNCTION erase_customer_records(tenant uuid, connection uuid, customer_ids text[], order_ids text[],
 extra_emails text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE removed integer; emails text[]; profiles text[]; orders text[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('customers:'||tenant||':'||connection,0));
 IF customer_ids IS NOT NULL THEN
  INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
   SELECT tenant,connection,sha256(convert_to(c,'UTF8')) FROM unnest(customer_ids) c
   ON CONFLICT DO NOTHING;
  SELECT COALESCE(array_agg(DISTINCT o.order_external_id),'{}') INTO orders FROM public.customer_orders o
   WHERE o.tenant_id=tenant AND o.connection_id=connection AND o.customer_external_id=ANY(customer_ids);
  orders := orders||COALESCE(order_ids,'{}');
  INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
   SELECT DISTINCT tenant,connection,sha256(convert_to(o,'UTF8')) FROM unnest(orders) o
   ON CONFLICT DO NOTHING;
  DELETE FROM public.customer_order_addresses a WHERE a.tenant_id=tenant AND a.connection_id=connection
   AND a.order_external_id=ANY(orders);
 ELSE
  DELETE FROM public.customer_order_addresses a WHERE a.tenant_id=tenant AND a.connection_id=connection;
 END IF;
 SELECT COALESCE(array_agg(DISTINCT lower(p.email)) FILTER (WHERE p.email IS NOT NULL),'{}'),COALESCE(array_agg(p.id::text),'{}')
  INTO emails,profiles FROM public.customer_profiles p
  WHERE p.tenant_id=tenant AND p.connection_id=connection
  AND (customer_ids IS NULL OR p.external_id=ANY(customer_ids));
 DELETE FROM public.customer_orders o WHERE o.tenant_id=tenant AND o.connection_id=connection
  AND (customer_ids IS NULL OR o.customer_external_id=ANY(customer_ids));
 DELETE FROM public.customer_profiles p WHERE p.tenant_id=tenant AND p.connection_id=connection
  AND (customer_ids IS NULL OR p.external_id=ANY(customer_ids));
 GET DIAGNOSTICS removed = ROW_COUNT;
 DELETE FROM public.commerce_sync_items i WHERE i.tenant_id=tenant AND i.connection_id=connection
  AND i.record_type='customers' AND (customer_ids IS NULL OR i.external_id=ANY(customer_ids));
 RETURN jsonb_build_object('profiles',removed)
  || public.erase_messaging_contacts(tenant,emails||COALESCE(extra_emails,'{}'),profiles);
END $$;
REVOKE ALL ON FUNCTION erase_customer_records(uuid,uuid,text[],text[],text[]) FROM PUBLIC;

-- Erases one source customer of a connection in the caller's tenant for a data-subject request.
-- The tenant comes from the transaction, never from the arguments. Returns null when the
-- connection is not the tenant's.
CREATE FUNCTION erase_customer(connection uuid, customer_id text, emails text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid := NULLIF(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF tenant IS NULL OR customer_id IS NULL OR length(customer_id) NOT BETWEEN 1 AND 1024 THEN
  RAISE EXCEPTION 'customer erasure needs a tenant and a source customer' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.connector_installations c WHERE c.tenant_id=tenant AND c.id=connection) THEN
  RETURN NULL;
 END IF;
 RETURN public.erase_customer_records(tenant,connection,ARRAY[customer_id],NULL,emails);
END $$;
REVOKE ALL ON FUNCTION erase_customer(uuid,text,text[]) FROM PUBLIC;
-- The API holds `luma_desk`, which owns the inbox rows this erases; the worker holds `luma_customers`.
GRANT EXECUTE ON FUNCTION erase_customer(uuid,text,text[]) TO luma_customers,luma_desk;

-- Shopify redaction: the signed request's email joins the profile emails, so the inbox is erased
-- even when no profile holds it. Each bound workspace records the erasure in Activity with its
-- counts, keyed by the request digest so a redelivery records it once, and never with the
-- customer's identifiers. Replaces the four-argument form from 0146.
DROP FUNCTION erase_shopify_customer_data(text,text,text[],text[]);
CREATE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[],
 order_ids text[] DEFAULT NULL, customer_emails text[] DEFAULT NULL, request_key text DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased integer := 0; binding record; result jsonb; entry uuid; key text;
BEGIN
 FOR binding IN SELECT b.tenant_id,b.connection_id FROM public.shopify_installation_bindings b
  WHERE b.app=app_key AND b.shop=shop_domain LOOP
  result := public.erase_customer_records(binding.tenant_id,binding.connection_id,customer_ids,
   order_ids,customer_emails);
  erased := erased + (result->>'profiles')::integer;
  IF request_key IS NOT NULL THEN
   entry := gen_random_uuid();
   key := 'customers:shopify-erased:'||binding.connection_id||':'||request_key;
   INSERT INTO public.audit_entries(id,tenant_id,event_key,proposal_id,document)
   VALUES(entry,binding.tenant_id,key,entry,jsonb_build_object(
    'id',entry,'tenantId',binding.tenant_id,'eventKey',key,'eventType','customers.erased','schemaVersion',1,
    'occurredAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor',jsonb_build_object('kind','connector','id','Shopify'),'correlationId',request_key,
    'proposalId',entry,'actionHash',encode(sha256(convert_to(key,'UTF8')),'hex'),
    'connectionId',binding.connection_id,'evidenceRefs','[]'::jsonb,
    'details',jsonb_build_object('source','shopify','scope',CASE WHEN customer_ids IS NULL THEN 'shop' ELSE 'customer' END,
     'profiles',result->>'profiles','messages',result->>'messages','threads',result->>'threads',
     'replies',result->>'replies','rules',result->>'rules')))
   ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;
 RETURN erased;
END $$;
REVOKE ALL ON FUNCTION erase_shopify_customer_data(text,text,text[],text[],text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_shopify_customer_data(text,text,text[],text[],text[],text) TO luma_connectors;
