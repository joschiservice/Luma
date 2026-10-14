-- Transfer lists open newest requested first; records without a source creation time follow.
CREATE INDEX inventory_transfer_records_requested ON inventory_transfer_records(tenant_id,kind,source_created_at DESC NULLS LAST,entity_id DESC,connection_id DESC) WHERE NOT deleted;
