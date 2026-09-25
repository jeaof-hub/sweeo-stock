-- Phase 1: production role permissions and user visibility.
-- Run on production after migrations 08 and 09. Safe to run repeatedly.
-- Phase 2 will replace the temporary direct-dispatch permissions below.
begin;

-- Keep the production role set, including the currently unused auditor role.
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role in ('founder', 'owner', 'admin', 'warehouse', 'auditor'));

create or replace function public.is_founder_or_owner()
returns boolean
language sql stable security definer set search_path = public
as $$ select public.has_role(array['founder','owner']); $$;
revoke all on function public.is_founder_or_owner() from public;
grant execute on function public.is_founder_or_owner() to authenticated;

-- Every active member may resolve recorder names. This RPC deliberately returns
-- no email, role, active flag, or other account metadata.
create or replace function public.staff_display_names()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.user_id, s.name
  from public.staff s
  where public.is_reader();
$$;
revoke all on function public.staff_display_names() from public;
grant execute on function public.staff_display_names() to authenticated;

-- Direct staff-table visibility:
-- * Founder sees all rows.
-- * Owner sees every row except Founder.
-- * Auditor keeps its existing ability to read only its own row.
-- * Admin and Warehouse use staff_display_names() and see no staff rows.
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated
using (
  public.has_role(array['founder'])
  or (public.has_role(array['owner']) and role <> 'founder')
  or (public.has_role(array['auditor']) and user_id = auth.uid())
);

-- manage-users (service_role) is the only web path that may write staff.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'staff' and cmd <> 'SELECT'
  loop
    execute format('drop policy if exists %I on public.staff', p.policyname);
  end loop;
end $$;
revoke insert, update, delete, truncate on public.staff from public, anon, authenticated;
grant select on public.staff to authenticated;
grant select, insert, update on public.staff to service_role;

-- Transitional movement rules until Phase 2:
-- * Warehouse may create normal dispatches only.
-- * Admin, Owner, and Founder may receive, dispatch, and adjust stock.
-- * Existing same-day Warehouse soft-delete permission remains unchanged.
drop policy if exists mv_insert on public.movements;
create policy mv_insert on public.movements for insert to authenticated
with check (
  created_by = auth.uid()
  and date is not null
  and deleted_at is null
  and (
    (
      public.has_role(array['founder','owner','admin'])
      and source in ('app','adjustment')
    )
    or (
      public.has_role(array['warehouse'])
      and kind = 'out'
      and source = 'app'
    )
  )
);

commit;
