-- Customer-scoped case searches follow source order relationships, never contact data.
GRANT SELECT(tenant_id,id,connection_id,external_id) ON customer_profiles TO luma_desk;
GRANT SELECT(tenant_id,connection_id,customer_external_id,order_external_id,order_scope_key) ON customer_orders TO luma_desk;
CREATE POLICY return_service_reads ON customer_profiles FOR SELECT TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY return_service_reads ON customer_orders FOR SELECT TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DROP TRIGGER metric_change ON orders_return_cases;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_cases
 FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');

CREATE INDEX orders_return_cases_service ON orders_return_cases(tenant_id,updated_at DESC,id DESC);
CREATE INDEX orders_return_case_events_assignment ON orders_return_case_events(tenant_id,case_id,occurred_at DESC,revision DESC) WHERE kind='assigned';
