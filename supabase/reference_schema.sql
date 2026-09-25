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
