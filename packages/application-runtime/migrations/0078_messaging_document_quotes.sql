-- Fact quotes are copies of document text. When a document's content is removed, by retention,
-- on request or by customer erasure, its facts keep their values, locators and reviews but lose
-- their quotes, as message text does.
CREATE FUNCTION messaging_remove_fact_quotes() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.messaging_facts SET document=jsonb_set(document,'{quote}','""'::jsonb),updated_at=now()
 WHERE tenant_id=NEW.tenant_id AND document_id=NEW.id AND document->>'quote'<>'';
 RETURN NULL;
END $$;

CREATE TRIGGER remove_fact_quotes AFTER UPDATE OF purged_at ON messaging_documents
 FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
 EXECUTE FUNCTION messaging_remove_fact_quotes();
