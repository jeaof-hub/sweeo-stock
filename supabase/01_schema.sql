-- =====================================================================
-- SWEEO Stock : Supabase schema
-- รันไฟล์นี้ใน Supabase > SQL Editor เป็นไฟล์แรก (รันซ้ำได้)
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

-- บทบาทของบัญชีปัจจุบันเท่านั้น; NULL เมื่อไม่มีสิทธิ์หรือถูกปิดใช้งาน
create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public
as $$
  select s.role from public.staff s where s.user_id = auth.uid() and s.is_active;
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

-- items: staff อ่าน/เพิ่ม/แก้ได้ ; ไม่มีสิทธิ์ลบ (ใช้ active = false แทน)
drop policy if exists items_read on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
create policy items_read   on public.items for select to authenticated using (public.is_staff());
create policy items_insert on public.items for insert to authenticated with check (public.is_staff());
create policy items_update on public.items for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- movements: staff อ่าน/เพิ่มได้ ; แก้ได้เฉพาะการลบแบบ soft delete ; ไม่มีสิทธิ์ลบจริง
drop policy if exists mv_read on public.movements;
drop policy if exists mv_insert on public.movements;
drop policy if exists mv_update on public.movements;
create policy mv_read   on public.movements for select to authenticated using (public.is_staff());
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
revoke all on function public.my_role() from public;
grant execute on function public.my_role() to authenticated;

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
