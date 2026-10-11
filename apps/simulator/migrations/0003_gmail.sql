-- Records of simulated Gmail mailboxes: messages, threads, attachments, labels and watches.
CREATE TABLE sim_gmail_records (LIKE sim_shopify_records INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE sim_gmail_records ADD PRIMARY KEY (run_id, instance, kind, id);
ALTER TABLE sim_gmail_records ADD FOREIGN KEY (run_id) REFERENCES sim_runs(id) ON DELETE CASCADE;
CREATE INDEX sim_gmail_records_seq ON sim_gmail_records (run_id, instance, kind, seq);
CREATE INDEX sim_gmail_records_updated ON sim_gmail_records (run_id, instance, kind, updated_at, seq);
CREATE INDEX sim_gmail_records_parent ON sim_gmail_records (run_id, instance, kind, parent, seq) WHERE parent IS NOT NULL;
CREATE INDEX sim_gmail_records_key ON sim_gmail_records (run_id, instance, kind, key, seq) WHERE key IS NOT NULL;
CREATE INDEX sim_gmail_records_created ON sim_gmail_records (run_id, instance, kind, created_at, seq);
