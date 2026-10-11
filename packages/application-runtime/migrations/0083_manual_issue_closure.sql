-- Manual disposition may have no evidence references; verification must retain proof.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='exceptions'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%resolution%';
 EXECUTE format('ALTER TABLE exceptions DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_resolution CHECK (
 state <> 'resolved' OR COALESCE(
  document->'resolution'->>'actorId' IS NOT NULL AND
  document->'resolution'->>'auditId' IS NOT NULL AND
  jsonb_typeof(document->'resolution'->'evidenceRefs')='array' AND
  ((document->'resolution'->>'kind'='human_disposition' AND
    length(btrim(document->'resolution'->>'reason')) BETWEEN 1 AND 1000) OR
   (document->'resolution'->>'kind'='verification' AND
    jsonb_array_length(document->'resolution'->'evidenceRefs') > 0 AND
    document->'resolution'->>'outcome'='passed' AND
    (document->'resolution'->>'complete')::boolean AND
    (document->'resolution'->>'authoritative')::boolean)),false)
);
