-- Only independently verified exchange consistency may close a return case.
ALTER TABLE orders_return_cases DROP CONSTRAINT orders_return_cases_state_check;
ALTER TABLE orders_return_cases ADD CONSTRAINT orders_return_cases_state_check CHECK(state IN('open','completed','cancelled'));
ALTER TABLE orders_return_case_events DROP CONSTRAINT orders_return_case_events_kind_check;
ALTER TABLE orders_return_case_events ADD CONSTRAINT orders_return_case_events_kind_check CHECK(kind IN('opened','assigned','receipt_recorded','inspection_recorded','resolution_proposed','cancelled','creation_requested','creation_approved','creation_rejected','creation_created','exchange_completed','exchange_reopened'));
DROP INDEX orders_return_cases_source;
CREATE UNIQUE INDEX orders_return_cases_source ON orders_return_cases(tenant_id,source_return_id) WHERE source_return_id IS NOT NULL AND state IN('open','completed');
