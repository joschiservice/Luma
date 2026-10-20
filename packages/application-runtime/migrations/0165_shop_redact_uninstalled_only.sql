-- A Shopify shop/redact arrives after the app is uninstalled, and its topic comes from an unsigned
-- header. Shop-wide erasure (null customer_ids) therefore reaches only bindings whose connection
-- is revoked or disconnected, as erase_shopify_shop_data already requires, so a relabelled or
-- early delivery never erases an active installation's customers. Customer requests still reach
-- every binding of the shop. Otherwise unchanged from 0163.
CREATE OR REPLACE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[],
 order_ids text[] DEFAULT NULL, customer_emails text[] DEFAULT NULL, request_key text DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased integer := 0; binding record; result jsonb; entry uuid; key text;
BEGIN
 FOR binding IN SELECT b.tenant_id,b.connection_id FROM public.shopify_installation_bindings b
  WHERE b.app=app_key AND b.shop=shop_domain
   AND (customer_ids IS NOT NULL OR EXISTS (SELECT 1 FROM public.connector_installations i
    WHERE i.tenant_id=b.tenant_id AND i.id=b.connection_id AND i.secret IS NULL
     AND i.document->>'status' IN ('revoked','disconnected'))) LOOP
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
