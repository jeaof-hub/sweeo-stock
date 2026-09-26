-- Phase 6A: post-delivery ERP invoice tracking at dispatch-line level.
-- This migration never writes public.movements.
begin;

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
