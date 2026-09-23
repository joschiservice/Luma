-- History is a read surface over durable producers; no events are backfilled or invented.
GRANT SELECT ON connector_lifecycle_events TO luma_desk;
CREATE POLICY activity_reads ON connector_lifecycle_events FOR SELECT TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX connector_lifecycle_activity ON connector_lifecycle_events(tenant_id,created_at DESC,connection_id,version);
CREATE INDEX audit_activity ON audit_entries(tenant_id,created_at DESC,id DESC);
CREATE INDEX execution_activity ON execution_outbox(tenant_id,created_at DESC,id DESC);
CREATE INDEX policy_activity ON policy_outbox(tenant_id,created_at DESC,id DESC);
CREATE INDEX exception_activity ON exception_outbox(tenant_id,created_at DESC,id DESC);
CREATE INDEX command_activity ON case_commands(tenant_id,created_at DESC,id DESC);
CREATE INDEX policy_activity_proposal ON policy_outbox(tenant_id,((document->'document'->>'proposalId')));

CREATE VIEW workspace_activity_sources WITH (security_invoker=true) AS
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
 jsonb_build_object('eventType',e.document->'type','occurredAt',COALESCE(e.document->'at',e.document->'resolution'->'at'),
 'actor',jsonb_build_object('kind','user','id',COALESCE(e.document->'actorId',e.document->'resolution'->'actorId')),
 'details',jsonb_build_object('resolution',e.document->'resolution'->'kind'),'evidenceRefs',e.document->'resolution'->'evidenceRefs') FROM exception_outbox e
 UNION ALL
 SELECT c.tenant_id,c.id::text,c.created_at,(c.request->>'proposalId')::uuid,c.exception_id,NULL::uuid,false,
 jsonb_build_object('eventType','case.'||(c.request->>'kind'),'occurredAt',c.document->'createdAt','actor',jsonb_build_object('kind','user','id',c.actor_id),
 'details',jsonb_build_object('outcome',c.request->'kind')) FROM case_commands c
 UNION ALL
 SELECT c.tenant_id,'connection:'||c.connection_id::text||':'||c.version::text,c.created_at,NULL::uuid,NULL::uuid,c.connection_id,true,
 jsonb_build_object('eventType','connection.'||c.event,'occurredAt',c.created_at,'actor',jsonb_build_object('kind','user','id',c.actor_id)) FROM connector_lifecycle_events c;
GRANT SELECT ON workspace_activity_sources TO luma_desk;
