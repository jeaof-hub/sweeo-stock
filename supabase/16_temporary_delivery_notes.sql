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

commit;
