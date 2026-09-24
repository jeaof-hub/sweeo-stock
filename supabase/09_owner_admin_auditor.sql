-- Rename Manager/Sales and grant Owner all Founder privileges except managing Founder.
begin;

alter table public.staff drop constraint if exists staff_role_check;
update public.staff set role = 'admin' where role = 'manager';
update public.staff set role = 'auditor' where role = 'sales';
alter table public.staff add constraint staff_role_check
  check (role in ('founder', 'owner', 'admin', 'warehouse', 'auditor'));

create or replace function public.is_reader()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role(array['founder','owner','admin','warehouse','auditor']); $$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role(array['founder','owner','admin','warehouse']); $$;

create or replace function public.staff_display_names()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.user_id, s.name from public.staff s
  where public.has_role(array['founder','owner']);
$$;

drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated
using (user_id = auth.uid() or public.has_role(array['founder','owner']));

drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
create policy items_insert on public.items for insert to authenticated
with check (public.has_role(array['founder','owner','admin']));
create policy items_update on public.items for update to authenticated
using (public.has_role(array['founder','owner','admin']))
with check (public.has_role(array['founder','owner','admin']));

create or replace function public.can_delete_movement(recorded_by uuid, recorded_at timestamptz)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.has_role(array['founder','owner','admin']) or (
    public.has_role(array['warehouse']) and recorded_by = auth.uid()
    and (recorded_at at time zone 'Asia/Bangkok')::date
      = (now() at time zone 'Asia/Bangkok')::date
  );
$$;

drop policy if exists mv_read on public.movements;
drop policy if exists mv_insert on public.movements;
create policy mv_read on public.movements for select to authenticated
using (public.is_reader() and (deleted_at is null or public.has_role(array['founder','owner','admin'])));
create policy mv_insert on public.movements for insert to authenticated
with check (
  public.has_role(array['founder','owner','admin','warehouse'])
  and created_by = auth.uid() and date is not null and deleted_at is null
  and source in ('app','adjustment')
  and (source <> 'adjustment' or public.has_role(array['founder','owner','admin']))
);

drop policy if exists stock_audit_founder_read on public.stock_audit;
drop policy if exists stock_audit_privileged_read on public.stock_audit;
create policy stock_audit_privileged_read on public.stock_audit for select to authenticated
using (public.has_role(array['founder','owner']));

commit;
