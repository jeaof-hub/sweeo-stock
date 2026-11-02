-- Void one approved dispatch line atomically while preserving its audit history.
begin;

alter table public.dispatch_request_lines
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id),
  add column if not exists void_reason text;
create index if not exists dispatch_lines_active_request_idx
  on public.dispatch_request_lines(request_id) where voided_at is null;

alter table public.dispatch_request_lines drop constraint if exists dispatch_lines_void_state_check;
alter table public.dispatch_request_lines add constraint dispatch_lines_void_state_check check (
  (voided_at is null and voided_by is null and void_reason is null) or
  (voided_at is not null and voided_by is not null and length(trim(void_reason))>=2)
);

alter table public.stock_audit drop constraint if exists stock_audit_entity_check;
alter table public.stock_audit add constraint stock_audit_entity_check
  check (entity in ('items','movements','invoices','invoice_lines','dispatch_lines'));
alter table public.stock_audit drop constraint if exists stock_audit_action_check;
alter table public.stock_audit add constraint stock_audit_action_check
  check (action in ('insert','update','delete','soft_delete','link','unlink','cancel','no_invoice','clear_no_invoice','void_line'));

create or replace function public.soft_delete_movement(p_movement_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.movements%rowtype;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='กรุณาเข้าสู่ระบบ'; end if;
  select * into target from public.movements where id=p_movement_id for update;
  if not found or target.deleted_at is not null or not public.can_delete_movement(target.created_by,target.created_at) then
    raise exception using errcode='42501',message='ไม่พบรายการหรือไม่มีสิทธิ์ลบรายการนี้';
  end if;
  if target.dispatch_request_line_id is not null then
    raise exception using errcode='42501',message='รายการนี้มาจากคำขอเบิก กรุณาลบจากหน้าใบส่งของ';
  end if;
  update public.movements set deleted_at=now(),deleted_by=auth.uid() where id=target.id;
  return true;
end $$;
revoke all on function public.soft_delete_movement(uuid) from public,anon;
grant execute on function public.soft_delete_movement(uuid) to authenticated;

create or replace function public.void_dispatch_line(p_line_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare
  actor_role text; target public.dispatch_request_lines%rowtype; request_row public.dispatch_requests%rowtype;
  movement_row public.movements%rowtype; after_line jsonb; remaining integer;
begin
  select s.role into actor_role from public.staff s where s.user_id=auth.uid() and s.is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ลบรายการจากคำขอเบิก';
  end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลอย่างน้อย 2 ตัวอักษร'; end if;

  select * into target from public.dispatch_request_lines where id=p_line_id for update;
  if not found then raise exception 'ไม่พบรายการในคำขอเบิก'; end if;
  if target.voided_at is not null then raise exception 'รายการนี้ถูกลบไปแล้ว'; end if;
  select * into request_row from public.dispatch_requests where id=target.request_id for update;
  if request_row.status<>'approved' then raise exception 'ลบได้เฉพาะรายการในคำขอที่อนุมัติแล้ว'; end if;
  if target.invoice_id is not null then raise exception 'กรุณาถอดรายการนี้ออกจาก INV ก่อน'; end if;

  select * into movement_row from public.movements
  where id=target.movement_id and dispatch_request_line_id=target.id for update;
  if not found or movement_row.deleted_at is not null then
    raise exception 'movement ของรายการนี้ไม่อยู่ในสถานะที่ลบได้';
  end if;

  update public.movements set deleted_at=now(),deleted_by=auth.uid() where id=movement_row.id;
  update public.dispatch_request_lines set
    voided_at=now(),voided_by=auth.uid(),void_reason=left(trim(p_reason),500),
    no_invoice_reason=null,no_invoice_by=null,no_invoice_at=null
  where id=target.id returning to_jsonb(dispatch_request_lines.*) into after_line;

  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_lines',target.id::text,'void_line',to_jsonb(target),after_line);

  select count(*) into remaining from public.dispatch_request_lines
  where request_id=target.request_id and voided_at is null;
  if remaining=0 then update public.dispatch_requests set status='cancelled',updated_at=now() where id=target.request_id; end if;
  return true;
end $$;
revoke all on function public.void_dispatch_line(uuid,text) from public,anon;
grant execute on function public.void_dispatch_line(uuid,text) to authenticated;

create or replace function public.prevent_voided_dispatch_line_invoice()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.voided_at is not null and (new.invoice_id is not null or nullif(trim(new.no_invoice_reason),'') is not null) then
    raise exception 'รายการนี้ถูกลบจากคำขอเบิกแล้ว';
  end if;
  return new;
end $$;
drop trigger if exists dispatch_line_void_invoice_guard on public.dispatch_request_lines;
create trigger dispatch_line_void_invoice_guard before insert or update of invoice_id,no_invoice_reason,voided_at
on public.dispatch_request_lines for each row execute function public.prevent_voided_dispatch_line_invoice();
revoke all on function public.prevent_voided_dispatch_line_invoice() from public;

create or replace function public.line_pending_dispatch_requests(p_actor uuid)
returns table(id uuid,delivery_note_no text,customer text,requester_name text,line_count bigint,total_qty numeric,created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select r.id,r.delivery_note_no,r.customer,coalesce(s.name,'–'),count(l.id),coalesce(sum(l.requested_qty),0),r.created_at
  from public.dispatch_requests r
  join public.staff actor on actor.user_id=p_actor and actor.is_active and actor.role in ('admin','owner','founder')
  left join public.staff s on s.user_id=r.requester_id
  join public.dispatch_request_lines l on l.request_id=r.id and l.voided_at is null
  where r.status='pending' and r.requester_id<>p_actor and public.can_review_dispatch_as(p_actor,r.requester_role)
  group by r.id,r.delivery_note_no,r.customer,s.name,r.created_at order by r.created_at desc limit 10;
$$;
revoke all on function public.line_pending_dispatch_requests(uuid) from public,anon,authenticated;
grant execute on function public.line_pending_dispatch_requests(uuid) to service_role;

create or replace function public.dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller_role text;
  bangkok_today date := timezone('Asia/Bangkok', now())::date;
  week_start date;
  month_start date;
  result jsonb;
begin
  select s.role into caller_role
  from public.staff s
  where s.user_id = auth.uid() and s.is_active;

  if caller_role is null or caller_role not in ('founder','owner','admin','warehouse','auditor') then
    raise exception using errcode='42501', message='ไม่มีสิทธิ์ดู Dashboard';
  end if;

  week_start := date_trunc('week', bangkok_today::timestamp)::date;
  month_start := date_trunc('month', bangkok_today::timestamp)::date;

  with balances as (
    select i.id, i.code, i.model, i.spec, i.rop, i.sort_order,
      i.opening + coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) as balance
    from public.items i
    left join public.movements m on m.item_id=i.id and m.deleted_at is null
    where i.active
    group by i.id
  ), reorder_rows as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'model', b.model, 'spec', b.spec,
      'balance', b.balance, 'rop', b.rop,
      'severity', case when b.balance<=b.rop then 'red' else 'amber' end
    ) order by (b.balance/nullif(b.rop,0)), b.sort_order, b.id), '[]'::jsonb) value
    from balances b
    where b.rop is not null and b.rop>0 and b.balance<=b.rop*1.3
  ), top_rows as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', ranked.item_id, 'code', ranked.code, 'model', ranked.model,
      'qty', ranked.qty
    ) order by ranked.qty desc, ranked.item_id), '[]'::jsonb) value
    from (
      select m.item_id, coalesce(nullif(i.code,''),m.code) code,
        coalesce(nullif(i.model,''),m.model) model, sum(m.qty) qty
      from public.movements m
      left join public.items i on i.id=m.item_id
      where m.deleted_at is null and m.kind='out'
        and lower(trim(coalesce(m.source,'')))<>'adjustment'
        and lower(trim(coalesce(m.dept,'')))<>'stock adjust'
        and m.date>=month_start and m.date<month_start+interval '1 month'
      group by m.item_id, coalesce(nullif(i.code,''),m.code), coalesce(nullif(i.model,''),m.model)
      order by sum(m.qty) desc, m.item_id
      limit 5
    ) ranked
  )
  select jsonb_build_object(
    'as_of', bangkok_today,
    'week_start', week_start,
    'month_start', month_start,
    'reorder_items', reorder_rows.value,
    'pending_approval_count', (
      select count(*) from public.dispatch_requests r
      where r.status='pending' and r.requester_id<>auth.uid()
        and case
          when caller_role='admin' then r.requester_role='warehouse'
          when caller_role in ('owner','founder') then r.requester_role in ('warehouse','admin')
          else false
        end
    ),
    'invoice_waiting_count', case when caller_role in ('admin','owner','founder') then (
      select count(*) from public.dispatch_request_lines l
      join public.dispatch_requests r on r.id=l.request_id
      where r.status='approved' and l.voided_at is null and l.invoice_id is null
        and nullif(trim(l.no_invoice_reason),'') is null
    ) else null end,
    'weekly_out_qty', (
      select coalesce(sum(m.qty),0) from public.movements m
      where m.deleted_at is null and m.kind='out'
        and lower(trim(coalesce(m.source,'')))<>'adjustment'
        and lower(trim(coalesce(m.dept,'')))<>'stock adjust'
        and m.date>=week_start and m.date<week_start+7
    ),
    'monthly_top_items', top_rows.value
  ) into result
  from reorder_rows, top_rows;

  return result;
end $$;


revoke all on function public.dashboard_summary() from public,anon;
grant execute on function public.dashboard_summary() to authenticated;


do $$
declare baseline jsonb; mismatches jsonb;
begin
  select jsonb_build_object(
    'items',(select count(*) from public.items where active),
    'live_movements',(select count(*) from public.movements where deleted_at is null),
    'total_balance',(select coalesce(sum(balance),0) from (
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) balance
      from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.active group by i.id
    ) balances),
    'dispatch_requests',(select count(*) from public.dispatch_requests),
    'dispatch_lines',(select count(*) from public.dispatch_request_lines),
    'audit_rows',(select count(*) from public.stock_audit)
  ) into baseline;
  select coalesce(jsonb_agg(jsonb_build_object(
    'line_id',l.id,'request_id',r.id,'delivery_note_no',r.delivery_note_no,'item_id',l.item_id,
    'qty',coalesce(l.approved_qty,l.requested_qty),'movement_id',m.id,'movement_deleted_at',m.deleted_at
  ) order by r.created_at,l.id),'[]'::jsonb) into mismatches
  from public.dispatch_request_lines l
  join public.dispatch_requests r on r.id=l.request_id
  join public.movements m on m.id=l.movement_id
  where r.status='approved' and l.voided_at is null and m.deleted_at is not null;
  raise notice 'SWEEO_VOID_BASELINE=%',baseline;
  raise notice 'SWEEO_VOID_OLD_MISMATCHES=%',mismatches;
end $$;

do $$
declare
  candidate record; inv_candidate record; single_candidate record; actor uuid; role_name text;
  before_balance numeric; after_balance numeric; rejected boolean;
begin
  select l.id line_id,l.item_id,l.movement_id,coalesce(l.approved_qty,l.requested_qty) qty,l.request_id
  into candidate from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
  join public.movements m on m.id=l.movement_id and m.deleted_at is null
  where r.status='approved' and l.voided_at is null and l.invoice_id is null order by r.created_at,l.id limit 1;
  if candidate.line_id is null then raise notice 'SWEEO_VOID_TEST=no eligible active line; role and stock rollback tests skipped'; return; end if;

  foreach role_name in array array['founder','owner','admin','warehouse','auditor'] loop
    select user_id into actor from public.staff where role=role_name and is_active order by user_id limit 1;
    if actor is null then raise notice 'SWEEO_VOID_ROLE_TEST role=% result=SKIP(no active account)',role_name; continue; end if;
    perform set_config('request.jwt.claim.sub',actor::text,true);
    if role_name in ('founder','owner','admin') then
      begin
        select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into before_balance
        from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=candidate.item_id group by i.id;
        perform public.void_dispatch_line(candidate.line_id,'production rollback test');
        select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into after_balance
        from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=candidate.item_id group by i.id;
        if after_balance<>before_balance+candidate.qty then raise exception 'stock restoration mismatch'; end if;
        raise exception 'SWEEO_ROLLBACK_ALLOWED';
      exception when raise_exception then
        if sqlerrm<>'SWEEO_ROLLBACK_ALLOWED' then raise; end if;
        raise notice 'SWEEO_VOID_ROLE_TEST role=% result=PASS stock_delta=%',role_name,candidate.qty;
      end;
    else
      rejected:=false;
      begin
        perform public.void_dispatch_line(candidate.line_id,'production rollback test');
      exception when insufficient_privilege then rejected:=true;
      end;
      if not rejected then raise exception 'forbidden role % was able to void',role_name; end if;
      raise notice 'SWEEO_VOID_ROLE_TEST role=% result=PASS(42501)',role_name;
    end if;
  end loop;

  select user_id into actor from public.staff where role='founder' and is_active limit 1;
  if actor is not null then
    perform set_config('request.jwt.claim.sub',actor::text,true);
    begin
      perform public.void_dispatch_line(candidate.line_id,'duplicate rollback test');
      rejected:=false;
      begin perform public.void_dispatch_line(candidate.line_id,'duplicate rollback test');
      exception when others then if sqlerrm='รายการนี้ถูกลบไปแล้ว' then rejected:=true; else raise; end if; end;
      if not rejected then raise exception 'duplicate void was not rejected'; end if;
      raise exception 'SWEEO_ROLLBACK_DUPLICATE';
    exception when raise_exception then
      if sqlerrm<>'SWEEO_ROLLBACK_DUPLICATE' then raise; end if;
      raise notice 'SWEEO_VOID_DUPLICATE_TEST=PASS';
    end;

    rejected:=false;
    begin perform public.soft_delete_movement(candidate.movement_id);
    exception when insufficient_privilege then
      if sqlerrm='รายการนี้มาจากคำขอเบิก กรุณาลบจากหน้าใบส่งของ' then rejected:=true; else raise; end if;
    end;
    if not rejected then raise exception 'dispatch movement direct delete was not rejected'; end if;
    raise notice 'SWEEO_VOID_DIRECT_MOVEMENT_TEST=PASS(42501)';

    select l.id line_id into inv_candidate from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
    join public.movements m on m.id=l.movement_id and m.deleted_at is null
    where r.status='approved' and l.voided_at is null and l.invoice_id is not null limit 1;
    if inv_candidate.line_id is null then raise notice 'SWEEO_VOID_INVOICE_TEST=SKIP(no linked active line)';
    else
      rejected:=false;
      begin perform public.void_dispatch_line(inv_candidate.line_id,'invoice rollback test');
      exception when others then if sqlerrm='กรุณาถอดรายการนี้ออกจาก INV ก่อน' then rejected:=true; else raise; end if; end;
      if not rejected then raise exception 'invoice-linked line was not rejected'; end if;
      raise notice 'SWEEO_VOID_INVOICE_TEST=PASS';
    end if;

    select l.id line_id,l.request_id into single_candidate
    from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
    join public.movements m on m.id=l.movement_id and m.deleted_at is null
    where r.status='approved' and l.voided_at is null and l.invoice_id is null
      and (select count(*) from public.dispatch_request_lines x where x.request_id=l.request_id and x.voided_at is null)=1 limit 1;
    if single_candidate.line_id is null then raise notice 'SWEEO_VOID_CANCEL_TEST=SKIP(no single-line active request)';
    else
      begin
        perform public.void_dispatch_line(single_candidate.line_id,'cancel rollback test');
        if (select status from public.dispatch_requests where id=single_candidate.request_id)<>'cancelled' then raise exception 'request was not cancelled'; end if;
        raise exception 'SWEEO_ROLLBACK_CANCEL';
      exception when raise_exception then
        if sqlerrm<>'SWEEO_ROLLBACK_CANCEL' then raise; end if;
        raise notice 'SWEEO_VOID_CANCEL_TEST=PASS';
      end;
    end if;
  end if;
end $$;

do $$
declare after_values jsonb;
begin
  select jsonb_build_object(
    'items',(select count(*) from public.items where active),
    'live_movements',(select count(*) from public.movements where deleted_at is null),
    'total_balance',(select coalesce(sum(balance),0) from (
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) balance
      from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.active group by i.id
    ) balances),
    'dispatch_requests',(select count(*) from public.dispatch_requests),
    'dispatch_lines',(select count(*) from public.dispatch_request_lines),
    'audit_rows',(select count(*) from public.stock_audit)
  ) into after_values;
  raise notice 'SWEEO_VOID_AFTER_ROLLBACK=%',after_values;
end $$;

commit;
