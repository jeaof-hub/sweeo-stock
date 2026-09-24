-- Fix grants for the Founder-only manage-users Edge Function on an existing project.
-- Browser users may read staff rows allowed by RLS; only service_role may write them.
begin;

revoke all on public.staff from public, anon, authenticated;
grant select on public.staff to authenticated;
grant select, insert, update on public.staff to service_role;

commit;
