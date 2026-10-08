-- Bind each Google session to the verified subject that authenticated it; existing Google sessions require sign-in again.
ALTER TABLE staff_sessions ADD COLUMN provider_subject text;
CREATE OR REPLACE FUNCTION staff_has_access(permission text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (SELECT FROM public.staff_sessions s JOIN public.staff_users u ON u.id=s.user_id JOIN public.staff_access a ON a.email=lower(u.email)
 WHERE s.id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND s.user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours' AND s.updated_at>clock_timestamp()-interval '30 minutes' AND a.active AND ((a.provider_subject IS NULL AND s.provider_subject IS NULL) OR (a.provider_subject IS NOT NULL AND s.provider_subject=a.provider_subject)) AND permission=ANY(a.permissions))
$$;
