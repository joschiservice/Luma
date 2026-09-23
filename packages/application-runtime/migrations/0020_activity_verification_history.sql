-- Extend the existing read surface with immutable verification attempts and safe failure fields.
CREATE INDEX exception_evidence_activity ON exception_evidence(tenant_id,exception_id,evidence_key);
CREATE INDEX execution_verifications_activity ON execution_verifications(tenant_id,created_at DESC,id,phase);
CREATE INDEX execution_failures_activity ON execution_failures(tenant_id,created_at DESC,id);
CREATE OR REPLACE VIEW workspace_activity_sources WITH (security_invoker=true) AS
 SELECT a.tenant_id,a.id::text AS id,a.created_at AS recorded_at,a.proposal_id,NULL::uuid AS exception_id,NULL::uuid AS connection_id,false AS restricted,a.document AS doc
 FROM audit_entries a
 WHERE NOT EXISTS (SELECT 1 FROM execution_outbox x WHERE x.tenant_id=a.tenant_id AND x.id=a.id)
 AND NOT EXISTS (SELECT 1 FROM policy_outbox p WHERE p.tenant_id=a.tenant_id AND p.id=a.id)
 UNION ALL
 SELECT x.tenant_id,x.id::text,x.created_at,x.proposal_id,NULL::uuid,NULL::uuid,false,x.document FROM execution_outbox x
 UNION ALL
 SELECT p.tenant_id,p.id::text,p.created_at,(p.document->'document'->>'proposalId')::uuid,NULL::uuid,NULL::uuid,false,
 jsonb_build_object('eventType',p.document->'type','occurredAt',COALESCE(p.document->'document'->'evaluatedAt',p.document->'document'->'createdAt'),
 'actor',jsonb_build_object('kind','user','id',COALESCE(p.document->'document'->'actorId',p.document->'document'->'approverId')),
 'details',jsonb_build_object('outcome',p.document->'document'->'outcome')) FROM policy_outbox p
 UNION ALL
 SELECT e.tenant_id,e.id::text,e.created_at,NULL::uuid,e.exception_id,NULL::uuid,false,
 jsonb_build_object('eventType',e.document->'type','occurredAt',COALESCE(e.document->'occurredAt',e.document->'at',e.document->'resolution'->'at'),
 'actor',jsonb_build_object('kind','user','id',COALESCE(e.document->'actorId',e.document->'resolution'->'actorId')),
 'attemptId',e.document->'attemptId',
 'details',jsonb_build_object('resolution',e.document->'resolution'->'kind',
 'verification',COALESCE(e.document->'outcome',e.document->'verification'->'outcome',e.document->'resolution'->'outcome'),
 'phase',e.document->'phase','failureCode',e.document->'failureCode',
 'state',CASE WHEN e.document->>'type'='exception.verification_inconclusive' OR e.document->>'accepted'='false' OR e.document->>'phase'='pending' OR e.document->>'failureCode' IS NOT NULL THEN 'unknown' END),
 'evidenceRefs',COALESCE(e.document->'evidenceRefs',e.document->'verification'->'evidenceRefs',e.document->'resolution'->'evidenceRefs')) FROM exception_outbox e
 UNION ALL
 SELECT c.tenant_id,c.id::text,c.created_at,(c.request->>'proposalId')::uuid,c.exception_id,NULL::uuid,false,
 jsonb_build_object('eventType','case.'||(c.request->>'kind'),'occurredAt',c.document->'createdAt','actor',jsonb_build_object('kind','user','id',c.actor_id),
 'details',jsonb_build_object('outcome',c.request->'kind')) FROM case_commands c
 UNION ALL
 SELECT c.tenant_id,'connection:'||c.connection_id::text||':'||c.version::text,c.created_at,NULL::uuid,NULL::uuid,c.connection_id,true,
 jsonb_build_object('eventType','connection.'||c.event,'occurredAt',c.created_at,'actor',jsonb_build_object('kind','user','id',c.actor_id)) FROM connector_lifecycle_events c
 UNION ALL
 SELECT v.tenant_id,'verification:'||v.id::text||':'||v.phase,v.created_at,v.proposal_id,NULL::uuid,NULL::uuid,false,
 jsonb_build_object('eventType','execution.verification_'||v.phase,'occurredAt',COALESCE(v.document->'finishedAt',v.document->'startedAt'),
 'actor',jsonb_build_object('kind','user','id',v.document->'actorId'),'attemptId',v.id,
 'details',jsonb_build_object('verification',v.document->'result'->'outcome','phase',v.phase,
 'state',CASE WHEN v.phase='pending' OR v.document->'failure' IS NOT NULL THEN 'unknown' END,'failureCode',v.document->'failure'->'code'),
 'evidenceRefs',v.document->'result'->'observationRefs') FROM execution_verifications v
 UNION ALL
 SELECT f.tenant_id,'failure:'||f.id::text,f.created_at,f.proposal_id,NULL::uuid,NULL::uuid,false,
 jsonb_build_object('eventType','execution.'||(f.document->>'phase')||'_failure','occurredAt',f.document->'occurredAt',
 'details',jsonb_build_object('state','unknown','phase',f.document->'phase','failureCode',f.document->'code')) FROM execution_failures f;
GRANT SELECT ON workspace_activity_sources TO luma_desk;
