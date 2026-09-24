-- SWEEO role matrix and Founder-only stock change audit.
-- Migrates existing Editor -> Warehouse and Viewer -> Sales accounts.
begin;

alter table public.staff drop constraint if exists staff_role_check;
update public.staff set role = 'warehouse' where role = 'editor';
update public.staff set role = 'sales' where role = 'viewer';
alter table public.staff add constraint staff_role_check
  check (role in ('founder', 'manager', 'warehouse', 'sales'));

create or replace function public.has_role(allowed text[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.is_active and s.role = any(allowed)
  );
$$;
revoke all on function public.has_role(text[]) from public;
grant execute on function public.has_role(text[]) to authenticated;

create or replace function public.is_reader()
returns boolean
language sql stable security definer set search_path = public
as $$ select public.has_role(array['founder','manager','warehouse','sales']); $$;
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$ select public.has_role(array['founder','manager','warehouse']); $$;

-- Only Founder can resolve all team names. Other members can read their own staff row.
create or replace function public.staff_display_names()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.user_id, s.name from public.staff s
  where public.has_role(array['founder']);
$$;
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated
using (user_id = auth.uid() or public.has_role(array['founder']));

drop policy if exists items_read on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
create policy items_read on public.items for select to authenticated
using (public.is_reader());
create policy items_insert on public.items for insert to authenticated
with check (public.has_role(array['founder','manager']));
create policy items_update on public.items for update to authenticated
using (public.has_role(array['founder','manager']))
with check (public.has_role(array['founder','manager']));

-- Server timestamps are authoritative for the Warehouse same-day delete rule.
create or replace function public.guard_movement_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  return new;
end $$;
drop trigger if exists movements_insert_guard on public.movements;
create trigger movements_insert_guard before insert on public.movements
for each row execute function public.guard_movement_insert();

create or replace function public.can_delete_movement(recorded_by uuid, recorded_at timestamptz)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.has_role(array['founder','manager']) or (
    public.has_role(array['warehouse']) and recorded_by = auth.uid()
    and (recorded_at at time zone 'Asia/Bangkok')::date
      = (now() at time zone 'Asia/Bangkok')::date
  );
$$;
revoke all on function public.can_delete_movement(uuid,timestamptz) from public;
grant execute on function public.can_delete_movement(uuid,timestamptz) to authenticated;

drop policy if exists mv_read on public.movements;
drop policy if exists mv_insert on public.movements;
drop policy if exists mv_update on public.movements;
create policy mv_read on public.movements for select to authenticated
using (public.is_reader() and (deleted_at is null or public.has_role(array['founder','manager'])));
create policy mv_insert on public.movements for insert to authenticated
with check (
  public.has_role(array['founder','manager','warehouse'])
  and created_by = auth.uid() and date is not null and deleted_at is null
  and source in ('app','adjustment')
  and (source <> 'adjustment' or public.has_role(array['founder','manager']))
);
create policy mv_update on public.movements for update to authenticated
using (deleted_at is null and public.can_delete_movement(created_by, created_at))
with check (deleted_at is not null and public.can_delete_movement(created_by, created_at));

create or replace function public.guard_movement_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if (to_jsonb(new) - 'deleted_at' - 'deleted_by')
     is distinct from (to_jsonb(old) - 'deleted_at' - 'deleted_by') then
    raise exception 'แก้ไขรายการที่บันทึกแล้วไม่ได้ ให้ลบแล้วบันทึกใหม่';
  end if;
  if old.deleted_at is not null or new.deleted_at is null then
    raise exception 'รายการนี้ลบไม่ได้';
  end if;
  new.deleted_at := now();
  new.deleted_by := auth.uid();
  return new;
end $$;

-- Immutable log of every item/movement insert, update, and delete from this point onward.
create table if not exists public.stock_audit (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  entity text not null check (entity in ('items','movements')),
  entity_id text not null,
  action text not null check (action in ('insert','update','delete','soft_delete')),
  before_data jsonb,
  after_data jsonb
);
create index if not exists stock_audit_occurred_idx on public.stock_audit (occurred_at desc);
alter table public.stock_audit enable row level security;
revoke all on public.stock_audit from public, anon, authenticated;
grant select on public.stock_audit to authenticated;
drop policy if exists stock_audit_founder_read on public.stock_audit;
create policy stock_audit_founder_read on public.stock_audit for select to authenticated
using (public.has_role(array['founder']));

create or replace function public.audit_stock_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_data jsonb;
  new_data jsonb;
  changed_id text;
  change_action text;
begin
  if tg_op = 'INSERT' then
    new_data := to_jsonb(new);
    changed_id := new.id::text;
    change_action := 'insert';
  elsif tg_op = 'DELETE' then
    old_data := to_jsonb(old);
    changed_id := old.id::text;
    change_action := 'delete';
  else
    old_data := to_jsonb(old);
    new_data := to_jsonb(new);
    changed_id := new.id::text;
    change_action := case when tg_table_name = 'movements'
      and old.deleted_at is null and new.deleted_at is not null
      then 'soft_delete' else 'update' end;
  end if;
  insert into public.stock_audit (actor_id, entity, entity_id, action, before_data, after_data)
  values (auth.uid(), tg_table_name, changed_id, change_action, old_data, new_data);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.audit_stock_change() from public;
drop trigger if exists items_audit on public.items;
create trigger items_audit after insert or update or delete on public.items
for each row execute function public.audit_stock_change();
drop trigger if exists movements_audit on public.movements;
create trigger movements_audit after insert or update or delete on public.movements
for each row execute function public.audit_stock_change();

commit;
