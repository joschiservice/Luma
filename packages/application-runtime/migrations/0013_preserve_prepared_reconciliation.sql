-- Read-only reconciliation must leave an in-flight reservation available for completion.
-- Outcome evidence can advance; reserved intent, provider identity and terminal results cannot change.
CREATE OR REPLACE FUNCTION protect_execution_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT ((OLD.state = 'prepared' AND NEW.state IN ('prepared','unknown','failed','succeeded')) OR (OLD.state = 'unknown' AND NEW.state IN ('unknown','succeeded'))) OR
    (NEW.document - 'state' - 'attempt') IS DISTINCT FROM (OLD.document - 'state' - 'attempt') OR
    ((NEW.document->'attempt') - 'finishedAt' - 'verification' - 'effectEvidenceRefs' - 'dispatch' - 'businessOutcome' - 'providerRequestId') IS DISTINCT FROM
    ((OLD.document->'attempt') - 'finishedAt' - 'verification' - 'effectEvidenceRefs' - 'dispatch' - 'businessOutcome' - 'providerRequestId') OR
    ((OLD.state = 'unknown' OR NEW.state = 'prepared') AND (
      (NEW.document->'attempt'->'dispatch') IS DISTINCT FROM (OLD.document->'attempt'->'dispatch') OR
      (NEW.document->'attempt'->'providerRequestId') IS DISTINCT FROM (OLD.document->'attempt'->'providerRequestId')
    )) OR
    (NEW.state = 'prepared' AND (
      (NEW.document->'attempt'->'effectEvidenceRefs') IS DISTINCT FROM (OLD.document->'attempt'->'effectEvidenceRefs')
    )) THEN
  RAISE EXCEPTION 'Execution intent and finalized attempts are immutable';
 END IF;
 RETURN NEW;
END $$;

