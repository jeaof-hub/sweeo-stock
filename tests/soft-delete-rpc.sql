-- Current production smoke test for movement deletion. Every transaction rolls back.
-- Warehouse and Auditor cannot delete; Admin, Owner and Founder can use the RPC.

-- Warehouse cannot delete movements after Phase 2.
begin;
create temp table delete_target as
select id from public.movements where deleted_at is null limit 1;
grant select on delete_target to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from public.staff where role='warehouse' and is_active limit 1),true);
set local role authenticated;
do $$ begin
  begin perform public.soft_delete_movement((select id from delete_target)); raise exception 'warehouse deleted a movement';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

-- Admin, Owner and Founder can delete an eligible movement through the RPC.
begin;
create temp table delete_actor as select user_id from public.staff where role='admin' and is_active limit 1;
create temp table delete_movement as
  with inserted as (insert into public.movements(item_id,code,model,date,kind,qty,source,created_by)
  select 'r439','TEST-RPC','RPC rollback test',current_date,'in',1,'adjustment',user_id from delete_actor returning id) select id from inserted;
grant select on delete_actor,delete_movement to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from delete_actor),true); set local role authenticated;
do $$ begin
  if public.soft_delete_movement((select id from delete_movement)) is not true then raise exception 'admin soft delete failed'; end if;
end $$;
rollback;
begin;
create temp table delete_actor as select user_id from public.staff where role='owner' and is_active limit 1;
create temp table delete_movement as
  with inserted as (insert into public.movements(item_id,code,model,date,kind,qty,source,created_by)
  select 'r439','TEST-RPC','RPC rollback test',current_date,'in',1,'adjustment',user_id from delete_actor returning id) select id from inserted;
grant select on delete_actor,delete_movement to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from delete_actor),true); set local role authenticated;
do $$ begin
  if public.soft_delete_movement((select id from delete_movement)) is not true then raise exception 'owner soft delete failed'; end if;
end $$;
rollback;
begin;
create temp table delete_actor as select user_id from public.staff where role='founder' and is_active limit 1;
create temp table delete_movement as
  with inserted as (insert into public.movements(item_id,code,model,date,kind,qty,source,created_by)
  select 'r439','TEST-RPC','RPC rollback test',current_date,'in',1,'adjustment',user_id from delete_actor returning id) select id from inserted;
grant select on delete_actor,delete_movement to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from delete_actor),true); set local role authenticated;
do $$ begin
  if public.soft_delete_movement((select id from delete_movement)) is not true then raise exception 'founder soft delete failed'; end if;
end $$;
rollback;

-- Auditor remains read-only. Production has no Auditor, so change Warehouse temporarily and roll back.
begin;
create temp table auditor_actor as select user_id from public.staff where role='warehouse' and is_active limit 1;
create temp table auditor_target as select id from public.movements where deleted_at is null limit 1;
update public.staff set role='auditor' where user_id=(select user_id from auditor_actor);
grant select on auditor_actor,auditor_target to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from auditor_actor),true); set local role authenticated;
do $$ begin
  begin perform public.soft_delete_movement((select id from auditor_target)); raise exception 'auditor deleted a movement';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

-- No browser role may update movements directly.
begin;
select set_config('request.jwt.claim.sub',(select user_id::text from public.staff where role='founder' and is_active limit 1),true); set local role authenticated;
do $$ begin
  begin update public.movements set deleted_at=now() where id=(select id from public.movements where deleted_at is null limit 1); raise exception 'direct movement update succeeded';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

select 'soft-delete RPC role tests passed' as result;
