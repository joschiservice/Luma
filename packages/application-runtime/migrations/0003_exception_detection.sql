DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_exceptions') THEN
  CREATE ROLE luma_exceptions NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_exceptions;

CREATE TABLE exception_configurations (
 tenant_id uuid NOT NULL, version text NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,version)
);
CREATE TABLE exception_sources (
 tenant_id uuid NOT NULL, evidence_key text NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,evidence_key),
 CHECK (COALESCE(document->>'tenantId'=tenant_id::text AND document->>'key'=evidence_key,false))
);
CREATE TABLE exception_inputs (
 tenant_id uuid NOT NULL, evidence_key text NOT NULL, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,evidence_key)
);
CREATE TABLE exceptions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, fingerprint text NOT NULL CHECK(length(fingerprint)=64),
 state text NOT NULL CHECK(state IN ('detected','diagnosed','proposed','awaiting_approval','allowed','executing','verifying','resolved','failed','escalated')),
 document jsonb NOT NULL, previous_exception_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,fingerprint), FOREIGN KEY(tenant_id,previous_exception_id) REFERENCES exceptions(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'state'=state AND document->>'fingerprint'=fingerprint,false)),
 CHECK(COALESCE((document->>'occurrenceCount')::integer>0,false)),
 CHECK(COALESCE(document->>'exceptionClass' IN ('sync_failure','stuck_fulfillment','inventory_mismatch','workflow_failure'),false)),
 CHECK(COALESCE(document->>'severity' IN ('medium','high'),false)),
 CHECK(state <> 'resolved' OR COALESCE(
   document->'resolution'->>'actorId' IS NOT NULL AND
   document->'resolution'->>'auditId' IS NOT NULL AND
   jsonb_array_length(document->'resolution'->'evidenceRefs') > 0 AND
   (document->'resolution'->>'kind'='human_disposition' OR
    (document->'resolution'->>'kind'='verification' AND document->'resolution'->>'outcome'='passed'
     AND (document->'resolution'->>'complete')::boolean AND (document->'resolution'->>'authoritative')::boolean)),false))
);
CREATE UNIQUE INDEX exceptions_active_fingerprint ON exceptions(tenant_id,fingerprint) WHERE state <> 'resolved';
CREATE TABLE exception_evidence (
 tenant_id uuid NOT NULL, exception_id uuid NOT NULL, evidence_key text NOT NULL,
 fingerprint text NOT NULL, PRIMARY KEY(tenant_id,fingerprint,evidence_key),
 FOREIGN KEY(tenant_id,exception_id,fingerprint) REFERENCES exceptions(tenant_id,id,fingerprint),
 FOREIGN KEY(tenant_id,evidence_key) REFERENCES exception_inputs(tenant_id,evidence_key)
);
CREATE TABLE exception_evaluations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, evidence_key text NOT NULL,
 config_version text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,evidence_key) REFERENCES exception_inputs(tenant_id,evidence_key),
 FOREIGN KEY(tenant_id,config_version) REFERENCES exception_configurations(tenant_id,version)
);
CREATE TABLE exception_uncertainty (
 tenant_id uuid NOT NULL, fingerprint text NOT NULL, first_deferred_at timestamptz,
 review_required boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,fingerprint)
);
-- Committed state changes retain append-only audit evidence in the owner's outbox.
CREATE TABLE exception_outbox (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, exception_id uuid,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id)
);
GRANT SELECT,INSERT ON exception_configurations,exception_sources,exception_inputs,exceptions,exception_evidence,exception_evaluations,exception_uncertainty,exception_outbox TO luma_exceptions;
GRANT UPDATE(state,document,version,updated_at) ON exceptions TO luma_exceptions;
GRANT UPDATE(first_deferred_at,review_required) ON exception_uncertainty TO luma_exceptions;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['exception_configurations','exception_sources','exception_inputs','exceptions','exception_evidence','exception_evaluations','exception_uncertainty','exception_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_exceptions USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

CREATE INDEX exceptions_previous_idx ON exceptions(tenant_id,previous_exception_id);
CREATE INDEX exceptions_fingerprint_history_idx ON exceptions(tenant_id,fingerprint,updated_at DESC);
CREATE INDEX exceptions_inbox_idx ON exceptions(tenant_id,state,(document->>'severity'),(document->>'lastDetectedAt'));
CREATE INDEX exception_evidence_incident_idx ON exception_evidence(tenant_id,exception_id);
CREATE INDEX exception_evidence_input_idx ON exception_evidence(tenant_id,evidence_key);
CREATE INDEX exception_evaluations_input_idx ON exception_evaluations(tenant_id,evidence_key);
CREATE INDEX exception_evaluations_config_idx ON exception_evaluations(tenant_id,config_version);
CREATE INDEX exception_outbox_incident_idx ON exception_outbox(tenant_id,exception_id);

CREATE FUNCTION protect_exception_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state='resolved' OR NEW.fingerprint<>OLD.fingerprint OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR
    NEW.document->'subject' IS DISTINCT FROM OLD.document->'subject' OR
    NEW.document->'exceptionClass' IS DISTINCT FROM OLD.document->'exceptionClass' OR
    NEW.document->'firstDetectedAt' IS DISTINCT FROM OLD.document->'firstDetectedAt' OR
    NEW.document->'previousExceptionId' IS DISTINCT FROM OLD.document->'previousExceptionId' THEN
  RAISE EXCEPTION 'Exception identity and resolved incidents are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER exception_identity_immutable BEFORE UPDATE ON exceptions FOR EACH ROW EXECUTE FUNCTION protect_exception_identity();
