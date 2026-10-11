DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='luma_sales') THEN
  CREATE ROLE luma_sales NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_sales;
-- Atomic publication invokes the existing owners with the same restricted transaction.
GRANT luma_orders,luma_inventory,luma_connectors,luma_audit TO luma_sales;
CREATE TABLE sales_orders (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, connection_id uuid NOT NULL,
 number text NOT NULL CHECK(length(number) BETWEEN 1 AND 200),
 status text NOT NULL CHECK(status IN ('open','completed','cancelled')),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 version integer NOT NULL CHECK(version>0),
 customer_id uuid,
 billing_address jsonb, shipping_address jsonb,
 channel text NOT NULL CHECK(length(channel) BETWEEN 1 AND 100), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id), UNIQUE(tenant_id,number),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'orderId'=order_id::text
  AND document->>'connectionId'=connection_id::text AND document->>'number'=number
  AND document->>'currency'=currency AND document->>'channel'=channel
  AND document->>'status'=status AND (document->>'version')::integer=version,false))
);
CREATE TABLE sales_order_lines (
 tenant_id uuid NOT NULL, sales_order_id uuid NOT NULL, id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 sku_id uuid, quantity numeric(20,6) NOT NULL CHECK(quantity>0),
 current_quantity numeric(20,6) NOT NULL CHECK(current_quantity>=0 AND current_quantity<=quantity),
 unit_price numeric(20,6) CHECK(unit_price>=0), tax_rate numeric(7,6) CHECK(tax_rate>=0 AND tax_rate<=1),
 document jsonb NOT NULL, PRIMARY KEY(tenant_id,sales_order_id,id), UNIQUE(tenant_id,sales_order_id,position),
 FOREIGN KEY(tenant_id,sales_order_id) REFERENCES sales_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES orders_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id)
);
CREATE TABLE sales_commands (
 tenant_id uuid NOT NULL, command_id uuid NOT NULL, actor_id text NOT NULL, order_id uuid NOT NULL,
 input jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(tenant_id,command_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES sales_orders(tenant_id,order_id)
);
GRANT SELECT,INSERT,UPDATE ON sales_orders,sales_order_lines TO luma_sales;
GRANT SELECT,INSERT ON sales_commands TO luma_sales;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['sales_orders','sales_order_lines','sales_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_sales USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

-- Internal sources have no external credential; ordinary active installations still require one.
ALTER TABLE connector_installations DROP CONSTRAINT connector_installations_check1;
ALTER TABLE connector_installations ADD CHECK (
 CASE WHEN document->>'provider'='luma-erp' THEN secret IS NULL AND document->>'status'='active'
 ELSE (document->>'status' IN ('disconnected','revoked')) = (secret IS NULL) END
);
CREATE UNIQUE INDEX connector_internal_orders ON connector_installations(tenant_id)
 WHERE document->>'provider'='luma-erp';

-- Deliberate read adapter for intake; no customer-domain writes or contact fields are granted.
GRANT SELECT ON customer_orders,customer_profiles TO luma_sales;
CREATE POLICY sales_intake ON customer_orders FOR SELECT TO luma_sales
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY sales_intake ON customer_profiles FOR SELECT TO luma_sales
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
