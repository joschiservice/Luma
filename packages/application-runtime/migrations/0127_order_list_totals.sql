-- Order totals as maintained scalars, so lists filter, sort and sum them within one currency.
-- A total is stored only with a plain decimal amount and an ISO currency; anything else is missing.
ALTER TABLE orders_list
 ADD COLUMN total_amount numeric,
 ADD COLUMN total_currency text,
 ADD CONSTRAINT orders_list_total_pair CHECK ((total_amount IS NULL) = (total_currency IS NULL));
UPDATE orders_list l SET total_amount=(s.document->'data'->'total'->>'amount')::numeric,
 total_currency=s.document->'data'->'total'->>'currency'
 FROM orders_snapshots s
 WHERE s.tenant_id=l.tenant_id AND s.id=l.snapshot_id
 AND s.document->'data'->'total'->>'amount' ~ '^-?[0-9]{1,30}(\.[0-9]{1,30})?$'
 AND s.document->'data'->'total'->>'currency' ~ '^[A-Z]{3}$';
-- Serves total sorting (missing totals are read by a separate seek) and amount ranges.
CREATE INDEX orders_list_total ON orders_list(tenant_id,total_currency,total_amount,entity_id) WHERE selected;
-- Status and payment sort in the catalog's option order. These expressions must stay
-- identical to the list's sort SQL, or the planner stops using them.
CREATE INDEX orders_list_status_order ON orders_list(tenant_id,COALESCE(array_position('{open,completed,cancelled,unknown}'::text[],status),5),entity_id) WHERE selected;
CREATE INDEX orders_list_payment_order ON orders_list(tenant_id,COALESCE(array_position('{pending,authorized,paid,partially_refunded,refunded,failed,unknown}'::text[],payment_status),8),entity_id) WHERE selected;
CREATE INDEX orders_list_line_count ON orders_list(tenant_id,line_count,entity_id) WHERE selected;
