-- Delivery and billing addresses each source order reports. Observations and order snapshots are
-- immutable and never carry addresses, so they live here and are erased with customer data.
-- `shared` is false when the deployment may not read addresses; both addresses are then null.
CREATE TABLE customer_order_addresses (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 order_scope_key text NOT NULL CHECK(length(order_scope_key) <= 1024),
 order_external_id text NOT NULL CHECK(length(order_external_id) BETWEEN 1 AND 1024),
 shared boolean NOT NULL,
 shipping jsonb CHECK(shipping IS NULL OR jsonb_typeof(shipping)='object'),
 billing jsonb CHECK(billing IS NULL OR jsonb_typeof(billing)='object'),
 observed_at timestamptz NOT NULL,
 CHECK(shared OR (shipping IS NULL AND billing IS NULL)),
 PRIMARY KEY(tenant_id,connection_id,order_scope_key,order_external_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON customer_order_addresses TO luma_customers;
GRANT SELECT ON customer_order_addresses TO luma_case_reader;
ALTER TABLE customer_order_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON customer_order_addresses TO luma_customers
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY order_reader ON customer_order_addresses FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Shopify redaction also removes order addresses: every address of the shop for a shop
-- redaction, and for a customer redaction the addresses of the customer's linked orders and of
-- the orders the request lists. Those orders are remembered as erased so a later read cannot
-- store their addresses again. Otherwise unchanged from 0078.
DROP FUNCTION erase_shopify_customer_data(text,text,text[]);
CREATE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[], order_ids text[] DEFAULT NULL)
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
REVOKE ALL ON FUNCTION erase_shopify_customer_data(text,text,text[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_shopify_customer_data(text,text,text[],text[]) TO luma_connectors;
