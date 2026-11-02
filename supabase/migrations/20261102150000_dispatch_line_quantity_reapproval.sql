-- Require a second approval before an approved dispatch line quantity changes.
begin;

alter table public.dispatch_request_lines
  add column if not exists qty_change_status text,
  add column if not exists qty_change_requested_qty numeric,
  add column if not exists qty_change_reason text,
  add column if not exists qty_change_requested_by uuid references auth.users(id),
  add column if not exists qty_change_requested_at timestamptz,
  add column if not exists qty_change_reviewed_by uuid references auth.users(id),
  add column if not exists qty_change_reviewed_at timestamptz,
  add column if not exists qty_change_rejection_reason text;

alter table public.dispatch_request_lines drop constraint if exists dispatch_line_qty_change_status_check;
alter table public.dispatch_request_lines add constraint dispatch_line_qty_change_status_check check (
  qty_change_status is null or qty_change_status in ('pending','approved','rejected')
);
alter table public.dispatch_request_lines drop constraint if exists dispatch_line_qty_change_qty_check;
alter table public.dispatch_request_lines add constraint dispatch_line_qty_change_qty_check check (
  qty_change_requested_qty is null or
  (qty_change_requested_qty>0 and qty_change_requested_qty=trunc(qty_change_requested_qty))
);
create index if not exists dispatch_line_qty_change_pending_idx
  on public.dispatch_request_lines(qty_change_requested_at) where qty_change_status='pending';

-- Keep every superseded dispatch movement for audit, but allow only one live
-- movement for a dispatch line.
alter table public.movements drop constraint if exists movements_dispatch_request_line_id_key;
create unique index if not exists movements_live_dispatch_line_idx
  on public.movements(dispatch_request_line_id)
  where dispatch_request_line_id is not null and deleted_at is null;

alter table public.stock_audit drop constraint if exists stock_audit_action_check;
alter table public.stock_audit add constraint stock_audit_action_check check (action in (
  'insert','update','delete','soft_delete','link','unlink','cancel','no_invoice','clear_no_invoice','void_line',
  'request_qty_change','approve_qty_change','reject_qty_change'
));

create or replace function public.request_dispatch_line_qty_change(p_line_id uuid,p_new_qty numeric,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare actor_role text; target public.dispatch_request_lines%rowtype; request_row public.dispatch_requests%rowtype; after_line jsonb;
begin
  select role into actor_role from public.staff where user_id=auth.uid() and is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ขอแก้ไขจำนวน';
  end if;
  if p_new_qty is null or p_new_qty<=0 or p_new_qty<>trunc(p_new_qty) then raise exception 'จำนวนใหม่ต้องเป็นจำนวนเต็มบวก'; end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลอย่างน้อย 2 ตัวอักษร'; end if;
  select * into target from public.dispatch_request_lines where id=p_line_id for update;
  if not found then raise exception 'ไม่พบรายการในคำขอเบิก'; end if;
  select * into request_row from public.dispatch_requests where id=target.request_id for update;
  if request_row.status<>'approved' or target.voided_at is not null or target.movement_id is null then raise exception 'แก้จำนวนได้เฉพาะรายการที่อนุมัติแล้ว'; end if;
  if target.invoice_id is not null then raise exception 'กรุณาถอดรายการนี้ออกจาก INV ก่อน'; end if;
  if target.qty_change_status='pending' then raise exception 'รายการนี้กำลังรออนุมัติการแก้จำนวน'; end if;
  if p_new_qty=target.approved_qty then raise exception 'จำนวนใหม่ต้องต่างจากจำนวนปัจจุบัน'; end if;
  if not exists(select 1 from public.movements where id=target.movement_id and deleted_at is null for update) then
    raise exception 'movement ของรายการนี้ไม่อยู่ในสถานะที่แก้ไขได้';
  end if;
  update public.dispatch_request_lines set qty_change_status='pending',qty_change_requested_qty=p_new_qty,
    qty_change_reason=left(trim(p_reason),500),qty_change_requested_by=auth.uid(),qty_change_requested_at=now(),
    qty_change_reviewed_by=null,qty_change_reviewed_at=null,qty_change_rejection_reason=null
  where id=target.id returning to_jsonb(dispatch_request_lines.*) into after_line;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_lines',target.id::text,'request_qty_change',to_jsonb(target),after_line);
  return true;
end $$;

create or replace function public.approve_dispatch_line_qty_change(p_line_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare actor_role text; target public.dispatch_request_lines%rowtype; request_row public.dispatch_requests%rowtype;
  old_movement public.movements%rowtype; new_movement_id uuid; available numeric; after_line jsonb;
begin
  select role into actor_role from public.staff where user_id=auth.uid() and is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์อนุมัติการแก้จำนวน';
  end if;
  select * into target from public.dispatch_request_lines where id=p_line_id for update;
  if not found or target.qty_change_status<>'pending' then raise exception 'รายการนี้ไม่ได้รออนุมัติการแก้จำนวน'; end if;
  if target.qty_change_requested_by=auth.uid() then raise exception using errcode='42501',message='ผู้ขอแก้จำนวนไม่สามารถอนุมัติรายการของตนเอง'; end if;
  select * into request_row from public.dispatch_requests where id=target.request_id for update;
  if request_row.status<>'approved' or target.voided_at is not null then raise exception 'คำขอนี้ไม่อยู่ในสถานะที่อนุมัติได้'; end if;
  if target.invoice_id is not null then raise exception 'กรุณาถอดรายการนี้ออกจาก INV ก่อน'; end if;
  perform 1 from public.items where id=target.item_id for update;
  select * into old_movement from public.movements where id=target.movement_id and deleted_at is null for update;
  if not found then raise exception 'movement ของรายการนี้ไม่อยู่ในสถานะที่แก้ไขได้'; end if;
  update public.movements set deleted_at=now(),deleted_by=auth.uid() where id=old_movement.id;
  select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into available
  from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null
  where i.id=target.item_id group by i.id;
  if target.qty_change_requested_qty>available then raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติจำนวนใหม่'; end if;
  insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,
    created_by,dispatch_request_id,dispatch_request_line_id)
  values(target.item_id,target.code,target.model,request_row.document_date,'out',target.qty_change_requested_qty,
    request_row.customer,request_row.doc_no,request_row.dept,request_row.sale,request_row.note,'request',
    auth.uid(),request_row.id,target.id) returning id into new_movement_id;
  update public.dispatch_request_lines set requested_qty=qty_change_requested_qty,
    approved_qty=qty_change_requested_qty,movement_id=new_movement_id,
    qty_change_status='approved',qty_change_reviewed_by=auth.uid(),qty_change_reviewed_at=now(),qty_change_rejection_reason=null
  where id=target.id returning to_jsonb(dispatch_request_lines.*) into after_line;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_lines',target.id::text,'approve_qty_change',to_jsonb(target),after_line);
  return true;
end $$;

create or replace function public.reject_dispatch_line_qty_change(p_line_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare actor_role text; target public.dispatch_request_lines%rowtype; after_line jsonb;
begin
  select role into actor_role from public.staff where user_id=auth.uid() and is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ปฏิเสธการแก้จำนวน';
  end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลอย่างน้อย 2 ตัวอักษร'; end if;
  select * into target from public.dispatch_request_lines where id=p_line_id for update;
  if not found or target.qty_change_status<>'pending' then raise exception 'รายการนี้ไม่ได้รออนุมัติการแก้จำนวน'; end if;
  if target.qty_change_requested_by=auth.uid() then raise exception using errcode='42501',message='ผู้ขอแก้จำนวนไม่สามารถปฏิเสธรายการของตนเอง'; end if;
  update public.dispatch_request_lines set qty_change_status='rejected',qty_change_reviewed_by=auth.uid(),
    qty_change_reviewed_at=now(),qty_change_rejection_reason=left(trim(p_reason),500)
  where id=target.id returning to_jsonb(dispatch_request_lines.*) into after_line;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_lines',target.id::text,'reject_qty_change',to_jsonb(target),after_line);
  return true;
end $$;

revoke all on function public.request_dispatch_line_qty_change(uuid,numeric,text),
  public.approve_dispatch_line_qty_change(uuid),public.reject_dispatch_line_qty_change(uuid,text) from public,anon;
grant execute on function public.request_dispatch_line_qty_change(uuid,numeric,text),
  public.approve_dispatch_line_qty_change(uuid),public.reject_dispatch_line_qty_change(uuid,text) to authenticated;

-- A pending quantity change cannot be linked to an invoice.
create or replace function public.prevent_voided_dispatch_line_invoice()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.voided_at is not null and (new.invoice_id is not null or nullif(trim(new.no_invoice_reason),'') is not null) then
    raise exception 'รายการนี้ถูกลบจากคำขอเบิกแล้ว';
  end if;
  if new.qty_change_status='pending' and new.invoice_id is not null then
    raise exception 'รายการนี้กำลังรออนุมัติการแก้จำนวน';
  end if;
  return new;
end $$;

create or replace function public.prevent_pending_qty_change_void()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.qty_change_status='pending' and new.voided_at is not null then
    raise exception 'กรุณาอนุมัติหรือปฏิเสธการแก้จำนวนก่อนลบรายการ';
  end if;
  return new;
end $$;
drop trigger if exists dispatch_line_pending_qty_void_guard on public.dispatch_request_lines;
create trigger dispatch_line_pending_qty_void_guard before update of voided_at
on public.dispatch_request_lines for each row execute function public.prevent_pending_qty_change_void();
revoke all on function public.prevent_pending_qty_change_void() from public;

-- Production-safe smoke tests. Every mutation is rolled back inside a
-- subtransaction; any incorrect permission or stock delta aborts migration.
do $$
declare candidate record; requester uuid; reviewer uuid; forbidden uuid; old_balance numeric; after_balance numeric; rejected boolean;
begin
  select l.id,l.item_id,l.approved_qty,l.invoice_id into candidate
  from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
  join public.movements m on m.id=l.movement_id and m.deleted_at is null
  where r.status='approved' and l.voided_at is null and l.invoice_id is null and l.qty_change_status is distinct from 'pending'
  order by r.created_at,l.id limit 1;
  select user_id into requester from public.staff where role in ('admin','owner','founder') and is_active order by role limit 1;
  select user_id into reviewer from public.staff where role in ('founder','owner','admin') and is_active and user_id<>requester order by role desc limit 1;
  if candidate.id is null or requester is null or reviewer is null then
    raise notice 'SWEEO_QTY_REAPPROVAL_TEST=SKIP(no candidate or two active managers)'; return;
  end if;
  begin
    perform set_config('request.jwt.claim.sub',requester::text,true);
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into old_balance
    from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=candidate.item_id group by i.id;
    perform public.request_dispatch_line_qty_change(candidate.id,candidate.approved_qty+1,'production rollback test');
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into after_balance
    from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=candidate.item_id group by i.id;
    if after_balance<>old_balance then raise exception 'request changed stock before approval'; end if;
    rejected:=false;
    begin perform public.approve_dispatch_line_qty_change(candidate.id); exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'requester approved own quantity change'; end if;
    perform set_config('request.jwt.claim.sub',reviewer::text,true);
    perform public.approve_dispatch_line_qty_change(candidate.id);
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into after_balance
    from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=candidate.item_id group by i.id;
    if after_balance<>old_balance-1 then raise exception 'approved quantity stock delta mismatch'; end if;
    raise exception 'SWEEO_ROLLBACK_QTY_APPROVAL';
  exception when raise_exception then
    if sqlerrm<>'SWEEO_ROLLBACK_QTY_APPROVAL' then raise; end if;
    raise notice 'SWEEO_QTY_REAPPROVAL_TEST=PASS';
  end;
  foreach forbidden in array array[
    (select user_id from public.staff where role='warehouse' and is_active limit 1),
    (select user_id from public.staff where role='auditor' and is_active limit 1)
  ] loop
    if forbidden is null then continue; end if;
    perform set_config('request.jwt.claim.sub',forbidden::text,true); rejected:=false;
    begin perform public.request_dispatch_line_qty_change(candidate.id,candidate.approved_qty+1,'forbidden rollback test');
    exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'forbidden role requested quantity change'; end if;
  end loop;
end $$;

commit;
