-- Observe-only receipts change the same workflow and decision views as executed actions, and
-- every metric_change trigger names its topics and covers all writes.
DROP TRIGGER metric_change ON execution_observe_only;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON execution_observe_only
 FOR EACH ROW EXECUTE FUNCTION notify_metric_change('workflows,decisions');
