DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_case_reader') THEN
  CREATE ROLE luma_case_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_case_reader;
GRANT SELECT ON exceptions,exception_diagnosis_heads,exception_diagnoses,exception_uncertainty,exception_sources TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['exceptions','exception_diagnosis_heads','exception_diagnoses','exception_uncertainty','exception_sources'] LOOP
  EXECUTE format('CREATE POLICY case_reads ON %I FOR SELECT TO luma_case_reader USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
