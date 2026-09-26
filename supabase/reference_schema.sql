-- =====================================================================
-- SWEEO Stock : reference schema for a NEW installation only
-- ห้ามรันไฟล์นี้บนฐานข้อมูล Production ที่มีข้อมูลอยู่แล้ว
-- Production ต้องใช้ migration ตามลำดับ โดยเฟส 1 ใช้ 10_role_permissions.sql
-- ไฟล์นี้รวมฐานตั้งต้นและ migration 08, 09, 10 เพื่อเป็นเอกสารอ้างอิง
-- =====================================================================

-- ---------- ผู้มีสิทธิ์แก้ไข (staff) ----------
create table if not exists public.staff (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text not null default '',
  role        text not null default 'editor' check (role in ('founder', 'editor', 'viewer')),
  is_admin    boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists staff_email_unique on public.staff (lower(email));
create unique index if not exists staff_one_founder on public.staff ((true)) where role = 'founder';

-- ผู้ใช้ที่แก้ไขสต็อกได้: Founder และ Editor ที่ยังใช้งาน
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.staff s where s.user_id = auth.uid() and s.is_active and s.role in ('founder', 'editor'));
$$;

-- ผู้ใช้ที่อ่านข้อมูลภายในได้: Founder, Editor และ Viewer ที่ยังใช้งาน
create or replace function public.is_reader()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.staff s where s.user_id = auth.uid() and s.is_active and s.role in ('founder', 'editor', 'viewer'));
$$;

-- บทบาทของบัญชีปัจจุบันเท่านั้น; NULL เมื่อไม่มีสิทธิ์หรือถูกปิดใช้งาน
create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public
as $$
  select s.role from public.staff s where s.user_id = auth.uid() and s.is_active;
$$;

-- ชื่อผู้บันทึกสำหรับประวัติ โดยไม่เปิดอีเมลและบทบาทของสมาชิกให้ Viewer
create or replace function public.staff_display_names()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.user_id, s.name from public.staff s where public.is_reader();
$$;

-- ---------- สินค้า ----------
create table if not exists public.items (
  id          text primary key default ('n' || replace(gen_random_uuid()::text, '-', '')),
  code        text not null default '',
  model       text not null default '',
  spec        text not null default '',
  type        text not null default 'ไม่ระบุ',
  dept        text not null default 'ไม่ระบุ',
  loc         text not null default '',
  remark      text not null default '',
  opening     numeric not null default 0,          -- ยอดยกมา (ตรวจนับปี 2025)
  avg_month   numeric,                              -- ขายเฉลี่ยต่อเดือน
  rop         numeric,                              -- จุดสั่งผลิต
  sort_order  integer not null default 0,
  active      boolean not null default true,
  source      text not null default 'app',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- ---------- รับเข้า / ส่งออก ----------
create table if not exists public.movements (
  id          uuid primary key default gen_random_uuid(),
  item_id     text references public.items(id) on update cascade,
  code        text not null default '',             -- เก็บรหัส/รุ่น ณ ตอนบันทึก
  model       text not null default '',
  date        date,
  kind        text not null check (kind in ('in','out')),
  qty         numeric not null check (qty > 0),
  customer    text not null default '',
  doc_no      text not null default '',
  dept        text not null default '',
  sale        text not null default '',
  note        text not null default '',
  source      text not null default 'app',
  legacy_id   text unique,                          -- เลขแถวจาก Google Sheet เดิม
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  deleted_at  timestamptz,
  deleted_by  uuid
);
create index if not exists movements_item_idx on public.movements(item_id) where deleted_at is null;
create index if not exists movements_date_idx on public.movements(date);
-- ข้อมูลเก่าจาก Sheet บางแถวไม่มีวันที่; รายการใหม่จากเว็บยังต้องมีวันที่
alter table public.movements alter column date drop not null;

-- updated_at อัตโนมัติ
create or replace function public.touch_updated()
returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items for each row execute function public.touch_updated();

-- ---------- Row Level Security ----------
alter table public.staff     enable row level security;
alter table public.items     enable row level security;
alter table public.movements enable row level security;

-- staff: ผู้แก้ไขเห็นรายชื่อเพื่อแสดงชื่อผู้บันทึก; Viewer เห็นเฉพาะตนเอง
-- การเพิ่ม/แก้สิทธิ์ทำผ่าน Edge Function ที่ตรวจบทบาท Founder เท่านั้น
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated using (public.is_staff() or user_id = auth.uid());

-- items: สมาชิกอ่านได้; เฉพาะ Founder/Editor เพิ่มและแก้ได้
drop policy if exists items_read on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
create policy items_read   on public.items for select to authenticated using (public.is_reader());
create policy items_insert on public.items for insert to authenticated with check (public.is_staff());
create policy items_update on public.items for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- movements: สมาชิกอ่านได้; เฉพาะ Founder/Editor เพิ่มและลบแบบ soft delete ได้
drop policy if exists mv_read on public.movements;
drop policy if exists mv_insert on public.movements;
drop policy if exists mv_update on public.movements;
create policy mv_read   on public.movements for select to authenticated using (public.is_reader());
create policy mv_insert on public.movements for insert to authenticated with check (public.is_staff() and created_by = auth.uid() and date is not null);
create policy mv_update on public.movements for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- กันการแก้ตัวเลขย้อนหลัง: อัปเดต movements ได้เฉพาะช่อง deleted_at / deleted_by
create or replace function public.guard_movement_update()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'deleted_at' - 'deleted_by')
     is distinct from
     (to_jsonb(old) - 'deleted_at' - 'deleted_by') then
    raise exception 'แก้ไขรายการที่บันทึกแล้วไม่ได้ ให้ลบแล้วบันทึกใหม่';
  end if;
  if old.deleted_at is not null then
    raise exception 'รายการนี้ถูกลบไปแล้ว';
  end if;
  if new.deleted_at is null then
    raise exception 'แก้ไขรายการที่บันทึกแล้วไม่ได้ ให้ลบแล้วบันทึกใหม่';
  end if;
  new.deleted_by := auth.uid();
  return new;
end $$;
drop trigger if exists movements_guard on public.movements;
create trigger movements_guard before update on public.movements for each row execute function public.guard_movement_update();

-- ---------- สำหรับ Visitor: ยอดคงเหลืออย่างเดียว ----------
-- Visitor (ไม่ล็อกอิน) อ่านตาราง items/movements ตรงๆ ไม่ได้ ได้เฉพาะผลจากฟังก์ชันนี้
create or replace function public.public_stock()
returns table (id text, code text, model text, spec text, type text, dept text, balance numeric, sort_order integer)
language sql stable security definer set search_path = public
as $$
  select i.id, i.code, i.model, i.spec, i.type, i.dept,
         i.opening + coalesce(sum(case when m.kind = 'in' then m.qty else -m.qty end), 0) as balance,
         i.sort_order
  from public.items i
  left join public.movements m on m.item_id = i.id and m.deleted_at is null
  where i.active
  group by i.id
  order by i.sort_order;
$$;

revoke all on function public.public_stock() from public;
grant execute on function public.public_stock() to anon, authenticated;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to anon, authenticated;
revoke all on function public.is_reader() from public;
grant execute on function public.is_reader() to authenticated;
revoke all on function public.my_role() from public;
grant execute on function public.my_role() to authenticated;
revoke all on function public.staff_display_names() from public;
grant execute on function public.staff_display_names() to authenticated;

-- สิทธิ์ระดับตาราง (RLS เป็นตัวกรองชั้นที่สอง)
revoke all on public.staff from public, anon, authenticated;
grant select on public.staff to authenticated;
grant select, insert, update on public.staff to service_role;
revoke all on public.items, public.movements from anon;
revoke delete, truncate on public.items, public.movements from authenticated;
grant select, insert, update on public.items, public.movements to authenticated;

-- อัปเดตสด (Realtime) สำหรับหน้าจอ staff
do $$ begin
  begin alter publication supabase_realtime add table public.items; exception when others then null; end;
  begin alter publication supabase_realtime add table public.movements; exception when others then null; end;
end $$;
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
-- Phase 1B: username login and enumeration-resistant rate limiting.
-- Run after 10_role_permissions.sql. Safe to run repeatedly.
begin;

alter table public.staff add column if not exists username text;

with candidates as (
  select user_id,
    trim(both '._-' from left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g'), 32)) as local_name
  from public.staff where username is null
), names as (
  select user_id,
    case when length(local_name) >= 3 then local_name
         else 'user_' || left(replace(user_id::text, '-', ''), 8) end as base_name
  from candidates
), numbered as (
  select user_id, base_name,
    row_number() over (partition by lower(base_name) order by user_id) as duplicate_number
  from names
)
update public.staff s
set username = case when n.duplicate_number = 1 then n.base_name
                    else left(n.base_name, 23) || '-' || left(replace(n.user_id::text, '-', ''), 8) end
from numbered n where s.user_id = n.user_id;

alter table public.staff alter column username set not null;
alter table public.staff drop constraint if exists staff_username_format;
alter table public.staff add constraint staff_username_format
  check (username = lower(username) and username ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$');
create unique index if not exists staff_username_unique on public.staff (lower(username));

create or replace function public.my_username()
returns text
language sql stable security definer set search_path = public
as $$
  select s.username from public.staff s
  where s.user_id = auth.uid() and s.is_active;
$$;
revoke all on function public.my_username() from public;
grant execute on function public.my_username() to authenticated;

-- Keys are salted SHA-256 hashes produced by login-username. The table never
-- stores an IP address or a submitted username.
create table if not exists public.username_login_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0)
);
alter table public.username_login_limits enable row level security;
revoke all on public.username_login_limits from public, anon, authenticated;
grant select, insert, update, delete on public.username_login_limits to service_role;

create or replace function public.consume_username_login_attempt(ip_bucket text, identity_bucket text)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
  ip_attempts integer;
  identity_attempts integer;
begin
  if ip_bucket !~ '^[0-9a-f]{64}$' or identity_bucket !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into public.username_login_limits as limits (bucket_key, window_started_at, attempts)
  values ('ip:' || ip_bucket, now(), 1)
  on conflict (bucket_key) do update set
    window_started_at = case when limits.window_started_at < now() - interval '10 minutes' then now() else limits.window_started_at end,
    attempts = case when limits.window_started_at < now() - interval '10 minutes' then 1 else limits.attempts + 1 end
  returning attempts into ip_attempts;

  insert into public.username_login_limits as limits (bucket_key, window_started_at, attempts)
  values ('identity:' || identity_bucket, now(), 1)
  on conflict (bucket_key) do update set
    window_started_at = case when limits.window_started_at < now() - interval '10 minutes' then now() else limits.window_started_at end,
    attempts = case when limits.window_started_at < now() - interval '10 minutes' then 1 else limits.attempts + 1 end
  returning attempts into identity_attempts;

  delete from public.username_login_limits where window_started_at < now() - interval '1 day';
  return ip_attempts <= 20 and identity_attempts <= 8;
end $$;
revoke all on function public.consume_username_login_attempt(text,text) from public, anon, authenticated;
grant execute on function public.consume_username_login_attempt(text,text) to service_role;

commit;
-- Fix the generic stock audit trigger so it also works for items, which do not
-- have movement-only deleted_at fields. Run after 11_usernames.sql.
-- Safe to run repeatedly.
begin;

create or replace function public.audit_stock_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
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
    change_action := case
      when tg_table_name = 'movements'
        and (old_data ->> 'deleted_at') is null
        and (new_data ->> 'deleted_at') is not null
      then 'soft_delete'
      else 'update'
    end;
  end if;

  insert into public.stock_audit
    (actor_id, entity, entity_id, action, before_data, after_data)
  values
    (auth.uid(), tg_table_name, changed_id, change_action, old_data, new_data);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

revoke all on function public.audit_stock_change() from public;

commit;
-- Route movement soft deletes through one atomic, permission-checked RPC.
-- Run after 12_fix_stock_audit.sql. Safe to run repeatedly.
begin;

create or replace function public.soft_delete_movement(p_movement_id uuid)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
  target public.movements%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'กรุณาเข้าสู่ระบบ';
  end if;

  select * into target
  from public.movements
  where id = p_movement_id
  for update;

  if not found or target.deleted_at is not null
     or not public.can_delete_movement(target.created_by, target.created_at) then
    raise exception using errcode = '42501', message = 'ไม่พบรายการหรือไม่มีสิทธิ์ลบรายการนี้';
  end if;

  update public.movements
  set deleted_at = now(), deleted_by = auth.uid()
  where id = target.id;

  return true;
end $$;

revoke all on function public.soft_delete_movement(uuid) from public, anon;
grant execute on function public.soft_delete_movement(uuid) to authenticated;

-- The RPC above is now the only browser path for updating movements.
drop policy if exists mv_update on public.movements;
revoke update on public.movements from authenticated;

commit;
-- Phase 2: atomic dispatch request and approval workflow.
-- Run after 13_soft_delete_movement_rpc.sql. Safe to run repeatedly.
begin;

create table if not exists public.dispatch_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id),
  requester_role text not null check (requester_role in ('warehouse','admin','owner','founder')),
  status text not null check (status in ('pending','approved','rejected','cancelled')),
  document_date date not null,
  customer text not null default '',
  doc_no text not null default '',
  dept text not null default '',
  sale text not null default '',
  note text not null default '',
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz
);

create table if not exists public.dispatch_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.dispatch_requests(id) on delete cascade,
  item_id text not null references public.items(id),
  code text not null default '',
  model text not null default '',
  requested_qty numeric not null check (requested_qty > 0),
  approved_qty numeric check (approved_qty > 0),
  movement_id uuid unique references public.movements(id),
  unique (request_id,item_id)
);
create index if not exists dispatch_requests_requester_idx on public.dispatch_requests(requester_id,created_at desc);
create index if not exists dispatch_requests_pending_idx on public.dispatch_requests(created_at) where status='pending';
create index if not exists dispatch_request_lines_item_idx on public.dispatch_request_lines(item_id) where movement_id is null;

alter table public.movements add column if not exists dispatch_request_id uuid references public.dispatch_requests(id);
alter table public.movements add column if not exists dispatch_request_line_id uuid unique references public.dispatch_request_lines(id);

create or replace function public.can_review_dispatch(requester_role text)
returns boolean language sql stable security definer set search_path=public
as $$
  select case
    when requester_role='warehouse' then public.has_role(array['admin','owner','founder'])
    when requester_role='admin' then public.has_role(array['owner','founder'])
    else false
  end;
$$;
revoke all on function public.can_review_dispatch(text) from public;
grant execute on function public.can_review_dispatch(text) to authenticated;

create or replace function public.dispatch_available(p_item_id text)
returns numeric language sql stable security definer set search_path=public
as $$
  select i.opening
    + coalesce((select sum(case when m.kind='in' then m.qty else -m.qty end) from public.movements m where m.item_id=i.id and m.deleted_at is null),0)
    - coalesce((select sum(l.requested_qty) from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id where l.item_id=i.id and r.status='pending'),0)
  from public.items i where i.id=p_item_id and i.active;
$$;
revoke all on function public.dispatch_available(text) from public;
grant execute on function public.dispatch_available(text) to authenticated;

create or replace function public.dispatch_pending_totals()
returns table(item_id text,pending_qty numeric)
language sql stable security definer set search_path=public
as $$
  select l.item_id,sum(l.requested_qty)
  from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
  where r.status='pending' and public.is_reader()
  group by l.item_id;
$$;
revoke all on function public.dispatch_pending_totals() from public;
grant execute on function public.dispatch_pending_totals() to authenticated;

alter table public.dispatch_requests enable row level security;
alter table public.dispatch_request_lines enable row level security;
drop policy if exists dispatch_requests_read on public.dispatch_requests;
create policy dispatch_requests_read on public.dispatch_requests for select to authenticated
using (requester_id=auth.uid() or public.can_review_dispatch(requester_role));
drop policy if exists dispatch_request_lines_read on public.dispatch_request_lines;
create policy dispatch_request_lines_read on public.dispatch_request_lines for select to authenticated
using (exists (select 1 from public.dispatch_requests r where r.id=request_id));

revoke all on public.dispatch_requests,public.dispatch_request_lines from public,anon,authenticated;
grant select on public.dispatch_requests,public.dispatch_request_lines to authenticated;

create or replace function public.create_dispatch_request(
  p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare
  new_request_id uuid; caller_role text; line_count int; inserted_count int; line record; new_movement_id uuid; balance numeric;
begin
  select s.role into caller_role from public.staff s where s.user_id=auth.uid() and s.is_active;
  if caller_role is null or caller_role not in ('warehouse','admin','owner','founder') then raise exception using errcode='42501',message='ไม่มีสิทธิ์ส่งคำขอเบิก'; end if;
  if p_document_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  line_count:=jsonb_array_length(p_lines);
  if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines) x where coalesce(x->>'item_id','')='' or coalesce((x->>'qty')::numeric,0)<=0) then raise exception 'สินค้าและจำนวนไม่ถูกต้อง'; end if;

  insert into public.dispatch_requests(requester_id,requester_role,status,document_date,customer,doc_no,dept,sale,note)
  values(auth.uid(),caller_role,case when caller_role in ('owner','founder') then 'approved' else 'pending' end,p_document_date,left(coalesce(p_customer,''),300),left(coalesce(p_doc_no,''),150),left(coalesce(p_dept,''),150),left(coalesce(p_sale,''),150),left(coalesce(p_note,''),1000)) returning id into new_request_id;
  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty)
  select new_request_id,i.id,i.code,i.model,(x->>'qty')::numeric from jsonb_array_elements(p_lines) x join public.items i on i.id=x->>'item_id' and i.active;
  get diagnostics inserted_count=row_count;
  if inserted_count<>line_count then raise exception 'มีสินค้าที่ไม่พร้อมใช้งานหรือซ้ำกัน'; end if;

  if caller_role in ('owner','founder') then
    perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id where l.request_id=new_request_id order by i.id for update of i;
    for line in select * from public.dispatch_request_lines l where l.request_id=new_request_id order by l.item_id loop
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=line.item_id group by i.id;
      if line.requested_qty>balance then raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ'; end if;
      insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_by,dispatch_request_id,dispatch_request_line_id)
      select line.item_id,line.code,line.model,p_document_date,'out',line.requested_qty,r.customer,r.doc_no,r.dept,r.sale,r.note,'request',auth.uid(),r.id,line.id from public.dispatch_requests r where r.id=new_request_id returning id into new_movement_id;
      update public.dispatch_request_lines set approved_qty=line.requested_qty,movement_id=new_movement_id where id=line.id;
    end loop;
    update public.dispatch_requests set decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=new_request_id;
  end if;
  return new_request_id;
end $$;

create or replace function public.update_dispatch_request(
  p_request_id uuid,p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype; line_count int; inserted_count int;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id<>auth.uid() then raise exception using errcode='42501',message='แก้ไขคำขอนี้ไม่ได้'; end if;
  if p_document_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  line_count:=jsonb_array_length(p_lines); if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  delete from public.dispatch_request_lines where request_id=p_request_id;
  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty)
  select p_request_id,i.id,i.code,i.model,(x->>'qty')::numeric from jsonb_array_elements(p_lines) x join public.items i on i.id=x->>'item_id' and i.active where (x->>'qty')::numeric>0;
  get diagnostics inserted_count=row_count; if inserted_count<>line_count then raise exception 'สินค้าและจำนวนไม่ถูกต้องหรือซ้ำกัน'; end if;
  update public.dispatch_requests set document_date=p_document_date,customer=left(coalesce(p_customer,''),300),doc_no=left(coalesce(p_doc_no,''),150),dept=left(coalesce(p_dept,''),150),sale=left(coalesce(p_sale,''),150),note=left(coalesce(p_note,''),1000),updated_at=now() where id=p_request_id;
  return true;
end $$;

create or replace function public.approve_dispatch_request(p_request_id uuid,p_lines jsonb)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype; line_count int; updated_count int; line record; new_movement_id uuid; balance numeric;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id=auth.uid() or not public.can_review_dispatch(target.requester_role) then raise exception using errcode='42501',message='ไม่มีสิทธิ์อนุมัติคำขอนี้'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'จำนวนอนุมัติไม่ถูกต้อง'; end if;
  select count(*) into line_count from public.dispatch_request_lines where request_id=p_request_id;
  if jsonb_array_length(p_lines)<>line_count or exists(select 1 from jsonb_array_elements(p_lines) x where coalesce((x->>'qty')::numeric,0)<=0) then raise exception 'ต้องระบุจำนวนอนุมัติให้ครบทุกรายการ'; end if;
  update public.dispatch_request_lines l set approved_qty=(x->>'qty')::numeric from jsonb_array_elements(p_lines) x where l.request_id=p_request_id and l.id=(x->>'line_id')::uuid;
  get diagnostics updated_count=row_count; if updated_count<>line_count then raise exception 'รายการอนุมัติไม่ตรงกับคำขอ'; end if;
  perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id where l.request_id=p_request_id order by i.id for update of i;
  for line in select * from public.dispatch_request_lines where request_id=p_request_id order by item_id loop
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=line.item_id group by i.id;
    if line.approved_qty>balance then raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ'; end if;
    insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_by,dispatch_request_id,dispatch_request_line_id)
    values(line.item_id,line.code,line.model,target.document_date,'out',line.approved_qty,target.customer,target.doc_no,target.dept,target.sale,target.note,'request',auth.uid(),target.id,line.id) returning id into new_movement_id;
    update public.dispatch_request_lines set movement_id=new_movement_id where id=line.id;
  end loop;
  update public.dispatch_requests set status='approved',decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=p_request_id;
  return true;
end $$;

create or replace function public.reject_dispatch_request(p_request_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id=auth.uid() or not public.can_review_dispatch(target.requester_role) then raise exception using errcode='42501',message='ไม่มีสิทธิ์ปฏิเสธคำขอนี้'; end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลที่ปฏิเสธ'; end if;
  update public.dispatch_requests set status='rejected',rejection_reason=left(trim(p_reason),1000),decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=p_request_id;
  return true;
end $$;

create or replace function public.cancel_dispatch_request(p_request_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id<>auth.uid() then raise exception using errcode='42501',message='ยกเลิกคำขอนี้ไม่ได้'; end if;
  update public.dispatch_requests set status='cancelled',updated_at=now() where id=p_request_id;
  return true;
end $$;

revoke all on function public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,text,text,text,text,text,jsonb),public.approve_dispatch_request(uuid,jsonb),public.reject_dispatch_request(uuid,text),public.cancel_dispatch_request(uuid) from public,anon;
grant execute on function public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,text,text,text,text,text,jsonb),public.approve_dispatch_request(uuid,jsonb),public.reject_dispatch_request(uuid,text),public.cancel_dispatch_request(uuid) to authenticated;

-- Direct movement writes after Phase 2: Owner/Founder may dispatch immediately;
-- Admin may receive and adjust; Warehouse writes no movements directly.
drop policy if exists mv_insert on public.movements;
create policy mv_insert on public.movements for insert to authenticated with check (
  created_by=auth.uid() and date is not null and deleted_at is null and (
    (public.has_role(array['owner','founder']) and source in ('app','adjustment')) or
    (public.has_role(array['admin']) and ((kind='in' and source='app') or source='adjustment'))
  )
);
create or replace function public.can_delete_movement(recorded_by uuid,recorded_at timestamptz)
returns boolean language sql stable security definer set search_path=public
as $$ select public.has_role(array['founder','owner','admin']); $$;

do $$ begin
  begin alter publication supabase_realtime add table public.dispatch_requests; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.dispatch_request_lines; exception when duplicate_object then null; end;
end $$;

commit;
-- Phase 2 hardening: whole-unit request quantities and approval caps.
-- Run after 14_dispatch_requests.sql. Safe to run repeatedly.
begin;

alter table public.dispatch_request_lines
  drop constraint if exists dispatch_request_lines_requested_qty_check,
  drop constraint if exists dispatch_request_lines_approved_qty_check;
alter table public.dispatch_request_lines
  add constraint dispatch_request_lines_requested_qty_check check (requested_qty > 0 and requested_qty = trunc(requested_qty)),
  add constraint dispatch_request_lines_approved_qty_check check (approved_qty is null or (approved_qty > 0 and approved_qty = trunc(approved_qty) and approved_qty <= requested_qty));

create or replace function public.create_dispatch_request(
  p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare
  new_request_id uuid; caller_role text; line_count int; inserted_count int; line record; new_movement_id uuid; balance numeric;
begin
  select s.role into caller_role from public.staff s where s.user_id=auth.uid() and s.is_active;
  if caller_role is null or caller_role not in ('warehouse','admin','owner','founder') then raise exception using errcode='42501',message='ไม่มีสิทธิ์ส่งคำขอเบิก'; end if;
  if p_document_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  line_count:=jsonb_array_length(p_lines);
  if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines) x where coalesce(x->>'item_id','')='' or coalesce((x->>'qty')::numeric,0)<=0 or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric)) then raise exception 'สินค้าและจำนวนไม่ถูกต้อง'; end if;

  insert into public.dispatch_requests(requester_id,requester_role,status,document_date,customer,doc_no,dept,sale,note)
  values(auth.uid(),caller_role,case when caller_role in ('owner','founder') then 'approved' else 'pending' end,p_document_date,left(coalesce(p_customer,''),300),left(coalesce(p_doc_no,''),150),left(coalesce(p_dept,''),150),left(coalesce(p_sale,''),150),left(coalesce(p_note,''),1000)) returning id into new_request_id;
  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty)
  select new_request_id,i.id,i.code,i.model,(x->>'qty')::numeric from jsonb_array_elements(p_lines) x join public.items i on i.id=x->>'item_id' and i.active;
  get diagnostics inserted_count=row_count;
  if inserted_count<>line_count then raise exception 'มีสินค้าที่ไม่พร้อมใช้งานหรือซ้ำกัน'; end if;

  if caller_role in ('owner','founder') then
    perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id where l.request_id=new_request_id order by i.id for update of i;
    for line in select * from public.dispatch_request_lines l where l.request_id=new_request_id order by l.item_id loop
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=line.item_id group by i.id;
      if line.requested_qty>balance then raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ'; end if;
      insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_by,dispatch_request_id,dispatch_request_line_id)
      select line.item_id,line.code,line.model,p_document_date,'out',line.requested_qty,r.customer,r.doc_no,r.dept,r.sale,r.note,'request',auth.uid(),r.id,line.id from public.dispatch_requests r where r.id=new_request_id returning id into new_movement_id;
      update public.dispatch_request_lines set approved_qty=line.requested_qty,movement_id=new_movement_id where id=line.id;
    end loop;
    update public.dispatch_requests set decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=new_request_id;
  end if;
  return new_request_id;
end $$;

create or replace function public.update_dispatch_request(
  p_request_id uuid,p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype; line_count int; inserted_count int;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id<>auth.uid() then raise exception using errcode='42501',message='แก้ไขคำขอนี้ไม่ได้'; end if;
  if p_document_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  line_count:=jsonb_array_length(p_lines); if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines) x where coalesce(x->>'item_id','')='' or coalesce((x->>'qty')::numeric,0)<=0 or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric)) then raise exception 'สินค้าและจำนวนต้องเป็นจำนวนเต็มบวก'; end if;
  delete from public.dispatch_request_lines where request_id=p_request_id;
  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty)
  select p_request_id,i.id,i.code,i.model,(x->>'qty')::numeric from jsonb_array_elements(p_lines) x join public.items i on i.id=x->>'item_id' and i.active where (x->>'qty')::numeric>0;
  get diagnostics inserted_count=row_count; if inserted_count<>line_count then raise exception 'สินค้าและจำนวนไม่ถูกต้องหรือซ้ำกัน'; end if;
  update public.dispatch_requests set document_date=p_document_date,customer=left(coalesce(p_customer,''),300),doc_no=left(coalesce(p_doc_no,''),150),dept=left(coalesce(p_dept,''),150),sale=left(coalesce(p_sale,''),150),note=left(coalesce(p_note,''),1000),updated_at=now() where id=p_request_id;
  return true;
end $$;

create or replace function public.approve_dispatch_request(p_request_id uuid,p_lines jsonb)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype; line_count int; updated_count int; line record; new_movement_id uuid; balance numeric;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id=auth.uid() or not public.can_review_dispatch(target.requester_role) then raise exception using errcode='42501',message='ไม่มีสิทธิ์อนุมัติคำขอนี้'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'จำนวนอนุมัติไม่ถูกต้อง'; end if;
  select count(*) into line_count from public.dispatch_request_lines where request_id=p_request_id;
  if jsonb_array_length(p_lines)<>line_count or exists(select 1 from jsonb_array_elements(p_lines) x where coalesce((x->>'qty')::numeric,0)<=0 or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric)) then raise exception 'จำนวนอนุมัติต้องเป็นจำนวนเต็มบวกและระบุให้ครบทุกรายการ'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines) x join public.dispatch_request_lines l on l.request_id=p_request_id and l.id=(x->>'line_id')::uuid where (x->>'qty')::numeric>l.requested_qty) then raise exception using errcode='23514',message='จำนวนอนุมัติต้องไม่เกินจำนวนที่ขอ'; end if;
  update public.dispatch_request_lines l set approved_qty=(x->>'qty')::numeric from jsonb_array_elements(p_lines) x where l.request_id=p_request_id and l.id=(x->>'line_id')::uuid;
  get diagnostics updated_count=row_count; if updated_count<>line_count then raise exception 'รายการอนุมัติไม่ตรงกับคำขอ'; end if;
  perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id where l.request_id=p_request_id order by i.id for update of i;
  for line in select * from public.dispatch_request_lines where request_id=p_request_id order by item_id loop
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=line.item_id group by i.id;
    if line.approved_qty>balance then raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ'; end if;
    insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_by,dispatch_request_id,dispatch_request_line_id)
    values(line.item_id,line.code,line.model,target.document_date,'out',line.approved_qty,target.customer,target.doc_no,target.dept,target.sale,target.note,'request',auth.uid(),target.id,line.id) returning id into new_movement_id;
    update public.dispatch_request_lines set movement_id=new_movement_id where id=line.id;
  end loop;
  update public.dispatch_requests set status='approved',decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=p_request_id;
  return true;
end $$;


revoke all on function public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,text,text,text,text,text,jsonb),public.approve_dispatch_request(uuid,jsonb) from public,anon;
grant execute on function public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,text,text,text,text,text,jsonb),public.approve_dispatch_request(uuid,jsonb) to authenticated;

commit;
-- Phase 3B: stable temporary delivery-note metadata on dispatch requests.
-- Safe to run repeatedly after 15_dispatch_integer_quantities.sql.
begin;

create sequence if not exists public.delivery_note_number_seq;

alter table public.dispatch_requests
  add column if not exists delivery_note_no text,
  add column if not exists delivery_date date;

alter table public.dispatch_request_lines
  add column if not exists purpose text not null default 'sale',
  add column if not exists return_required boolean not null default false,
  add column if not exists line_note text not null default '';

update public.dispatch_requests
set delivery_date=document_date
where delivery_date is null;

update public.dispatch_requests
set delivery_note_no='TD-' || to_char(coalesce(created_at,now()) at time zone 'Asia/Bangkok','YYYYMMDD') || '-' || lpad(nextval('public.delivery_note_number_seq')::text,5,'0')
where delivery_note_no is null;

alter table public.dispatch_requests alter column delivery_date set not null;
alter table public.dispatch_requests alter column delivery_note_no set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='dispatch_requests_delivery_note_no_key' and conrelid='public.dispatch_requests'::regclass) then
    alter table public.dispatch_requests add constraint dispatch_requests_delivery_note_no_key unique(delivery_note_no);
  end if;
end $$;

alter table public.dispatch_request_lines drop constraint if exists dispatch_request_lines_purpose_check;
alter table public.dispatch_request_lines add constraint dispatch_request_lines_purpose_check check (purpose in ('sale','gift','claim','other'));

create or replace function public.assign_delivery_note_number()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.delivery_date is null then new.delivery_date:=new.document_date; end if;
  if nullif(trim(new.delivery_note_no),'') is null then
    new.delivery_note_no:='TD-' || to_char(coalesce(new.created_at,now()) at time zone 'Asia/Bangkok','YYYYMMDD') || '-' || lpad(nextval('public.delivery_note_number_seq')::text,5,'0');
  end if;
  return new;
end $$;

drop trigger if exists dispatch_request_delivery_note_number on public.dispatch_requests;
create trigger dispatch_request_delivery_note_number before insert on public.dispatch_requests
for each row execute function public.assign_delivery_note_number();

create or replace function public.create_dispatch_request(
  p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare
  new_request_id uuid; caller_role text; line_count int; inserted_count int; line record; new_movement_id uuid; balance numeric;
begin
  select s.role into caller_role from public.staff s where s.user_id=auth.uid() and s.is_active;
  if caller_role is null or caller_role not in ('warehouse','admin','owner','founder') then raise exception using errcode='42501',message='ไม่มีสิทธิ์ส่งคำขอเบิก'; end if;
  if p_document_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  line_count:=jsonb_array_length(p_lines);
  if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines) x where coalesce(x->>'item_id','')='' or coalesce((x->>'qty')::numeric,0)<=0 or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric) or coalesce(x->>'purpose','sale') not in ('sale','gift','claim','other')) then raise exception 'สินค้า จำนวน หรือวัตถุประสงค์ไม่ถูกต้อง'; end if;

  insert into public.dispatch_requests(requester_id,requester_role,status,document_date,delivery_date,customer,doc_no,dept,sale,note)
  values(auth.uid(),caller_role,case when caller_role in ('owner','founder') then 'approved' else 'pending' end,p_document_date,p_document_date,left(coalesce(p_customer,''),300),left(coalesce(p_doc_no,''),150),left(coalesce(p_dept,''),150),left(coalesce(p_sale,''),150),left(coalesce(p_note,''),1000)) returning id into new_request_id;
  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty,purpose,return_required,line_note)
  select new_request_id,i.id,i.code,i.model,(x->>'qty')::numeric,coalesce(nullif(x->>'purpose',''),'sale'),coalesce((x->>'return_required')::boolean,false),left(coalesce(x->>'line_note',''),300)
  from jsonb_array_elements(p_lines) x join public.items i on i.id=x->>'item_id' and i.active;
  get diagnostics inserted_count=row_count;
  if inserted_count<>line_count then raise exception 'มีสินค้าที่ไม่พร้อมใช้งานหรือซ้ำกัน'; end if;

  if caller_role in ('owner','founder') then
    perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id where l.request_id=new_request_id order by i.id for update of i;
    for line in select * from public.dispatch_request_lines l where l.request_id=new_request_id order by l.item_id loop
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=line.item_id group by i.id;
      if line.requested_qty>balance then raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ'; end if;
      insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,created_by,dispatch_request_id,dispatch_request_line_id)
      select line.item_id,line.code,line.model,p_document_date,'out',line.requested_qty,r.customer,r.doc_no,r.dept,r.sale,r.note,'request',auth.uid(),r.id,line.id from public.dispatch_requests r where r.id=new_request_id returning id into new_movement_id;
      update public.dispatch_request_lines set approved_qty=line.requested_qty,movement_id=new_movement_id where id=line.id;
    end loop;
    update public.dispatch_requests set decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=new_request_id;
  end if;
  return new_request_id;
end $$;

create or replace function public.update_dispatch_request(
  p_request_id uuid,p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype; line_count int; inserted_count int;
begin
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id<>auth.uid() then raise exception using errcode='42501',message='แก้ไขคำขอนี้ไม่ได้'; end if;
  if p_document_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  line_count:=jsonb_array_length(p_lines); if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines) x where coalesce(x->>'item_id','')='' or coalesce((x->>'qty')::numeric,0)<=0 or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric) or coalesce(x->>'purpose','sale') not in ('sale','gift','claim','other')) then raise exception 'สินค้า จำนวน หรือวัตถุประสงค์ไม่ถูกต้อง'; end if;
  delete from public.dispatch_request_lines where request_id=p_request_id;
  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty,purpose,return_required,line_note)
  select p_request_id,i.id,i.code,i.model,(x->>'qty')::numeric,coalesce(nullif(x->>'purpose',''),'sale'),coalesce((x->>'return_required')::boolean,false),left(coalesce(x->>'line_note',''),300)
  from jsonb_array_elements(p_lines) x join public.items i on i.id=x->>'item_id' and i.active;
  get diagnostics inserted_count=row_count; if inserted_count<>line_count then raise exception 'สินค้าและจำนวนไม่ถูกต้องหรือซ้ำกัน'; end if;
  update public.dispatch_requests set document_date=p_document_date,delivery_date=p_document_date,customer=left(coalesce(p_customer,''),300),doc_no=left(coalesce(p_doc_no,''),150),dept=left(coalesce(p_dept,''),150),sale=left(coalesce(p_sale,''),150),note=left(coalesce(p_note,''),1000),updated_at=now() where id=p_request_id;
  return true;
end $$;

revoke all on function public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,text,text,text,text,text,jsonb) from public,anon;
grant execute on function public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,text,text,text,text,text,jsonb) to authenticated;

-- New overloads keep the older API working while allowing the web app to
-- record a delivery date distinct from the warehouse dispatch date.
create or replace function public.create_dispatch_request(
  p_document_date date,p_delivery_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare new_request_id uuid;
begin
  if p_delivery_date is null then raise exception 'กรุณาระบุวันที่ส่งของ'; end if;
  new_request_id:=public.create_dispatch_request(p_document_date,p_customer,p_doc_no,p_dept,p_sale,p_note,p_lines);
  update public.dispatch_requests set delivery_date=p_delivery_date where id=new_request_id;
  return new_request_id;
end $$;

create or replace function public.update_dispatch_request(
  p_request_id uuid,p_document_date date,p_delivery_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if p_delivery_date is null then raise exception 'กรุณาระบุวันที่ส่งของ'; end if;
  perform public.update_dispatch_request(p_request_id,p_document_date,p_customer,p_doc_no,p_dept,p_sale,p_note,p_lines);
  update public.dispatch_requests set delivery_date=p_delivery_date where id=p_request_id;
  return true;
end $$;

revoke all on function public.create_dispatch_request(date,date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,date,text,text,text,text,text,jsonb) from public,anon;
grant execute on function public.create_dispatch_request(date,date,text,text,text,text,text,jsonb),public.update_dispatch_request(uuid,date,date,text,text,text,text,text,jsonb) to authenticated;


-- Phase 6A: post-delivery ERP invoice tracking at dispatch-line level.
-- This migration never writes public.movements.

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  inv_no text not null unique,
  inv_date date not null,
  customer text not null default '',
  status text not null default 'active' check (status in ('active','cancelled')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz
);
create unique index if not exists invoices_inv_no_lower_key on public.invoices(lower(inv_no));
create index if not exists invoices_date_idx on public.invoices(inv_date desc,created_at desc);

alter table public.dispatch_request_lines
  add column if not exists invoice_id uuid references public.invoices(id),
  add column if not exists no_invoice_reason text,
  add column if not exists no_invoice_by uuid references auth.users(id),
  add column if not exists no_invoice_at timestamptz;
create index if not exists dispatch_lines_invoice_idx on public.dispatch_request_lines(invoice_id) where invoice_id is not null;
create unique index if not exists dispatch_lines_one_invoice_idx on public.dispatch_request_lines(id) where invoice_id is not null;

alter table public.dispatch_request_lines drop constraint if exists dispatch_lines_invoice_exclusive_check;
alter table public.dispatch_request_lines add constraint dispatch_lines_invoice_exclusive_check check (
  not (invoice_id is not null and nullif(trim(no_invoice_reason),'') is not null)
  and (purpose <> 'sale' or nullif(trim(no_invoice_reason),'') is null)
  and ((nullif(trim(no_invoice_reason),'') is null and no_invoice_by is null and no_invoice_at is null)
    or (nullif(trim(no_invoice_reason),'') is not null and no_invoice_by is not null and no_invoice_at is not null))
);

-- Extend the existing immutable change log for invoice activity.
alter table public.stock_audit drop constraint if exists stock_audit_entity_check;
alter table public.stock_audit add constraint stock_audit_entity_check
  check (entity in ('items','movements','invoices','invoice_lines'));
alter table public.stock_audit drop constraint if exists stock_audit_action_check;
alter table public.stock_audit add constraint stock_audit_action_check
  check (action in ('insert','update','delete','soft_delete','link','unlink','cancel','no_invoice','clear_no_invoice'));

create or replace function public.can_manage_invoices()
returns boolean language sql stable security definer set search_path=public
as $$ select public.has_role(array['admin','owner','founder']); $$;
revoke all on function public.can_manage_invoices() from public,anon;
grant execute on function public.can_manage_invoices() to authenticated;

create or replace function public.log_invoice_change(p_entity text,p_entity_id text,p_action text,p_before jsonb,p_after jsonb)
returns void language plpgsql volatile security definer set search_path=public as $$
begin
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),p_entity,p_entity_id,p_action,p_before,p_after);
end $$;
revoke all on function public.log_invoice_change(text,text,text,jsonb,jsonb) from public,anon,authenticated;

alter table public.invoices enable row level security;
revoke all on public.invoices from public,anon,authenticated;
grant select on public.invoices to authenticated;
drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated using (
  public.has_role(array['admin','owner','founder','auditor'])
  or (public.has_role(array['warehouse']) and exists (
    select 1 from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
    where l.invoice_id=invoices.id and r.requester_id=auth.uid()
  ))
);

-- Warehouse may read only its own requests and invoice mappings.
drop policy if exists dispatch_requests_read on public.dispatch_requests;
create policy dispatch_requests_read on public.dispatch_requests for select to authenticated using (
  public.has_role(array['admin','owner','founder'])
  or (public.has_role(array['warehouse']) and requester_id=auth.uid())
  or (public.has_role(array['auditor']) and status='approved')
);
drop policy if exists dispatch_request_lines_read on public.dispatch_request_lines;
create policy dispatch_request_lines_read on public.dispatch_request_lines for select to authenticated using (
  exists (select 1 from public.dispatch_requests r where r.id=request_id and (
    public.has_role(array['admin','owner','founder'])
    or (public.has_role(array['warehouse']) and r.requester_id=auth.uid())
    or (public.has_role(array['auditor']) and r.status='approved')
  ))
);
revoke insert,update,delete,truncate on public.invoices from public,anon,authenticated;
revoke update(invoice_id,no_invoice_reason,no_invoice_by,no_invoice_at) on public.dispatch_request_lines from public,anon,authenticated;

create or replace function public.create_invoice(p_inv_no text,p_inv_date date,p_customer text,p_line_ids uuid[])
returns uuid language plpgsql volatile security definer set search_path=public as $$
declare new_id uuid; line_id uuid; target record; before_line jsonb; after_line jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  if nullif(trim(p_inv_no),'') is null or p_inv_date is null then raise exception 'กรุณาระบุเลขที่และวันที่ INV'; end if;
  if p_line_ids is null or cardinality(p_line_ids)<1 or cardinality(p_line_ids)<>cardinality(array(select distinct x from unnest(p_line_ids) x)) then raise exception 'เลือกรายการอย่างน้อยหนึ่งรายการและห้ามซ้ำ'; end if;
  insert into public.invoices(inv_no,inv_date,customer,created_by,updated_by)
  values(upper(trim(p_inv_no)),p_inv_date,left(trim(coalesce(p_customer,'')),300),auth.uid(),auth.uid()) returning id into new_id;
  perform public.log_invoice_change('invoices',new_id::text,'insert',null,(select to_jsonb(i) from public.invoices i where i.id=new_id));
  foreach line_id in array p_line_ids loop
    select l.*,r.status into target from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id where l.id=line_id for update of l;
    if not found or target.status<>'approved' then raise exception 'ผูก INV ได้เฉพาะรายการที่อนุมัติแล้ว'; end if;
    if target.invoice_id is not null or nullif(trim(target.no_invoice_reason),'') is not null then raise exception 'รายการนี้มีสถานะ INV แล้ว'; end if;
    before_line:=to_jsonb(target)-'status';
    update public.dispatch_request_lines set invoice_id=new_id where id=line_id returning to_jsonb(dispatch_request_lines.*) into after_line;
    perform public.log_invoice_change('invoice_lines',line_id::text,'link',before_line,after_line);
  end loop;
  return new_id;
exception when unique_violation then raise exception using errcode='23505',message='เลข INV นี้มีอยู่แล้ว';
end $$;

create or replace function public.update_invoice(p_invoice_id uuid,p_inv_no text,p_inv_date date,p_customer text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.invoices%rowtype; after_row jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  select * into target from public.invoices where id=p_invoice_id for update;
  if not found or target.status<>'active' then raise exception 'INV นี้แก้ไขไม่ได้'; end if;
  if nullif(trim(p_inv_no),'') is null or p_inv_date is null then raise exception 'กรุณาระบุเลขที่และวันที่ INV'; end if;
  update public.invoices set inv_no=upper(trim(p_inv_no)),inv_date=p_inv_date,customer=left(trim(coalesce(p_customer,'')),300),updated_by=auth.uid(),updated_at=now()
  where id=p_invoice_id returning to_jsonb(invoices.*) into after_row;
  perform public.log_invoice_change('invoices',p_invoice_id::text,'update',to_jsonb(target),after_row);
  return true;
exception when unique_violation then raise exception using errcode='23505',message='เลข INV นี้มีอยู่แล้ว';
end $$;

create or replace function public.attach_invoice_lines(p_invoice_id uuid,p_line_ids uuid[])
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare inv public.invoices%rowtype; line_id uuid; target record; after_line jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  select * into inv from public.invoices where id=p_invoice_id for update;
  if not found or inv.status<>'active' then raise exception 'INV นี้ใช้งานไม่ได้'; end if;
  if p_line_ids is null or cardinality(p_line_ids)<1 or cardinality(p_line_ids)<>cardinality(array(select distinct x from unnest(p_line_ids) x)) then raise exception 'เลือกรายการอย่างน้อยหนึ่งรายการและห้ามซ้ำ'; end if;
  foreach line_id in array p_line_ids loop
    select l.*,r.status into target from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id where l.id=line_id for update of l;
    if not found or target.status<>'approved' then raise exception 'ผูก INV ได้เฉพาะรายการที่อนุมัติแล้ว'; end if;
    if target.invoice_id is not null or nullif(trim(target.no_invoice_reason),'') is not null then raise exception 'รายการนี้มีสถานะ INV แล้ว'; end if;
    update public.dispatch_request_lines set invoice_id=p_invoice_id where id=line_id returning to_jsonb(dispatch_request_lines.*) into after_line;
    perform public.log_invoice_change('invoice_lines',line_id::text,'link',to_jsonb(target)-'status',after_line);
  end loop;
  return true;
end $$;

create or replace function public.detach_invoice_line(p_line_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_request_lines%rowtype; after_line jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  select * into target from public.dispatch_request_lines where id=p_line_id for update;
  if not found or target.invoice_id is null then raise exception 'รายการนี้ยังไม่ได้ผูก INV'; end if;
  update public.dispatch_request_lines set invoice_id=null where id=p_line_id returning to_jsonb(dispatch_request_lines.*) into after_line;
  perform public.log_invoice_change('invoice_lines',p_line_id::text,'unlink',to_jsonb(target),after_line);
  return true;
end $$;

create or replace function public.mark_line_no_invoice(p_line_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target record; after_line jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  select l.*,r.status into target from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id where l.id=p_line_id for update of l;
  if not found or target.status<>'approved' then raise exception 'กำหนดได้เฉพาะรายการที่อนุมัติแล้ว'; end if;
  if target.purpose='sale' then raise exception 'รายการขายต้องเปิด INV'; end if;
  if target.invoice_id is not null then raise exception 'รายการนี้ผูก INV แล้ว'; end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลที่ไม่ต้องเปิด INV'; end if;
  update public.dispatch_request_lines set no_invoice_reason=left(trim(p_reason),500),no_invoice_by=auth.uid(),no_invoice_at=now()
  where id=p_line_id returning to_jsonb(dispatch_request_lines.*) into after_line;
  perform public.log_invoice_change('invoice_lines',p_line_id::text,'no_invoice',to_jsonb(target)-'status',after_line);
  return true;
end $$;

create or replace function public.clear_line_no_invoice(p_line_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_request_lines%rowtype; after_line jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  select * into target from public.dispatch_request_lines where id=p_line_id for update;
  if not found or nullif(trim(target.no_invoice_reason),'') is null then raise exception 'รายการนี้ไม่ได้ระบุว่าไม่ต้องเปิด INV'; end if;
  update public.dispatch_request_lines set no_invoice_reason=null,no_invoice_by=null,no_invoice_at=null where id=p_line_id returning to_jsonb(dispatch_request_lines.*) into after_line;
  perform public.log_invoice_change('invoice_lines',p_line_id::text,'clear_no_invoice',to_jsonb(target),after_line);
  return true;
end $$;

create or replace function public.cancel_invoice(p_invoice_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.invoices%rowtype; line public.dispatch_request_lines%rowtype; after_line jsonb; after_inv jsonb;
begin
  if not public.can_manage_invoices() then raise exception using errcode='42501',message='ไม่มีสิทธิ์จัดการ INV'; end if;
  select * into target from public.invoices where id=p_invoice_id for update;
  if not found or target.status<>'active' then raise exception 'INV นี้ยกเลิกไม่ได้'; end if;
  for line in select * from public.dispatch_request_lines where invoice_id=p_invoice_id order by id for update loop
    update public.dispatch_request_lines set invoice_id=null where id=line.id returning to_jsonb(dispatch_request_lines.*) into after_line;
    perform public.log_invoice_change('invoice_lines',line.id::text,'unlink',to_jsonb(line),after_line);
  end loop;
  update public.invoices set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),updated_by=auth.uid(),updated_at=now()
  where id=p_invoice_id returning to_jsonb(invoices.*) into after_inv;
  perform public.log_invoice_change('invoices',p_invoice_id::text,'cancel',to_jsonb(target),after_inv);
  return true;
end $$;

revoke all on function public.create_invoice(text,date,text,uuid[]),public.update_invoice(uuid,text,date,text),public.attach_invoice_lines(uuid,uuid[]),public.detach_invoice_line(uuid),public.mark_line_no_invoice(uuid,text),public.clear_line_no_invoice(uuid),public.cancel_invoice(uuid) from public,anon;
grant execute on function public.create_invoice(text,date,text,uuid[]),public.update_invoice(uuid,text,date,text),public.attach_invoice_lines(uuid,uuid[]),public.detach_invoice_line(uuid),public.mark_line_no_invoice(uuid,text),public.clear_line_no_invoice(uuid),public.cancel_invoice(uuid) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.invoices; exception when duplicate_object then null; end;
end $$;
commit;

-- Migration 17_product_code_cleanup.sql is intentionally excluded from this
-- fresh-install reference because it updates ten reviewed IDs in one specific
-- production dataset. Apply it only to the SWEEO database it was prepared for.
