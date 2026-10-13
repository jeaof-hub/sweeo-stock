-- LINE Bot phase L1: account linking, notification outbox and shared dispatch actors.
-- Idempotent and safe to re-run after 20261001120000_app_manual.sql.
begin;

alter table public.staff add column if not exists preferred_language text not null default 'th';
alter table public.staff drop constraint if exists staff_preferred_language_check;
alter table public.staff add constraint staff_preferred_language_check
  check (preferred_language in ('th','en','zh-TW'));

create table if not exists public.staff_line_links (
  user_id uuid primary key references public.staff(user_id) on delete cascade,
  line_user_id text not null unique,
  linked_at timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists public.line_link_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[0-9]{6}$'),
  user_id uuid not null references public.staff(user_id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists line_link_codes_one_open_per_user
  on public.line_link_codes(user_id) where used_at is null;
create unique index if not exists line_link_codes_open_code
  on public.line_link_codes(code) where used_at is null;
create index if not exists line_link_codes_expiry_idx on public.line_link_codes(expires_at) where used_at is null;

create table if not exists public.line_link_attempts (
  line_user_id text primary key,
  window_started_at timestamptz not null default now(),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz
);

create table if not exists public.line_processed_events (
  webhook_event_id text primary key,
  processed_at timestamptz not null default now()
);

create table if not exists public.line_settings (
  singleton boolean primary key default true check (singleton),
  notify_requester_results boolean not null default false,
  push_limit integer not null default 300 check (push_limit between 1 and 300),
  add_friend_url text not null default '',
  qr_image_url text not null default '',
  updated_by uuid references public.staff(user_id),
  updated_at timestamptz not null default now()
);
insert into public.line_settings(singleton) values(true) on conflict(singleton) do nothing;

create table if not exists public.line_notification_recipients (
  user_id uuid primary key references public.staff(user_id) on delete cascade,
  enabled boolean not null default true,
  updated_by uuid references public.staff(user_id),
  updated_at timestamptz not null default now()
);
insert into public.line_notification_recipients(user_id)
select user_id from public.staff where role='founder' and is_active
on conflict(user_id) do nothing;

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.dispatch_requests(id) on delete cascade,
  recipient_user_id uuid references public.staff(user_id) on delete cascade,
  kind text not null check (kind in ('pending','result')),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','no_recipient','quota_exceeded')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists notification_outbox_dedupe
  on public.notification_outbox(request_id,coalesce(recipient_user_id,'00000000-0000-0000-0000-000000000000'::uuid),kind);
create index if not exists notification_outbox_ready_idx
  on public.notification_outbox(next_attempt_at,created_at) where status in ('pending','failed');

alter table public.staff_line_links enable row level security;
alter table public.line_link_codes enable row level security;
alter table public.line_link_attempts enable row level security;
alter table public.line_processed_events enable row level security;
alter table public.line_settings enable row level security;
alter table public.line_notification_recipients enable row level security;
alter table public.notification_outbox enable row level security;

revoke all on public.staff_line_links,public.line_link_codes,public.line_link_attempts,
  public.line_processed_events,public.line_settings,public.line_notification_recipients,
  public.notification_outbox from public,anon,authenticated;

create or replace function public.can_review_dispatch_as(p_actor uuid,p_requester_role text)
returns boolean language sql stable security definer set search_path=public
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id=p_actor and s.is_active and (
      (p_requester_role='warehouse' and s.role in ('admin','owner','founder')) or
      (p_requester_role='admin' and s.role in ('owner','founder'))
    )
  );
$$;
revoke all on function public.can_review_dispatch_as(uuid,text) from public,anon,authenticated;

create or replace function public.create_dispatch_request_internal(
  p_actor uuid,p_document_date date,p_delivery_date date,p_customer text,p_doc_no text,
  p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language plpgsql volatile security definer set search_path=public as $$
declare
  new_request_id uuid; actor_role text; line_count int; inserted_count int;
  line record; new_movement_id uuid; balance numeric;
begin
  select s.role into actor_role from public.staff s where s.user_id=p_actor and s.is_active for share;
  if actor_role is null or actor_role not in ('warehouse','admin','owner','founder') then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ส่งคำขอเบิก';
  end if;
  if p_document_date is null or p_delivery_date is null or p_lines is null or jsonb_typeof(p_lines)<>'array' then
    raise exception 'ข้อมูลคำขอไม่ถูกต้อง';
  end if;
  line_count:=jsonb_array_length(p_lines);
  if line_count<1 or line_count>100 then raise exception 'คำขอต้องมีสินค้า 1–100 รายการ'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_lines) x
    where coalesce(x->>'item_id','')=''
      or coalesce((x->>'qty')::numeric,0)<=0
      or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric)
      or coalesce(x->>'purpose','sale') not in ('sale','gift','claim','other')
  ) then raise exception 'สินค้า จำนวน หรือวัตถุประสงค์ไม่ถูกต้อง'; end if;

  insert into public.dispatch_requests(
    requester_id,requester_role,status,document_date,delivery_date,customer,doc_no,dept,sale,note
  ) values(
    p_actor,actor_role,case when actor_role in ('owner','founder') then 'approved' else 'pending' end,
    p_document_date,p_delivery_date,left(coalesce(p_customer,''),300),left(coalesce(p_doc_no,''),150),
    left(coalesce(p_dept,''),150),left(coalesce(p_sale,''),150),left(coalesce(p_note,''),1000)
  ) returning id into new_request_id;

  insert into public.dispatch_request_lines(
    request_id,item_id,code,model,requested_qty,purpose,return_required,line_note
  )
  select new_request_id,i.id,i.code,i.model,(x->>'qty')::numeric,
    coalesce(nullif(x->>'purpose',''),'sale'),coalesce((x->>'return_required')::boolean,false),
    left(coalesce(x->>'line_note',''),300)
  from jsonb_array_elements(p_lines) x
  join public.items i on i.id=x->>'item_id' and i.active;
  get diagnostics inserted_count=row_count;
  if inserted_count<>line_count then raise exception 'มีสินค้าที่ไม่พร้อมใช้งานหรือซ้ำกัน'; end if;

  if actor_role in ('owner','founder') then
    perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id
      where l.request_id=new_request_id order by i.id for update of i;
    for line in select * from public.dispatch_request_lines l where l.request_id=new_request_id order by l.item_id loop
      select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0)
        into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null
        where i.id=line.item_id group by i.id;
      if line.requested_qty>balance then
        raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ';
      end if;
      insert into public.movements(
        item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,
        created_by,dispatch_request_id,dispatch_request_line_id
      ) select line.item_id,line.code,line.model,p_document_date,'out',line.requested_qty,
        r.customer,r.doc_no,r.dept,r.sale,r.note,'request',p_actor,r.id,line.id
        from public.dispatch_requests r where r.id=new_request_id returning id into new_movement_id;
      update public.dispatch_request_lines set approved_qty=line.requested_qty,movement_id=new_movement_id where id=line.id;
    end loop;
    update public.dispatch_requests set decided_by=p_actor,decided_at=now(),updated_at=now() where id=new_request_id;
  end if;
  return new_request_id;
end $$;

create or replace function public.approve_dispatch_request_internal(p_actor uuid,p_request_id uuid,p_lines jsonb)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare
  target public.dispatch_requests%rowtype; line_count int; updated_count int;
  line record; new_movement_id uuid; balance numeric;
begin
  if not exists(select 1 from public.staff s where s.user_id=p_actor and s.is_active) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์อนุมัติคำขอนี้';
  end if;
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id=p_actor
    or not public.can_review_dispatch_as(p_actor,target.requester_role) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์อนุมัติคำขอนี้';
  end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'จำนวนอนุมัติไม่ถูกต้อง'; end if;
  select count(*) into line_count from public.dispatch_request_lines where request_id=p_request_id;
  if jsonb_array_length(p_lines)<>line_count or exists(
    select 1 from jsonb_array_elements(p_lines) x
    where coalesce((x->>'qty')::numeric,0)<=0 or (x->>'qty')::numeric<>trunc((x->>'qty')::numeric)
  ) then raise exception 'จำนวนอนุมัติต้องเป็นจำนวนเต็มบวกและระบุให้ครบทุกรายการ'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_lines) x
    join public.dispatch_request_lines l on l.request_id=p_request_id and l.id=(x->>'line_id')::uuid
    where (x->>'qty')::numeric>l.requested_qty
  ) then raise exception using errcode='23514',message='จำนวนอนุมัติต้องไม่เกินจำนวนที่ขอ'; end if;

  update public.dispatch_request_lines l set approved_qty=(x->>'qty')::numeric
    from jsonb_array_elements(p_lines) x
    where l.request_id=p_request_id and l.id=(x->>'line_id')::uuid;
  get diagnostics updated_count=row_count;
  if updated_count<>line_count then raise exception 'รายการอนุมัติไม่ตรงกับคำขอ'; end if;

  perform 1 from public.items i join public.dispatch_request_lines l on l.item_id=i.id
    where l.request_id=p_request_id order by i.id for update of i;
  for line in select * from public.dispatch_request_lines where request_id=p_request_id order by item_id loop
    select i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0)
      into balance from public.items i left join public.movements m on m.item_id=i.id and m.deleted_at is null
      where i.id=line.item_id group by i.id;
    if line.approved_qty>balance then
      raise exception using errcode='23514',message='ยอดคงเหลือไม่พอสำหรับอนุมัติ';
    end if;
    insert into public.movements(
      item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,note,source,
      created_by,dispatch_request_id,dispatch_request_line_id
    ) values(
      line.item_id,line.code,line.model,target.document_date,'out',line.approved_qty,
      target.customer,target.doc_no,target.dept,target.sale,target.note,'request',p_actor,target.id,line.id
    ) returning id into new_movement_id;
    update public.dispatch_request_lines set movement_id=new_movement_id where id=line.id;
  end loop;
  update public.dispatch_requests set status='approved',decided_by=p_actor,decided_at=now(),updated_at=now()
    where id=p_request_id;
  return true;
end $$;

create or replace function public.reject_dispatch_request_internal(p_actor uuid,p_request_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target public.dispatch_requests%rowtype;
begin
  if not exists(select 1 from public.staff s where s.user_id=p_actor and s.is_active) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ปฏิเสธคำขอนี้';
  end if;
  select * into target from public.dispatch_requests where id=p_request_id for update;
  if not found or target.status<>'pending' or target.requester_id=p_actor
    or not public.can_review_dispatch_as(p_actor,target.requester_role) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ปฏิเสธคำขอนี้';
  end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'กรุณาระบุเหตุผลที่ปฏิเสธ'; end if;
  update public.dispatch_requests set status='rejected',rejection_reason=left(trim(p_reason),1000),
    decided_by=p_actor,decided_at=now(),updated_at=now() where id=p_request_id;
  return true;
end $$;

create or replace function public.create_dispatch_request(
  p_document_date date,p_delivery_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language sql volatile security definer set search_path=public
as $$ select public.create_dispatch_request_internal(auth.uid(),p_document_date,p_delivery_date,p_customer,p_doc_no,p_dept,p_sale,p_note,p_lines); $$;
create or replace function public.create_dispatch_request(
  p_document_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language sql volatile security definer set search_path=public
as $$ select public.create_dispatch_request_internal(auth.uid(),p_document_date,p_document_date,p_customer,p_doc_no,p_dept,p_sale,p_note,p_lines); $$;
create or replace function public.approve_dispatch_request(p_request_id uuid,p_lines jsonb)
returns boolean language sql volatile security definer set search_path=public
as $$ select public.approve_dispatch_request_internal(auth.uid(),p_request_id,p_lines); $$;
create or replace function public.reject_dispatch_request(p_request_id uuid,p_reason text)
returns boolean language sql volatile security definer set search_path=public
as $$ select public.reject_dispatch_request_internal(auth.uid(),p_request_id,p_reason); $$;

create or replace function public.create_dispatch_request_as(
  p_actor uuid,p_document_date date,p_delivery_date date,p_customer text,p_doc_no text,p_dept text,p_sale text,p_note text,p_lines jsonb
) returns uuid language plpgsql volatile security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  return public.create_dispatch_request_internal(p_actor,p_document_date,p_delivery_date,p_customer,p_doc_no,p_dept,p_sale,p_note,p_lines);
end $$;
create or replace function public.approve_dispatch_request_as(p_actor uuid,p_request_id uuid,p_lines jsonb)
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  return public.approve_dispatch_request_internal(p_actor,p_request_id,p_lines);
end $$;
create or replace function public.reject_dispatch_request_as(p_actor uuid,p_request_id uuid,p_reason text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  return public.reject_dispatch_request_internal(p_actor,p_request_id,p_reason);
end $$;

revoke all on function public.create_dispatch_request_internal(uuid,date,date,text,text,text,text,text,jsonb),
  public.approve_dispatch_request_internal(uuid,uuid,jsonb),public.reject_dispatch_request_internal(uuid,uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.create_dispatch_request_as(uuid,date,date,text,text,text,text,text,jsonb),
  public.approve_dispatch_request_as(uuid,uuid,jsonb),public.reject_dispatch_request_as(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.create_dispatch_request_as(uuid,date,date,text,text,text,text,text,jsonb),
  public.approve_dispatch_request_as(uuid,uuid,jsonb),public.reject_dispatch_request_as(uuid,uuid,text) to service_role;
revoke all on function public.create_dispatch_request(date,date,text,text,text,text,text,jsonb),
  public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.approve_dispatch_request(uuid,jsonb),
  public.reject_dispatch_request(uuid,text) from public,anon;
grant execute on function public.create_dispatch_request(date,date,text,text,text,text,text,jsonb),
  public.create_dispatch_request(date,text,text,text,text,text,jsonb),public.approve_dispatch_request(uuid,jsonb),
  public.reject_dispatch_request(uuid,text) to authenticated;

create or replace function public.create_line_link_code()
returns table(code text,expires_at timestamptz) language plpgsql volatile security definer set search_path=public as $$
declare candidate text; actor_role text; tries int:=0;
begin
  select s.role into actor_role from public.staff s where s.user_id=auth.uid() and s.is_active;
  if actor_role not in ('warehouse','admin','owner','founder') then
    raise exception using errcode='42501',message='บัญชีนี้เชื่อม LINE ไม่ได้';
  end if;
  update public.line_link_codes set used_at=now() where user_id=auth.uid() and used_at is null;
  loop
    tries:=tries+1;
    if tries>20 then raise exception 'สร้างรหัสไม่สำเร็จ กรุณาลองใหม่'; end if;
    candidate:=lpad(floor(random()*1000000)::int::text,6,'0');
    begin
      insert into public.line_link_codes(code,user_id,expires_at) values(candidate,auth.uid(),now()+interval '10 minutes');
      return query select candidate,now()+interval '10 minutes';
      return;
    exception when unique_violation then null;
    end;
  end loop;
end $$;

create or replace function public.my_line_status()
returns table(linked boolean,linked_at timestamptz,code text,expires_at timestamptz,add_friend_url text,qr_image_url text)
language sql stable security definer set search_path=public as $$
  select coalesce(l.active,false),l.linked_at,c.code,c.expires_at,s.add_friend_url,s.qr_image_url
  from public.line_settings s
  left join public.staff_line_links l on l.user_id=auth.uid() and l.active
  left join lateral (
    select x.code,x.expires_at from public.line_link_codes x
    where x.user_id=auth.uid() and x.used_at is null and x.expires_at>now()
    order by x.created_at desc limit 1
  ) c on true
  where exists(select 1 from public.staff st where st.user_id=auth.uid() and st.is_active and st.role in ('warehouse','admin','owner','founder'));
$$;

create or replace function public.unlink_my_line()
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.is_active and s.role in ('warehouse','admin','owner','founder')) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ยกเลิกการเชื่อม';
  end if;
  update public.staff_line_links set active=false where user_id=auth.uid();
  delete from public.line_notification_recipients where user_id=auth.uid();
  return true;
end $$;

create or replace function public.set_my_preferred_language(p_language text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if p_language not in ('th','en','zh-TW') then raise exception 'ภาษาไม่ถูกต้อง'; end if;
  update public.staff set preferred_language=p_language where user_id=auth.uid() and is_active;
  if not found then raise exception using errcode='42501',message='ไม่พบบัญชีที่ใช้งานอยู่'; end if;
  return true;
end $$;

create or replace function public.consume_line_link_code(p_code text,p_line_user_id text)
returns text language plpgsql volatile security definer set search_path=public as $$
declare target public.line_link_codes%rowtype; target_staff public.staff%rowtype; attempt public.line_link_attempts%rowtype;
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  if p_line_user_id is null or length(p_line_user_id)<10 then return 'invalid'; end if;
  select * into attempt from public.line_link_attempts where line_user_id=p_line_user_id for update;
  if found and attempt.locked_until>now() then return 'locked'; end if;

  select * into target from public.line_link_codes where code=p_code and used_at is null order by created_at desc limit 1 for update;
  if not found then
    insert into public.line_link_attempts(line_user_id,window_started_at,failed_attempts,locked_until)
    values(p_line_user_id,now(),1,null)
    on conflict(line_user_id) do update set
      window_started_at=case when public.line_link_attempts.window_started_at<now()-interval '1 hour' then now() else public.line_link_attempts.window_started_at end,
      failed_attempts=case when public.line_link_attempts.window_started_at<now()-interval '1 hour' then 1 else public.line_link_attempts.failed_attempts+1 end,
      locked_until=case when (case when public.line_link_attempts.window_started_at<now()-interval '1 hour' then 1 else public.line_link_attempts.failed_attempts+1 end)>=5 then now()+interval '1 hour' else null end;
    select * into attempt from public.line_link_attempts where line_user_id=p_line_user_id;
    return case when attempt.locked_until>now() then 'locked' else 'invalid' end;
  end if;
  if target.expires_at<=now() then return 'expired'; end if;
  select * into target_staff from public.staff where user_id=target.user_id for share;
  if not found or not target_staff.is_active or target_staff.role not in ('warehouse','admin','owner','founder') then return 'forbidden'; end if;
  if exists(select 1 from public.staff_line_links l where l.line_user_id=p_line_user_id and l.user_id<>target.user_id and l.active) then return 'line_in_use'; end if;
  delete from public.staff_line_links where line_user_id=p_line_user_id and user_id<>target.user_id and not active;
  insert into public.staff_line_links(user_id,line_user_id,linked_at,active)
    values(target.user_id,p_line_user_id,now(),true)
    on conflict(user_id) do update set line_user_id=excluded.line_user_id,linked_at=excluded.linked_at,active=true;
  update public.line_link_codes set used_at=now() where id=target.id;
  delete from public.line_link_attempts where line_user_id=p_line_user_id;
  return 'linked';
end $$;

create or replace function public.line_unfollow(p_line_user_id text)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare target_user uuid;
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  update public.staff_line_links set active=false where line_user_id=p_line_user_id and active returning user_id into target_user;
  if target_user is not null then delete from public.line_notification_recipients where user_id=target_user; end if;
  return target_user is not null;
end $$;

create or replace function public.line_admin_overview()
returns table(user_id uuid,name text,username text,role text,is_active boolean,line_linked boolean,linked_at timestamptz,preferred_language text)
language sql stable security definer set search_path=public as $$
  with actor as (select role from public.staff where user_id=auth.uid() and is_active)
  select s.user_id,s.name,s.username,s.role,s.is_active,coalesce(l.active,false),l.linked_at,s.preferred_language
  from public.staff s cross join actor a
  left join public.staff_line_links l on l.user_id=s.user_id and l.active
  where a.role in ('founder','owner') and (a.role='founder' or s.role<>'founder')
  order by s.created_at;
$$;

create or replace function public.line_settings_view()
returns jsonb language sql stable security definer set search_path=public as $$
  with actor as (select role from public.staff where user_id=auth.uid() and is_active),
  usage as (
    select count(*)::int used from public.notification_outbox
    where status='sent' and sent_at >= date_trunc('month',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'
      and sent_at < (date_trunc('month',now() at time zone 'Asia/Bangkok')+interval '1 month') at time zone 'Asia/Bangkok'
  )
  select case when exists(select 1 from actor where role in ('founder','owner')) then jsonb_build_object(
    'notify_requester_results',s.notify_requester_results,'push_limit',s.push_limit,
    'add_friend_url',s.add_friend_url,'qr_image_url',s.qr_image_url,'used',u.used,
    'recipients',coalesce((select jsonb_agg(r.user_id) from public.line_notification_recipients r where r.enabled),'[]'::jsonb)
  ) else null end
  from public.line_settings s cross join usage u;
$$;

create or replace function public.update_line_settings(
  p_notify_requester_results boolean,p_push_limit integer,p_add_friend_url text,p_qr_image_url text
) returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if not exists(select 1 from public.staff where user_id=auth.uid() and is_active and role in ('founder','owner')) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ตั้งค่า LINE';
  end if;
  if p_push_limit<1 or p_push_limit>300 then raise exception 'เพดานข้อความต้องอยู่ระหว่าง 1–300'; end if;
  update public.line_settings set notify_requester_results=p_notify_requester_results,push_limit=p_push_limit,
    add_friend_url=left(trim(coalesce(p_add_friend_url,'')),500),qr_image_url=left(trim(coalesce(p_qr_image_url,'')),500),
    updated_by=auth.uid(),updated_at=now() where singleton;
  return true;
end $$;

create or replace function public.set_line_notification_recipient(p_user_id uuid,p_enabled boolean)
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if not exists(select 1 from public.staff where user_id=auth.uid() and is_active and role in ('founder','owner')) then
    raise exception using errcode='42501',message='ไม่มีสิทธิ์ตั้งค่าผู้รับแจ้งเตือน';
  end if;
  if p_enabled then
    if not exists(
      select 1 from public.staff s join public.staff_line_links l on l.user_id=s.user_id and l.active
      where s.user_id=p_user_id and s.is_active and s.role in ('admin','owner','founder')
    ) then raise exception 'ผู้ใช้นี้ยังไม่เชื่อม LINE หรือไม่มีสิทธิ์อนุมัติ'; end if;
    insert into public.line_notification_recipients(user_id,enabled,updated_by,updated_at)
      values(p_user_id,true,auth.uid(),now())
      on conflict(user_id) do update set enabled=true,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  else
    delete from public.line_notification_recipients where user_id=p_user_id;
  end if;
  return true;
end $$;

create or replace function public.disable_staff_line_link()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if (not new.is_active) or new.role='auditor' then
    update public.staff_line_links set active=false where user_id=new.user_id and active;
    delete from public.line_notification_recipients where user_id=new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists staff_disable_line_link on public.staff;
create trigger staff_disable_line_link after update of is_active,role on public.staff
for each row when (old.is_active is distinct from new.is_active or old.role is distinct from new.role)
execute function public.disable_staff_line_link();

create or replace function public.enqueue_line_notification()
returns trigger language plpgsql security definer set search_path=public as $$
declare recipient record; inserted_count int:=0; result_enabled boolean;
begin
  if tg_op='INSERT' and new.status='pending' then
    for recipient in
      select r.user_id from public.line_notification_recipients r
      join public.staff s on s.user_id=r.user_id and s.is_active
      join public.staff_line_links l on l.user_id=r.user_id and l.active
      where r.enabled and r.user_id<>new.requester_id and public.can_review_dispatch_as(r.user_id,new.requester_role)
    loop
      insert into public.notification_outbox(request_id,recipient_user_id,kind)
      values(new.id,recipient.user_id,'pending') on conflict do nothing;
      inserted_count:=inserted_count+1;
    end loop;
    if inserted_count=0 then
      insert into public.notification_outbox(request_id,recipient_user_id,kind,status,error)
      values(new.id,null,'pending','no_recipient','ไม่มีผู้รับแจ้งเตือนที่เข้าเงื่อนไข') on conflict do nothing;
    end if;
  elsif tg_op='UPDATE' and old.status='pending' and new.status in ('approved','rejected') then
    select notify_requester_results into result_enabled from public.line_settings where singleton;
    if result_enabled and exists(
      select 1 from public.staff s join public.staff_line_links l on l.user_id=s.user_id and l.active
      where s.user_id=new.requester_id and s.is_active and s.role in ('warehouse','admin','owner','founder')
    ) then
      insert into public.notification_outbox(request_id,recipient_user_id,kind)
      values(new.id,new.requester_id,'result') on conflict do nothing;
    elsif result_enabled then
      insert into public.notification_outbox(request_id,recipient_user_id,kind,status,error)
      values(new.id,null,'result','no_recipient','ผู้ขอไม่ได้เชื่อม LINE หรือบัญชีถูกปิด') on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists dispatch_request_line_outbox_insert on public.dispatch_requests;
drop trigger if exists dispatch_request_line_outbox_update on public.dispatch_requests;
create trigger dispatch_request_line_outbox_insert after insert on public.dispatch_requests
for each row execute function public.enqueue_line_notification();
create trigger dispatch_request_line_outbox_update after update of status on public.dispatch_requests
for each row when (old.status is distinct from new.status) execute function public.enqueue_line_notification();

create or replace function public.line_claim_notification(p_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $$
declare monthly_used int; monthly_limit int;
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  select push_limit into monthly_limit from public.line_settings where singleton;
  select count(*) into monthly_used from public.notification_outbox
  where status='sent' and sent_at >= date_trunc('month',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'
    and sent_at < (date_trunc('month',now() at time zone 'Asia/Bangkok')+interval '1 month') at time zone 'Asia/Bangkok';
  if monthly_used>=monthly_limit then
    update public.notification_outbox set status='quota_exceeded',error='ถึงเพดานข้อความประจำเดือน'
      where id=p_id and status in ('pending','failed');
    return false;
  end if;
  update public.notification_outbox set status='processing',attempts=attempts+1,error=null
    where id=p_id and status in ('pending','failed') and attempts<3 and next_attempt_at<=now();
  return found;
end $$;

create or replace function public.line_finish_notification(p_id uuid,p_status text,p_error text default null)
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  if p_status not in ('sent','failed','quota_exceeded') then raise exception 'สถานะ outbox ไม่ถูกต้อง'; end if;
  update public.notification_outbox set status=p_status,error=left(nullif(p_error,''),500),
    sent_at=case when p_status='sent' then now() else null end,
    next_attempt_at=case when p_status='failed' then now()+(interval '1 minute'*greatest(1,attempts)) else next_attempt_at end
  where id=p_id and status='processing';
  return found;
end $$;

create or replace function public.line_requeue_notifications()
returns integer language plpgsql volatile security definer set search_path=public as $$
declare changed int;
begin
  update public.notification_outbox set status='failed',error='หมดเวลารอผู้ส่ง',next_attempt_at=now()+interval '1 minute'
    where status='processing' and created_at<now()-interval '5 minutes' and attempts<3;
  update public.notification_outbox set status='pending'
    where status='failed' and attempts<3 and next_attempt_at<=now();
  get diagnostics changed=row_count;
  return changed;
end $$;

revoke all on function public.create_line_link_code(),public.my_line_status(),public.unlink_my_line(),
  public.set_my_preferred_language(text),public.line_admin_overview(),public.line_settings_view(),
  public.update_line_settings(boolean,integer,text,text),public.set_line_notification_recipient(uuid,boolean)
  from public,anon;
grant execute on function public.create_line_link_code(),public.my_line_status(),public.unlink_my_line(),
  public.set_my_preferred_language(text),public.line_admin_overview(),public.line_settings_view(),
  public.update_line_settings(boolean,integer,text,text),public.set_line_notification_recipient(uuid,boolean)
  to authenticated;
revoke all on function public.consume_line_link_code(text,text),public.line_unfollow(text),
  public.line_claim_notification(uuid),public.line_finish_notification(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.consume_line_link_code(text,text),public.line_unfollow(text),
  public.line_claim_notification(uuid),public.line_finish_notification(uuid,text,text) to service_role;
revoke all on function public.line_requeue_notifications() from public,anon,authenticated,service_role;

do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname='sweeo-line-maintenance';
    perform cron.schedule('sweeo-line-maintenance','* * * * *',
      $cron$select public.line_requeue_notifications(); delete from public.line_processed_events where processed_at<now()-interval '7 days'; delete from public.line_link_codes where created_at<now()-interval '1 day';$cron$);
  end if;
end $$;

commit;
