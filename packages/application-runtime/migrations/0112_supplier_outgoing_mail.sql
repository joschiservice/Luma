-- A new inbox thread keeps its immutable local identity while independent reads learn Gmail's thread.
CREATE UNIQUE INDEX messaging_threads_resolved_provider
 ON messaging_threads(tenant_id,connection_id,(document->>'resolvedProviderThreadId'))
 WHERE document ? 'resolvedProviderThreadId';

-- Two buyers cannot create competing active submissions for the same order.
CREATE UNIQUE INDEX messaging_outbound_purchase_order_submission
 ON messaging_outbound(tenant_id,((document->'procurement')->>'purchaseOrderId'))
 WHERE (document->'procurement')->>'kind'='submission'
 AND state IN ('draft','approval_required','approved','sending','uncertain','sent');

CREATE INDEX messaging_outbound_supplier_checks ON messaging_outbound(tenant_id,state,created_at)
 WHERE document ? 'procurement';

-- Draft copies follow the inbox's retention policy as well as the provider-read document copy.
ALTER FUNCTION purge_expired_messaging(integer) RENAME TO purge_expired_messaging_messages;
REVOKE ALL ON FUNCTION purge_expired_messaging_messages(integer) FROM luma_desk;
CREATE FUNCTION purge_expired_messaging(batch integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE purged integer;
BEGIN
 purged := public.purge_expired_messaging_messages(batch);
 WITH due AS (
   SELECT tenant_id,id FROM public.messaging_outbound
   WHERE document ? 'attachmentsExpireAt' AND (document->>'attachmentsExpireAt')::timestamptz<=now()
    AND jsonb_array_length(COALESCE(document->'attachments','[]'))>0
   ORDER BY created_at LIMIT LEAST(GREATEST(batch,1),500) FOR UPDATE SKIP LOCKED
 ), removed AS (
   UPDATE public.messaging_outbound o SET document=o.document-'attachments',revision=revision+1,updated_at=now()
   FROM due d WHERE o.tenant_id=d.tenant_id AND o.id=d.id RETURNING 1
 ) SELECT purged+count(*)::integer INTO purged FROM removed;
 RETURN purged;
END $$;
REVOKE ALL ON FUNCTION purge_expired_messaging(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_messaging(integer) TO luma_desk;
