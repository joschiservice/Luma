-- Names of each workspace's current and former members, so tenant-scoped reads can attribute
-- recorded actions without access to the global users table. Membership and profile triggers
-- keep current members up to date. Removal keeps the name last recorded and drops the email.
CREATE TABLE workspace_people (
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id uuid NOT NULL,
 name text NOT NULL, email text, is_member boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,user_id),
 CHECK(is_member = (email IS NOT NULL))
);

CREATE FUNCTION record_workspace_person() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='users' THEN
  UPDATE public.workspace_people SET name=NEW.name,email=NEW.email WHERE user_id=NEW.id AND is_member;
 ELSIF TG_OP='INSERT' THEN
  INSERT INTO public.workspace_people(tenant_id,user_id,name,email)
   SELECT NEW.tenant_id,u.id,u.name,u.email FROM public.users u WHERE u.id=NEW.user_id
   ON CONFLICT(tenant_id,user_id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,is_member=true;
 ELSE
  UPDATE public.workspace_people SET is_member=false,email=NULL WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION record_workspace_person() FROM PUBLIC;
CREATE TRIGGER workspace_person_membership AFTER INSERT OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION record_workspace_person();
CREATE TRIGGER workspace_person_profile AFTER UPDATE OF name,email ON users FOR EACH ROW EXECUTE FUNCTION record_workspace_person();

-- Former members are known from removal events and from actions they recorded in the workspace.
-- Their current profile name is the best name still available; deleted accounts stay unnamed.
INSERT INTO workspace_people(tenant_id,user_id,name,email)
 SELECT m.tenant_id,u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id;
INSERT INTO workspace_people(tenant_id,user_id,name,is_member)
 SELECT DISTINCT f.tenant_id,u.id,u.name,false
 FROM (
  SELECT tenant_id,before_value->>'userId' AS user_id FROM workspace_access_events WHERE event_type='member.remove'
  UNION SELECT tenant_id,actor_id::text FROM workspace_access_events
  UNION SELECT tenant_id,doc->'actor'->>'id' FROM workspace_activity_sources WHERE doc->'actor'->>'kind'='user'
 ) f
 JOIN users u ON u.id::text=f.user_id
 JOIN organizations o ON o.id=f.tenant_id
 ON CONFLICT(tenant_id,user_id) DO NOTHING;

ALTER TABLE workspace_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_people FORCE ROW LEVEL SECURITY;
GRANT SELECT ON workspace_people TO luma_identity,luma_desk;
CREATE POLICY tenant_scope ON workspace_people FOR SELECT TO luma_identity,luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
