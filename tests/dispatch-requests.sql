-- Phase 2 production smoke tests. All data changes roll back.
begin;
create temp table phase2_roles as select role,user_id from public.staff where is_active;
grant select on phase2_roles to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='warehouse'),true);
set local role authenticated;
do $$
declare req uuid; line_id uuid; state text;
begin
  begin
    perform public.create_dispatch_request(current_date,'TEST','TEST-NULL','','','',null);
    raise exception 'null lines accepted';
  exception when others then if sqlerrm='null lines accepted' then raise; end if; end;
  req:=public.create_dispatch_request(current_date,'TEST','TEST-WH','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001)));
  select status into state from public.dispatch_requests where id=req;
  if state<>'pending' or exists(select 1 from public.movements where dispatch_request_id=req) then raise exception 'warehouse request was not pending'; end if;
  begin
    insert into public.movements(item_id,code,model,date,kind,qty,source) values('r439','TEST','TEST',current_date,'out',0.001,'app');
    raise exception 'warehouse direct dispatch succeeded';
  exception when insufficient_privilege then null;
  end;
  perform public.cancel_dispatch_request(req);
  select status into state from public.dispatch_requests where id=req;
  if state<>'cancelled' then raise exception 'warehouse cancel failed'; end if;
end $$;
rollback;

-- Accounts without a dispatch role cannot create requests.
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true); set local role authenticated;
do $$ begin
  begin perform public.create_dispatch_request(current_date,'TEST','TEST-NOSTAFF','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001))); raise exception 'non-member request succeeded';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

begin;
create temp table phase2_auditor as select user_id from public.staff where role='auditor' and is_active limit 1; grant select on phase2_auditor to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from phase2_auditor),true); set local role authenticated;
do $$ begin
  if exists(select 1 from phase2_auditor) then
    begin perform public.create_dispatch_request(current_date,'TEST','TEST-AUDITOR','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001))); raise exception 'auditor request succeeded';
    exception when insufficient_privilege then null; end;
  end if;
end $$;
rollback;

-- Admin cannot dispatch directly or approve its own request, but can receive.
begin;
create temp table phase2_roles as select role,user_id from public.staff where is_active; grant select on phase2_roles to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='admin'),true); set local role authenticated;
do $$
declare req uuid; line_id uuid;
begin
  begin
    insert into public.movements(item_id,code,model,date,kind,qty,source) values('r439','TEST','TEST',current_date,'out',0.001,'app');
    raise exception 'admin direct dispatch succeeded';
  exception when insufficient_privilege then null;
  end;
  insert into public.movements(item_id,code,model,date,kind,qty,source) values('r439','TEST','TEST',current_date,'in',0.001,'app');
  req:=public.create_dispatch_request(current_date,'TEST','TEST-ADMIN','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001)));
  select id into line_id from public.dispatch_request_lines where request_id=req;
  begin
    perform public.approve_dispatch_request(req,jsonb_build_array(jsonb_build_object('line_id',line_id,'qty',0.002)));
    raise exception 'admin approved own request';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- Admin may approve a Warehouse request and increase its quantity.
begin;
create temp table phase2_roles as select role,user_id from public.staff where is_active; grant select on phase2_roles to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='warehouse'),true); set local role authenticated;
do $$
declare req uuid; line_id uuid; state text;
begin
  req:=public.create_dispatch_request(current_date,'TEST','TEST-ADMIN-APPROVE','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001)));
  select id into line_id from public.dispatch_request_lines where request_id=req;
  perform set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='admin'),true);
  perform public.approve_dispatch_request(req,jsonb_build_array(jsonb_build_object('line_id',line_id,'qty',0.002)));
  select status into state from public.dispatch_requests where id=req;
  if state<>'approved' or not exists(select 1 from public.movements where dispatch_request_id=req and qty=0.002) then raise exception 'admin approval failed'; end if;
end $$;
rollback;

-- Owner and Founder may approve Admin requests; their own requests approve immediately.
begin;
create temp table phase2_roles as select role,user_id from public.staff where is_active; grant select on phase2_roles to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='admin'),true); set local role authenticated;
do $$
declare req uuid; line_id uuid; direct_req uuid; reviewer text;
begin
  foreach reviewer in array array['owner','founder'] loop
    perform set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='admin'),true);
    req:=public.create_dispatch_request(current_date,'TEST','TEST-'||reviewer,'','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001)));
    select id into line_id from public.dispatch_request_lines where request_id=req;
    perform set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role=reviewer),true);
    perform public.approve_dispatch_request(req,jsonb_build_array(jsonb_build_object('line_id',line_id,'qty',0.001)));
    direct_req:=public.create_dispatch_request(current_date,'TEST','DIRECT-'||reviewer,'','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',0.001)));
    if (select status from public.dispatch_requests where id=direct_req)<>'approved' or not exists(select 1 from public.movements where dispatch_request_id=direct_req) then raise exception '% immediate request failed',reviewer; end if;
  end loop;
end $$;
rollback;

-- Rejection requires a reason, and approval may not exceed actual balance.
begin;
create temp table phase2_roles as select role,user_id from public.staff where is_active; grant select on phase2_roles to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='warehouse'),true); set local role authenticated;
do $$
declare req uuid; line_id uuid;
begin
  req:=public.create_dispatch_request(current_date,'TEST','TEST-REJECT','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',999999999)));
  select id into line_id from public.dispatch_request_lines where request_id=req;
  perform set_config('request.jwt.claim.sub',(select user_id::text from phase2_roles where role='owner'),true);
  begin perform public.reject_dispatch_request(req,''); raise exception 'empty rejection reason accepted'; exception when others then if sqlerrm='empty rejection reason accepted' then raise; end if; end;
  begin perform public.approve_dispatch_request(req,jsonb_build_array(jsonb_build_object('line_id',line_id,'qty',999999999))); raise exception 'over-balance approval succeeded'; exception when check_violation then null; end;
  perform public.reject_dispatch_request(req,'ยอดไม่เพียงพอ');
  begin perform public.cancel_dispatch_request(req); raise exception 'approved/rejected request cancelled'; exception when insufficient_privilege then null; end;
end $$;
rollback;

select 'phase 2 role tests passed' as result;
