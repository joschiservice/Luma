CREATE TABLE case_owners (
 tenant_id uuid NOT NULL, exception_id uuid NOT NULL, user_id uuid,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,exception_id),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES workspace_people(tenant_id,user_id)
);
ALTER TABLE case_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON case_owners TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON case_owners TO luma_desk;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON case_owners FOR EACH ROW EXECUTE FUNCTION notify_metric_change('issues,decisions');

GRANT SELECT ON case_owners TO luma_case_reader;
CREATE POLICY case_reads ON case_owners FOR SELECT TO luma_case_reader
USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT(tenant_id,user_id,name) ON workspace_people TO luma_case_reader;
CREATE POLICY case_reads ON workspace_people FOR SELECT TO luma_case_reader
USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
