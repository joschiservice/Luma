-- A verified source operation appends a local order revision. Earlier line snapshots are immutable.
CREATE TABLE procurement_order_changes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,purchase_order_id uuid NOT NULL,state text NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text AND document->>'purchaseOrderId'=purchase_order_id::text,false))
);
CREATE UNIQUE INDEX procurement_order_change_active ON procurement_order_changes(tenant_id,purchase_order_id)
 WHERE state IN ('preparing','approval_required','approved','submitting','uncertain');
CREATE TABLE procurement_order_revisions (
 tenant_id uuid NOT NULL,purchase_order_id uuid NOT NULL,revision integer NOT NULL,document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,purchase_order_id,revision),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 CHECK(revision>0 AND COALESCE((document->'order'->>'revision')::integer=revision,false))
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement_order_changes','procurement_order_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
 END LOOP;
END $$;
GRANT UPDATE(state,document) ON procurement_order_changes TO luma_desk;
CREATE FUNCTION procurement_order_change_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.document-ARRAY['state','decisionId','decidedBy','verifiedAt','observationRefs','failure']
  IS DISTINCT FROM OLD.document-ARRAY['state','decisionId','decidedBy','verifiedAt','observationRefs','failure'] THEN
  RAISE EXCEPTION 'Purchase order change intent is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER procurement_order_change_intent_immutable BEFORE UPDATE ON procurement_order_changes
 FOR EACH ROW EXECUTE FUNCTION procurement_order_change_intent_immutable();
