GRANT SELECT ON exception_evidence,exception_inputs TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['exception_evidence','exception_inputs'] LOOP
  EXECUTE format('CREATE POLICY case_reads ON %I FOR SELECT TO luma_case_reader USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
