-- Which source customer placed each source order. Observations and order snapshots are immutable
-- and never carry customer references, so the link lives here and is erased with the profile.
CREATE TABLE customer_orders (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL,
 order_scope_key text NOT NULL CHECK(length(order_scope_key) <= 1024),
 order_external_id text NOT NULL CHECK(length(order_external_id) BETWEEN 1 AND 1024),
 customer_external_id text NOT NULL CHECK(length(customer_external_id) BETWEEN 1 AND 1024),
 observed_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,order_scope_key,order_external_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX customer_orders_customer ON customer_orders(tenant_id,connection_id,customer_external_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON customer_orders TO luma_customers;
GRANT SELECT ON customer_orders TO luma_case_reader;
ALTER TABLE customer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON customer_orders TO luma_customers
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY order_reader ON customer_orders FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Shopify redaction also removes the erased customers' order links. It takes the same
-- per-connection lock as customer imports, so a sync page cannot restore what it erased.
CREATE OR REPLACE FUNCTION erase_shopify_customer_data(app_key text, shop_domain text, customer_ids text[])
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE erased integer := 0; binding record; removed integer;
BEGIN
 FOR binding IN SELECT b.tenant_id,b.connection_id FROM public.shopify_installation_bindings b
  WHERE b.app=app_key AND b.shop=shop_domain LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('customers:'||binding.tenant_id||':'||binding.connection_id,0));
  IF customer_ids IS NOT NULL THEN
   INSERT INTO public.customer_erasures(tenant_id,connection_id,external_digest)
    SELECT binding.tenant_id,binding.connection_id,sha256(convert_to(c,'UTF8')) FROM unnest(customer_ids) c
    ON CONFLICT DO NOTHING;
  END IF;
  DELETE FROM public.customer_orders o WHERE o.tenant_id=binding.tenant_id AND o.connection_id=binding.connection_id
   AND (customer_ids IS NULL OR o.customer_external_id=ANY(customer_ids));
  DELETE FROM public.customer_profiles p WHERE p.tenant_id=binding.tenant_id AND p.connection_id=binding.connection_id
   AND (customer_ids IS NULL OR p.external_id=ANY(customer_ids));
  GET DIAGNOSTICS removed = ROW_COUNT;
  erased := erased + removed;
  DELETE FROM public.commerce_sync_items i WHERE i.tenant_id=binding.tenant_id AND i.connection_id=binding.connection_id
   AND i.record_type='customers' AND (customer_ids IS NULL OR i.external_id=ANY(customer_ids));
 END LOOP;
 RETURN erased;
END $$;
