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
