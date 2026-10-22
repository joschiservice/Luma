-- Concurrent starts of one update run one after another. An advisory lock kept a pooled
-- connection open for the whole start while the start opened further transactions on the same
-- pool, so a few concurrent starts could exhaust it. A start now claims a renewed lease on its
-- row and holds no connection while it runs or waits; a lease left by a crash expires.
ALTER TABLE starshipit_order_updates ADD COLUMN start_token uuid, ADD COLUMN start_lease_until timestamptz;
GRANT UPDATE(start_token,start_lease_until) ON starshipit_order_updates TO luma_connectors;
-- Lease changes are not review changes; they must not refresh live views.
DROP TRIGGER metric_change ON starshipit_order_updates;
CREATE TRIGGER metric_change AFTER INSERT OR DELETE OR UPDATE OF document,decision_id,sent_at,closed,settled ON starshipit_order_updates FOR EACH ROW EXECUTE FUNCTION notify_metric_change('workflows,decisions');
