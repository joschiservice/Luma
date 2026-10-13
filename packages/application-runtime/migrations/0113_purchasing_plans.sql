CREATE TABLE procurement_purchasing_settings (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id), document jsonb NOT NULL
);
CREATE TABLE procurement_purchasing_plans (
 tenant_id uuid NOT NULL, id uuid NOT NULL, supplier_id uuid NOT NULL, document jsonb NOT NULL,
 digest text NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES procurement_suppliers(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text,false))
);
CREATE INDEX procurement_purchasing_plan_recent ON procurement_purchasing_plans(tenant_id,created_at DESC,id);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement_purchasing_settings','procurement_purchasing_plans'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO luma_desk',relation);
 END LOOP;
END $$;
CREATE FUNCTION procurement_purchasing_plan_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.digest<>OLD.digest OR NEW.document->'request' IS DISTINCT FROM OLD.document->'request'
 OR NEW.document->'order' IS DISTINCT FROM OLD.document->'order'
 OR NEW.document->'suggestions' IS DISTINCT FROM OLD.document->'suggestions'
 OR NEW.document->>'requestedBy' IS DISTINCT FROM OLD.document->>'requestedBy'
 OR NEW.document->>'actionId' IS DISTINCT FROM OLD.document->>'actionId' THEN
  RAISE EXCEPTION 'Purchasing plan content is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_purchasing_plan_immutable BEFORE UPDATE ON procurement_purchasing_plans
 FOR EACH ROW EXECUTE FUNCTION procurement_purchasing_plan_immutable();
