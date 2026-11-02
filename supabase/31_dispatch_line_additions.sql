-- Add a product to an approved dispatch request through a second approval.
-- The proposal never touches stock; approval creates the line and its movement atomically.
-- Safe to run repeatedly. Requires 29_void_dispatch_lines.sql and 30_dispatch_line_quantity_reapproval.sql.
begin;

-- 1. A voided line keeps its row for audit, so uniqueness applies to active lines only.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select c.conname from pg_constraint c
    where c.conrelid='public.dispatch_request_lines'::regclass and c.contype='u'
      and (select array_agg(a.attname::text order by a.attname) from unnest(c.conkey) k
           join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k)=array['item_id','request_id']
  loop
    execute format('alter table public.dispatch_request_lines drop constraint %I',constraint_name);
  end loop;
end $$;
create unique index if not exists dispatch_lines_active_item_idx
  on public.dispatch_request_lines(request_id,item_id) where voided_at is null;

-- 2. Proposals to add a product to an approved request.
create table if not exists public.dispatch_line_additions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.dispatch_requests(id) on delete cascade,
  item_id text not null references public.items(id),
  qty numeric not null check (qty>0 and qty=trunc(qty)),
  purpose text not null default 'sale' check (purpose in ('sale','gift','claim','other')),
  return_required boolean not null default false,
  line_note text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  line_id uuid references public.dispatch_request_lines(id),
  constraint dispatch_line_additions_review_check check (
    (status='pending' and reviewed_by is null and reviewed_at is null and line_id is null) or
    (status='approved' and reviewed_by is not null and reviewed_at is not null and line_id is not null) or
    (status='rejected' and reviewed_by is not null and reviewed_at is not null and length(trim(coalesce(rejection_reason,'')))>=2) or
    (status='cancelled' and reviewed_by is not null and reviewed_at is not null)
  )
);
create unique index if not exists dispatch_line_additions_pending_item_idx
  on public.dispatch_line_additions(request_id,item_id) where status='pending';
create index if not exists dispatch_line_additions_request_idx on public.dispatch_line_additions(request_id,requested_at desc);

alter table public.dispatch_line_additions enable row level security;
revoke all on public.dispatch_line_additions from public,anon,authenticated;
grant select on public.dispatch_line_additions to authenticated;
drop policy if exists dispatch_line_additions_read on public.dispatch_line_additions;
create policy dispatch_line_additions_read on public.dispatch_line_additions for select to authenticated using (
  exists (select 1 from public.dispatch_requests r where r.id=request_id and (
    public.has_role(array['admin','owner','founder'])
    or (public.has_role(array['warehouse']) and r.requester_id=auth.uid())
  ))
);

-- 3. Change log vocabulary.
alter table public.stock_audit drop constraint if exists stock_audit_entity_check;
alter table public.stock_audit add constraint stock_audit_entity_check
  check (entity in ('items','movements','invoices','invoice_lines','dispatch_lines','dispatch_line_additions'));
alter table public.stock_audit drop constraint if exists stock_audit_action_check;
alter table public.stock_audit add constraint stock_audit_action_check check (action in (
  'insert','update','delete','soft_delete','link','unlink','cancel','no_invoice','clear_no_invoice','void_line',
  'request_qty_change','approve_qty_change','reject_qty_change',
  'request_add_line','approve_add_line','reject_add_line','cancel_add_line'
));

-- 4. RPCs.
create or replace function public.request_dispatch_line_addition(
  p_request_id uuid,p_item_id text,p_qty numeric,p_purpose text,p_return_required boolean,p_line_note text
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare actor_role text; request_row public.dispatch_requests%rowtype; new_id uuid; purpose_value text;
begin
  select role into actor_role from public.staff where user_id=auth.uid() and is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์เพิ่มสินค้าในใบที่อนุมัติแล้ว';
  end if;
  if p_qty is null or p_qty<=0 or p_qty<>trunc(p_qty) then raise exception 'จำนวนต้องเป็นจำนวนเต็มบวก'; end if;
  purpose_value:=coalesce(nullif(trim(p_purpose),''),'sale');
  if purpose_value not in ('sale','gift','claim','other') then raise exception 'วัตถุประสงค์ไม่ถูกต้อง'; end if;
  select * into request_row from public.dispatch_requests where id=p_request_id for update;
  if not found or request_row.status<>'approved' then raise exception 'เพิ่มสินค้าได้เฉพาะใบที่อนุมัติแล้ว'; end if;
  if not exists(select 1 from public.items where id=p_item_id and active) then raise exception 'ไม่พบสินค้าหรือสินค้าถูกปิดใช้งาน'; end if;
  if exists(select 1 from public.dispatch_request_lines where request_id=p_request_id and item_id=p_item_id and voided_at is null) then
    raise exception 'สินค้านี้มีอยู่ในใบแล้ว หากต้องการเปลี่ยนจำนวนให้ใช้ "แก้ไขจำนวน"';
  end if;
  if exists(select 1 from public.dispatch_line_additions where request_id=p_request_id and item_id=p_item_id and status='pending') then
    raise exception 'สินค้านี้กำลังรออนุมัติการเพิ่มในใบนี้อยู่แล้ว';
  end if;
  insert into public.dispatch_line_additions(request_id,item_id,qty,purpose,return_required,line_note,requested_by)
  values(p_request_id,p_item_id,p_qty,purpose_value,coalesce(p_return_required,false),left(trim(coalesce(p_line_note,'')),300),auth.uid())
  returning id into new_id;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  select auth.uid(),'dispatch_line_additions',new_id::text,'request_add_line',null,
    to_jsonb(a)||jsonb_build_object('delivery_note_no',request_row.delivery_note_no,'code',i.code,'model',i.model)
  from public.dispatch_line_additions a join public.items i on i.id=a.item_id where a.id=new_id;
  return new_id;
end $$;

create or replace function public.approve_dispatch_line_addition(p_addition_id uuid)
returns uuid language plpgsql volatile security definer set search_path=public as $$
declare actor_role text; target public.dispatch_line_additions%rowtype; request_row public.dispatch_requests%rowtype;
  item_row public.items%rowtype; available numeric; new_line_id uuid; new_movement_id uuid; after_row jsonb;
begin
  select role into actor_role from public.staff where user_id=auth.uid() and is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์อนุมัติการเพิ่มสินค้า';
  end if;
  select * into target from public.dispatch_line_additions where id=p_addition_id for update;
  if not found or target.status<>'pending' then raise exception 'รายการนี้ไม่ได้รออนุมัติการเพิ่มสินค้า'; end if;
  if target.requested_by=auth.uid() then
    raise exception using errcode='42501',message='ผู้เพิ่มสินค้าไม่สามารถอนุมัติรายการของตนเอง';
  end if;
  select * into request_row from public.dispatch_requests where id=target.request_id for update;
  if request_row.status<>'approved' then raise exception 'ใบนี้ไม่อยู่ในสถานะที่เพิ่มสินค้าได้'; end if;
  select * into item_row from public.items where id=target.item_id and active for update;
  if not found then raise exception 'ไม่พบสินค้าหรือสินค้าถูกปิดใช้งาน'; end if;
  if exists(select 1 from public.dispatch_request_lines where request_id=target.request_id and item_id=target.item_id and voided_at is null) then
    raise exception 'สินค้านี้มีอยู่ในใบแล้ว หากต้องการเปลี่ยนจำนวนให้ใช้ "แก้ไขจำนวน"';
  end if;
  select item_row.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into available
  from public.movements m where m.item_id=target.item_id and m.deleted_at is null;
  if target.qty>available then
    raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติการเพิ่มสินค้า';
  end if;

  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty,approved_qty,purpose,return_required,line_note)
  values(target.request_id,target.item_id,item_row.code,item_row.model,target.qty,target.qty,target.purpose,target.return_required,target.line_note)
  returning id into new_line_id;
  insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,
    created_by,dispatch_request_id,dispatch_request_line_id)
  values(target.item_id,item_row.code,item_row.model,request_row.document_date,'out',target.qty,
    request_row.customer,request_row.doc_no,request_row.dept,request_row.sale,request_row.note,'request',
    auth.uid(),request_row.id,new_line_id) returning id into new_movement_id;
  update public.dispatch_request_lines set movement_id=new_movement_id where id=new_line_id;
  update public.dispatch_line_additions set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),line_id=new_line_id
  where id=target.id returning to_jsonb(dispatch_line_additions.*) into after_row;
  update public.dispatch_requests set updated_at=now() where id=request_row.id;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_line_additions',target.id::text,'approve_add_line',to_jsonb(target),
    after_row||jsonb_build_object('delivery_note_no',request_row.delivery_note_no,'code',item_row.code,'model',item_row.model,'movement_id',new_movement_id));
  return new_line_id;
end $$;

create or replace function public.reject_dispatch_line_addition(p_addition_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare actor_role text; target public.dispatch_line_additions%rowtype; after_row jsonb;
begin
  select role into actor_role from public.staff where user_id=auth.uid() and is_active;
  if actor_role is null or actor_role not in ('founder','owner','admin') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ปฏิเสธการเพิ่มสินค้า';
  end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลอย่างน้อย 2 ตัวอักษร'; end if;
  select * into target from public.dispatch_line_additions where id=p_addition_id for update;
  if not found or target.status<>'pending' then raise exception 'รายการนี้ไม่ได้รออนุมัติการเพิ่มสินค้า'; end if;
  if target.requested_by=auth.uid() then
    raise exception using errcode='42501',message='ผู้เพิ่มสินค้าไม่สามารถปฏิเสธรายการของตนเอง ให้ใช้ยกเลิกแทน';
  end if;
  update public.dispatch_line_additions set status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),
    rejection_reason=left(trim(p_reason),500)
  where id=target.id returning to_jsonb(dispatch_line_additions.*) into after_row;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_line_additions',target.id::text,'reject_add_line',to_jsonb(target),after_row);
  return true;
end $$;

create or replace function public.cancel_dispatch_line_addition(p_addition_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_line_additions%rowtype; after_row jsonb;
begin
  if not exists(select 1 from public.staff where user_id=auth.uid() and is_active and role in ('founder','owner','admin')) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ยกเลิกการเพิ่มสินค้า';
  end if;
  select * into target from public.dispatch_line_additions where id=p_addition_id for update;
  if not found or target.status<>'pending' then raise exception 'รายการนี้ไม่ได้รออนุมัติการเพิ่มสินค้า'; end if;
  if target.requested_by<>auth.uid() then
    raise exception using errcode='42501',message='ยกเลิกได้เฉพาะรายการที่ตนเองเพิ่ม';
  end if;
  update public.dispatch_line_additions set status='cancelled',reviewed_by=auth.uid(),reviewed_at=now()
  where id=target.id returning to_jsonb(dispatch_line_additions.*) into after_row;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_line_additions',target.id::text,'cancel_add_line',to_jsonb(target),after_row);
  return true;
end $$;

revoke all on function public.request_dispatch_line_addition(uuid,text,numeric,text,boolean,text),
  public.approve_dispatch_line_addition(uuid),public.reject_dispatch_line_addition(uuid,text),
  public.cancel_dispatch_line_addition(uuid) from public,anon;
grant execute on function public.request_dispatch_line_addition(uuid,text,numeric,text,boolean,text),
  public.approve_dispatch_line_addition(uuid),public.reject_dispatch_line_addition(uuid,text),
  public.cancel_dispatch_line_addition(uuid) to authenticated;

-- 5. While a request has any pending revision (addition or quantity change), its INV state is frozen.
create or replace function public.guard_dispatch_invoice_during_revision()
returns trigger language plpgsql set search_path=public as $$
begin
  if (new.invoice_id is distinct from old.invoice_id or new.no_invoice_reason is distinct from old.no_invoice_reason)
     and (exists(select 1 from public.dispatch_line_additions a where a.request_id=new.request_id and a.status='pending')
       or exists(select 1 from public.dispatch_request_lines l where l.request_id=new.request_id
                 and l.voided_at is null and l.qty_change_status='pending')) then
    raise exception 'ใบนี้มีรายการแก้ไขรออนุมัติ จึงยังจัดการ INV ไม่ได้';
  end if;
  return new;
end $$;
drop trigger if exists dispatch_line_revision_invoice_guard on public.dispatch_request_lines;
create trigger dispatch_line_revision_invoice_guard before update of invoice_id,no_invoice_reason
on public.dispatch_request_lines for each row execute function public.guard_dispatch_invoice_during_revision();
revoke all on function public.guard_dispatch_invoice_during_revision() from public;

-- 6. Pending additions reserve stock in "available to dispatch", like pending requests.
create or replace function public.dispatch_pending_totals()
returns table(item_id text,pending_qty numeric)
language sql stable security definer set search_path=public
as $$
  select x.item_id,sum(x.qty) from (
    select l.item_id,l.requested_qty qty
    from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id
    where r.status='pending'
    union all
    select a.item_id,a.qty from public.dispatch_line_additions a join public.dispatch_requests r on r.id=a.request_id
    where a.status='pending' and r.status='approved'
  ) x where public.is_reader()
  group by x.item_id;
$$;
revoke all on function public.dispatch_pending_totals() from public;
grant execute on function public.dispatch_pending_totals() to authenticated;

create or replace function public.dispatch_available(p_item_id text)
returns numeric language sql stable security definer set search_path=public
as $$
  select i.opening
    + coalesce((select sum(case when m.kind='in' then m.qty else -m.qty end) from public.movements m where m.item_id=i.id and m.deleted_at is null),0)
    - coalesce((select sum(l.requested_qty) from public.dispatch_request_lines l join public.dispatch_requests r on r.id=l.request_id where l.item_id=i.id and r.status='pending'),0)
    - coalesce((select sum(a.qty) from public.dispatch_line_additions a join public.dispatch_requests r on r.id=a.request_id where a.item_id=i.id and a.status='pending' and r.status='approved'),0)
  from public.items i where i.id=p_item_id and i.active;
$$;
revoke all on function public.dispatch_available(text) from public;
grant execute on function public.dispatch_available(text) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.dispatch_line_additions;
  exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- 7. Production-safe smoke tests. Every write is rolled back; any wrong permission or
-- stock delta aborts the whole migration.
do $$
declare
  baseline jsonb; after_values jsonb; candidate record; spare_item record; adder uuid; reviewer uuid; forbidden uuid;
  addition_id uuid; new_line uuid; before_balance numeric; after_balance numeric; rejected boolean; role_name text;
begin
  select jsonb_build_object(
    'live_movements',(select count(*) from public.movements where deleted_at is null),
    'total_balance',(select coalesce(sum(balance),0) from (
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) balance
      from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.active group by i.id) b),
    'dispatch_lines',(select count(*) from public.dispatch_request_lines),
    'additions',(select count(*) from public.dispatch_line_additions),
    'audit_rows',(select count(*) from public.stock_audit)
  ) into baseline;
  raise notice 'SWEEO_ADD_LINE_BASELINE=%',baseline;

  select r.id request_id,r.delivery_note_no into candidate from public.dispatch_requests r
  where r.status='approved' and exists(select 1 from public.dispatch_request_lines l where l.request_id=r.id and l.voided_at is null)
  order by r.created_at desc limit 1;
  select i.id,(i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0)) balance into spare_item
  from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null
  where i.active and candidate.request_id is not null
    and not exists(select 1 from public.dispatch_request_lines l where l.request_id=candidate.request_id and l.item_id=i.id and l.voided_at is null)
  group by i.id having i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0)>=2
  order by i.id limit 1;
  select user_id into adder from public.staff where role in ('founder','owner','admin') and is_active order by role,user_id limit 1;
  select user_id into reviewer from public.staff where role in ('founder','owner','admin') and is_active and user_id<>adder order by role desc,user_id limit 1;
  if candidate.request_id is null or spare_item.id is null or adder is null or reviewer is null then
    raise notice 'SWEEO_ADD_LINE_TEST=SKIP(no approved request, spare item or two active managers)'; return;
  end if;

  -- Full lifecycle: propose, self-approval blocked, INV frozen, approve, stock delta, duplicate blocked.
  begin
    perform set_config('request.jwt.claim.sub',adder::text,true);
    before_balance:=spare_item.balance;
    addition_id:=public.request_dispatch_line_addition(candidate.request_id,spare_item.id,1,'sale',false,'rollback test');
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into after_balance
    from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=spare_item.id group by i.id;
    if after_balance<>before_balance then raise exception 'proposal changed stock'; end if;

    rejected:=false;
    begin perform public.request_dispatch_line_addition(candidate.request_id,spare_item.id,1,'sale',false,'dup');
    exception when others then if sqlerrm='สินค้านี้กำลังรออนุมัติการเพิ่มในใบนี้อยู่แล้ว' then rejected:=true; else raise; end if; end;
    if not rejected then raise exception 'duplicate pending addition accepted'; end if;

    rejected:=false;
    begin perform public.approve_dispatch_line_addition(addition_id);
    exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'adder approved own addition'; end if;

    rejected:=false;
    begin
      update public.dispatch_request_lines set no_invoice_reason='rollback test',no_invoice_by=adder,no_invoice_at=now(),purpose='gift'
      where id=(select id from public.dispatch_request_lines where request_id=candidate.request_id and voided_at is null
                and invoice_id is null and no_invoice_reason is null limit 1);
      if not found then rejected:=true; end if;
    exception when others then if sqlerrm='ใบนี้มีรายการแก้ไขรออนุมัติ จึงยังจัดการ INV ไม่ได้' then rejected:=true; else raise; end if; end;
    if not rejected then raise exception 'INV change allowed during pending addition'; end if;

    perform set_config('request.jwt.claim.sub',reviewer::text,true);
    new_line:=public.approve_dispatch_line_addition(addition_id);
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into after_balance
    from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=spare_item.id group by i.id;
    if after_balance<>before_balance-1 then raise exception 'approved addition stock delta mismatch'; end if;
    if not exists(select 1 from public.dispatch_request_lines l join public.movements m on m.id=l.movement_id and m.deleted_at is null
                  where l.id=new_line and l.approved_qty=1 and m.qty=1 and m.kind='out') then
      raise exception 'approved addition did not create line and movement';
    end if;

    perform set_config('request.jwt.claim.sub',adder::text,true);
    rejected:=false;
    begin perform public.request_dispatch_line_addition(candidate.request_id,spare_item.id,1,'sale',false,'dup');
    exception when others then if sqlerrm like 'สินค้านี้มีอยู่ในใบแล้ว%' then rejected:=true; else raise; end if; end;
    if not rejected then raise exception 'duplicate active item accepted'; end if;
    raise exception 'SWEEO_ROLLBACK_ADD_LINE';
  exception when raise_exception then
    if sqlerrm<>'SWEEO_ROLLBACK_ADD_LINE' then raise; end if;
    raise notice 'SWEEO_ADD_LINE_LIFECYCLE_TEST=PASS';
  end;

  -- Reject keeps the history row and does not touch stock.
  begin
    perform set_config('request.jwt.claim.sub',adder::text,true);
    addition_id:=public.request_dispatch_line_addition(candidate.request_id,spare_item.id,1,'gift',true,'reject test');
    perform set_config('request.jwt.claim.sub',reviewer::text,true);
    perform public.reject_dispatch_line_addition(addition_id,'rollback reject');
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into after_balance
    from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.id=spare_item.id group by i.id;
    if after_balance<>spare_item.balance then raise exception 'rejected addition changed stock'; end if;
    if (select status from public.dispatch_line_additions where id=addition_id)<>'rejected' then raise exception 'rejected row missing'; end if;
    raise exception 'SWEEO_ROLLBACK_ADD_REJECT';
  exception when raise_exception then
    if sqlerrm<>'SWEEO_ROLLBACK_ADD_REJECT' then raise; end if;
    raise notice 'SWEEO_ADD_LINE_REJECT_TEST=PASS';
  end;

  -- Insufficient stock blocks approval atomically.
  begin
    perform set_config('request.jwt.claim.sub',adder::text,true);
    addition_id:=public.request_dispatch_line_addition(candidate.request_id,spare_item.id,spare_item.balance+1,'sale',false,'too many');
    perform set_config('request.jwt.claim.sub',reviewer::text,true);
    rejected:=false;
    begin perform public.approve_dispatch_line_addition(addition_id);
    exception when check_violation then rejected:=true; end;
    if not rejected then raise exception 'approval exceeded stock'; end if;
    raise exception 'SWEEO_ROLLBACK_ADD_STOCK';
  exception when raise_exception then
    if sqlerrm<>'SWEEO_ROLLBACK_ADD_STOCK' then raise; end if;
    raise notice 'SWEEO_ADD_LINE_STOCK_TEST=PASS';
  end;

  -- Warehouse and auditor can neither propose nor approve.
  foreach role_name in array array['warehouse','auditor'] loop
    select user_id into forbidden from public.staff where role=role_name and is_active order by user_id limit 1;
    if forbidden is null then raise notice 'SWEEO_ADD_LINE_ROLE_TEST role=% result=SKIP',role_name; continue; end if;
    perform set_config('request.jwt.claim.sub',forbidden::text,true); rejected:=false;
    begin perform public.request_dispatch_line_addition(candidate.request_id,spare_item.id,1,'sale',false,'forbidden');
    exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'role % proposed an addition',role_name; end if;
    raise notice 'SWEEO_ADD_LINE_ROLE_TEST role=% result=PASS(42501)',role_name;
  end loop;

  select jsonb_build_object(
    'live_movements',(select count(*) from public.movements where deleted_at is null),
    'total_balance',(select coalesce(sum(balance),0) from (
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) balance
      from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null where i.active group by i.id) b),
    'dispatch_lines',(select count(*) from public.dispatch_request_lines),
    'additions',(select count(*) from public.dispatch_line_additions),
    'audit_rows',(select count(*) from public.stock_audit)
  ) into after_values;
  if after_values<>baseline then raise exception 'rollback tests left data behind: % vs %',after_values,baseline; end if;
  raise notice 'SWEEO_ADD_LINE_AFTER_ROLLBACK=% (matches baseline)',after_values;
end $$;

commit;
