-- Founder and owner may add a product to an approved delivery note immediately.
-- Admin additions keep the existing second-approval workflow.
begin;

create or replace function public.request_dispatch_line_addition(
  p_request_id uuid,p_item_id text,p_qty numeric,p_purpose text,p_return_required boolean,p_line_note text
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare
  actor_role text;
  request_row public.dispatch_requests%rowtype;
  item_row public.items%rowtype;
  new_id uuid;
  new_line_id uuid;
  new_movement_id uuid;
  purpose_value text;
  available numeric;
  addition_row jsonb;
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
  select * into item_row from public.items where id=p_item_id and active for update;
  if not found then raise exception 'ไม่พบสินค้าหรือสินค้าถูกปิดใช้งาน'; end if;
  if exists(select 1 from public.dispatch_request_lines where request_id=p_request_id and item_id=p_item_id and voided_at is null) then
    raise exception 'สินค้านี้มีอยู่ในใบแล้ว หากต้องการเปลี่ยนจำนวนให้ใช้ "แก้ไขจำนวน"';
  end if;
  if exists(select 1 from public.dispatch_line_additions where request_id=p_request_id and item_id=p_item_id and status='pending') then
    raise exception 'สินค้านี้กำลังรออนุมัติการเพิ่มในใบนี้อยู่แล้ว';
  end if;

  -- Admin keeps the proposal-only path: no line, movement, or stock change yet.
  if actor_role='admin' then
    insert into public.dispatch_line_additions(request_id,item_id,qty,purpose,return_required,line_note,requested_by)
    values(p_request_id,p_item_id,p_qty,purpose_value,coalesce(p_return_required,false),left(trim(coalesce(p_line_note,'')),300),auth.uid())
    returning id into new_id;
    insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
    select auth.uid(),'dispatch_line_additions',new_id::text,'request_add_line',null,
      to_jsonb(a)||jsonb_build_object('delivery_note_no',request_row.delivery_note_no,'code',item_row.code,'model',item_row.model)
    from public.dispatch_line_additions a where a.id=new_id;
    return new_id;
  end if;

  -- Founder/owner: validate available stock and apply the new line atomically.
  select item_row.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) into available
  from public.movements m where m.item_id=p_item_id and m.deleted_at is null;
  if p_qty>available then
    raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับเพิ่มสินค้า';
  end if;

  insert into public.dispatch_request_lines(request_id,item_id,code,model,requested_qty,approved_qty,purpose,return_required,line_note)
  values(p_request_id,p_item_id,item_row.code,item_row.model,p_qty,p_qty,purpose_value,coalesce(p_return_required,false),left(trim(coalesce(p_line_note,'')),300))
  returning id into new_line_id;
  insert into public.movements(item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,
    created_by,dispatch_request_id,dispatch_request_line_id)
  values(p_item_id,item_row.code,item_row.model,request_row.document_date,'out',p_qty,
    request_row.customer,request_row.doc_no,request_row.dept,request_row.sale,request_row.note,'request',
    auth.uid(),request_row.id,new_line_id) returning id into new_movement_id;
  update public.dispatch_request_lines set movement_id=new_movement_id where id=new_line_id;
  insert into public.dispatch_line_additions(
    request_id,item_id,qty,purpose,return_required,line_note,status,requested_by,reviewed_by,reviewed_at,line_id
  ) values(
    p_request_id,p_item_id,p_qty,purpose_value,coalesce(p_return_required,false),left(trim(coalesce(p_line_note,'')),300),
    'approved',auth.uid(),auth.uid(),now(),new_line_id
  ) returning id,to_jsonb(dispatch_line_additions.*) into new_id,addition_row;
  update public.dispatch_requests set updated_at=now() where id=request_row.id;
  insert into public.stock_audit(actor_id,entity,entity_id,action,before_data,after_data)
  values(auth.uid(),'dispatch_line_additions',new_id::text,'approve_add_line',null,
    addition_row||jsonb_build_object(
      'delivery_note_no',request_row.delivery_note_no,'code',item_row.code,'model',item_row.model,
      'movement_id',new_movement_id,'auto_approved',true,'actor_role',actor_role
    ));
  return new_id;
end $$;

revoke all on function public.request_dispatch_line_addition(uuid,text,numeric,text,boolean,text) from public,anon;
grant execute on function public.request_dispatch_line_addition(uuid,text,numeric,text,boolean,text) to authenticated;

-- Rollback-only production smoke test. It proves both paths without retaining rows or changing stock.
do $$
declare
  manager record;
  candidate record;
  spare_item record;
  addition_id uuid;
  before_movements bigint;
  before_balance numeric;
begin
  select s.user_id,s.role into manager from public.staff s
  where s.is_active and s.role in ('founder','owner') order by case s.role when 'founder' then 0 else 1 end limit 1;
  select r.id into candidate from public.dispatch_requests r where r.status='approved' order by r.created_at desc limit 1;
  select i.id,i.opening+coalesce((select sum(case when m.kind='in' then m.qty else -m.qty end)
    from public.movements m where m.item_id=i.id and m.deleted_at is null),0) balance
  into spare_item from public.items i
  where i.active and candidate.id is not null
    and not exists(select 1 from public.dispatch_request_lines l where l.request_id=candidate.id and l.item_id=i.id and l.voided_at is null)
    and not exists(select 1 from public.dispatch_line_additions a where a.request_id=candidate.id and a.item_id=i.id and a.status='pending')
    and i.opening+coalesce((select sum(case when m.kind='in' then m.qty else -m.qty end)
      from public.movements m where m.item_id=i.id and m.deleted_at is null),0)>=1
  order by i.id limit 1;
  if manager.user_id is null or candidate.id is null or spare_item.id is null then
    raise notice 'SWEEO_AUTO_ADD_TEST=SKIP'; return;
  end if;
  select count(*) into before_movements from public.movements where deleted_at is null;
  before_balance:=spare_item.balance;
  begin
    perform set_config('request.jwt.claim.sub',manager.user_id::text,true);
    addition_id:=public.request_dispatch_line_addition(candidate.id,spare_item.id,1,'sale',false,'rollback auto approval test');
    if (select status from public.dispatch_line_additions where id=addition_id)<>'approved' then raise exception 'manager addition was not approved'; end if;
    if (select requested_by<>reviewed_by from public.dispatch_line_additions where id=addition_id) then raise exception 'manager addition reviewer mismatch'; end if;
    if (select count(*) from public.movements where deleted_at is null)<>before_movements+1 then raise exception 'manager movement missing'; end if;
    if (select opening+coalesce((select sum(case when m.kind='in' then m.qty else -m.qty end) from public.movements m where m.item_id=spare_item.id and m.deleted_at is null),0)
        from public.items where id=spare_item.id)<>before_balance-1 then raise exception 'manager stock did not decrement once'; end if;
    raise exception 'SWEEO_ROLLBACK_AUTO_ADD';
  exception when raise_exception then
    if sqlerrm<>'SWEEO_ROLLBACK_AUTO_ADD' then raise; end if;
    raise notice 'SWEEO_AUTO_ADD_TEST=PASS(role=%)',manager.role;
  end;
end $$;

commit;
