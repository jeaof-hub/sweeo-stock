-- Existing projects may still have the old staff_role_check ('founder', 'staff').
-- Replace it so invited Editors and Viewers can be saved.
begin;

alter table public.staff drop constraint if exists staff_role_check;
update public.staff set role = 'editor' where role = 'staff';
alter table public.staff add constraint staff_role_check
  check (role in ('founder', 'editor', 'viewer'));

commit;
