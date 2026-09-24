-- Upgrade the live SWEEO stock project to Founder / Editor / Viewer roles.
-- The existing, sole is_admin=true staff account becomes Founder.
begin;

alter table public.staff add column if not exists email text;
alter table public.staff add column if not exists role text not null default 'editor';

update public.staff s
set email = lower(u.email)
from auth.users u
where s.user_id = u.id and s.email is distinct from lower(u.email);

do $$
begin
  if (select count(*) from public.staff where is_admin) <> 1 then
    raise exception 'Expected exactly one existing administrator for Founder migration';
  end if;
  if exists (select 1 from public.staff where email is null) then
    raise exception 'Every staff account needs an Auth email';
  end if;
  if not exists (select 1 from public.staff where is_admin and is_active) then
    raise exception 'Founder account must be active';
  end if;
end $$;

update public.staff set role = 'founder' where is_admin;
alter table public.staff alter column email set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_role_check' and conrelid = 'public.staff'::regclass) then
    alter table public.staff add constraint staff_role_check check (role in ('founder', 'editor', 'viewer'));
  end if;
end $$;

create unique index if not exists staff_email_unique on public.staff (lower(email));
create unique index if not exists staff_one_founder on public.staff ((true)) where role = 'founder';

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.is_active and s.role in ('founder', 'editor')
  );
$$;

create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public
as $$
  select s.role from public.staff s where s.user_id = auth.uid() and s.is_active;
$$;

drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated
using (public.is_staff() or user_id = auth.uid());

revoke all on function public.my_role() from public;
grant execute on function public.my_role() to authenticated;

commit;
