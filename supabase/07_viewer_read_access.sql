-- Give active Viewer accounts read-only access to internal stock and movement history.
-- Visitor access and Founder/Editor write permissions remain as before.
begin;

create or replace function public.is_reader()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.is_active
      and s.role in ('founder', 'editor', 'viewer')
  );
$$;

revoke all on function public.is_reader() from public;
grant execute on function public.is_reader() to authenticated;

-- Viewer can resolve recorder names without reading staff emails or roles.
create or replace function public.staff_display_names()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.user_id, s.name from public.staff s where public.is_reader();
$$;

revoke all on function public.staff_display_names() from public;
grant execute on function public.staff_display_names() to authenticated;

drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated
using (public.is_reader());

drop policy if exists mv_read on public.movements;
create policy mv_read on public.movements for select to authenticated
using (public.is_reader());

commit;
