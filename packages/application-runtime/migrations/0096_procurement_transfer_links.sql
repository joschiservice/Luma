-- Procurement maintains exact provider references in its own write transaction. Plain
-- columns let receiving details resolve a link under RLS without scanning order JSON.
CREATE TABLE procurement_transfer_links (
 tenant_id uuid NOT NULL, purchase_order_id uuid NOT NULL,
 connection_id uuid NOT NULL, resource text NOT NULL CHECK(resource IN ('inventory_transfer','inventory_shipment')),
 external_id text NOT NULL,
 PRIMARY KEY(tenant_id,purchase_order_id,connection_id,resource,external_id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX procurement_transfer_links_source ON procurement_transfer_links(tenant_id,connection_id,resource,external_id,purchase_order_id);
GRANT SELECT,INSERT,DELETE ON procurement_transfer_links TO luma_desk;
GRANT SELECT ON procurement_transfer_links TO luma_case_reader;
ALTER TABLE procurement_transfer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_transfer_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON procurement_transfer_links TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY workspace_read ON procurement_transfer_links FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION refresh_procurement_transfer_links() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 DELETE FROM public.procurement_transfer_links WHERE tenant_id=NEW.tenant_id AND purchase_order_id=NEW.id;
 INSERT INTO public.procurement_transfer_links(tenant_id,purchase_order_id,connection_id,resource,external_id)
 SELECT DISTINCT NEW.tenant_id,NEW.id,CASE WHEN ref->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (ref->>'connectionId')::uuid END,
  CASE ref->>'system' WHEN 'shopify_inventory_transfer' THEN 'inventory_transfer' ELSE 'inventory_shipment' END,ref->>'externalId'
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.document->'externalReferences')='array' THEN NEW.document->'externalReferences' ELSE '[]'::jsonb END) ref
 WHERE ref->>'system' IN ('shopify_inventory_transfer','shopify_inventory_shipment')
  AND ref->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND ref->>'externalId' IS NOT NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION refresh_procurement_transfer_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_procurement_transfer_links() TO luma_desk;
CREATE TRIGGER procurement_transfer_links AFTER INSERT OR UPDATE OF document ON procurement_purchase_orders
 FOR EACH ROW EXECUTE FUNCTION refresh_procurement_transfer_links();

INSERT INTO procurement_transfer_links(tenant_id,purchase_order_id,connection_id,resource,external_id)
 SELECT DISTINCT p.tenant_id,p.id,CASE WHEN ref->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (ref->>'connectionId')::uuid END,
  CASE ref->>'system' WHEN 'shopify_inventory_transfer' THEN 'inventory_transfer' ELSE 'inventory_shipment' END,ref->>'externalId'
 FROM procurement_purchase_orders p
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.document->'externalReferences')='array' THEN p.document->'externalReferences' ELSE '[]'::jsonb END) ref
 WHERE ref->>'system' IN ('shopify_inventory_transfer','shopify_inventory_shipment')
  AND ref->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND ref->>'externalId' IS NOT NULL;
