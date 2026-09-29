-- Order activity reads execution events by proposal, including delivered ones.
-- The existing partial index covers only undelivered rows.
CREATE INDEX execution_outbox_proposal ON execution_outbox(tenant_id,proposal_id,created_at);
