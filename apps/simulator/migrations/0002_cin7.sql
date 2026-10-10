-- Records of simulated Cin7 Core accounts, which run the same ERP model as JTL-Wawi.
CREATE TABLE sim_cin7_records (LIKE sim_shopify_records INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE sim_cin7_records ADD PRIMARY KEY (run_id, instance, kind, id);
ALTER TABLE sim_cin7_records ADD FOREIGN KEY (run_id) REFERENCES sim_runs(id) ON DELETE CASCADE;
CREATE INDEX sim_cin7_records_seq ON sim_cin7_records (run_id, instance, kind, seq);
CREATE INDEX sim_cin7_records_updated ON sim_cin7_records (run_id, instance, kind, updated_at, seq);
CREATE INDEX sim_cin7_records_parent ON sim_cin7_records (run_id, instance, kind, parent, seq) WHERE parent IS NOT NULL;
CREATE INDEX sim_cin7_records_key ON sim_cin7_records (run_id, instance, kind, key, seq) WHERE key IS NOT NULL;
