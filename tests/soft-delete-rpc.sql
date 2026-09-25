-- Production smoke test for migration 13. Every transaction rolls back.
-- Requires one active account for each production role below.

begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.staff where role='warehouse' and is_active limit 1), true);
set local role authenticated;
do $$
declare movement_id uuid; deleted boolean;
begin
  insert into public.movements (item_id,code,model,date,kind,qty,source)
  values ('r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app') returning id into movement_id;
  deleted := public.soft_delete_movement(movement_id);
  if deleted is not true then raise exception 'warehouse own same-day soft delete failed'; end if;
end $$;
rollback;

begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.staff where role='admin' and is_active limit 1), true);
set local role authenticated;
do $$
declare movement_id uuid; deleted boolean;
begin
  insert into public.movements (item_id,code,model,date,kind,qty,source)
  values ('r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app') returning id into movement_id;
  deleted := public.soft_delete_movement(movement_id);
  if deleted is not true then raise exception 'admin soft delete failed'; end if;
end $$;
rollback;

begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.staff where role='owner' and is_active limit 1), true);
set local role authenticated;
do $$
declare movement_id uuid; deleted boolean;
begin
  insert into public.movements (item_id,code,model,date,kind,qty,source)
  values ('r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app') returning id into movement_id;
  deleted := public.soft_delete_movement(movement_id);
  if deleted is not true then raise exception 'owner soft delete failed'; end if;
end $$;
rollback;

begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.staff where role='founder' and is_active limit 1), true);
set local role authenticated;
do $$
declare movement_id uuid; deleted boolean;
begin
  insert into public.movements (item_id,code,model,date,kind,qty,source)
  values ('r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app') returning id into movement_id;
  deleted := public.soft_delete_movement(movement_id);
  if deleted is not true then raise exception 'founder soft delete failed'; end if;
end $$;
rollback;

-- Warehouse cannot delete another user's movement.
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.staff where role='founder' and is_active limit 1), true);
set local role authenticated;
do $$
declare movement_id uuid; warehouse_id uuid;
begin
  insert into public.movements (item_id,code,model,date,kind,qty,source)
  values ('r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app') returning id into movement_id;
  select user_id into warehouse_id from public.staff where role='warehouse' and is_active limit 1;
  perform set_config('request.jwt.claim.sub', warehouse_id::text, true);
  begin
    perform public.soft_delete_movement(movement_id);
    raise exception 'warehouse deleted another user movement';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- Warehouse cannot delete its own movement after the Bangkok calendar day.
begin;
create temp table soft_delete_old_target (id uuid, user_id uuid) on commit drop;
grant select on soft_delete_old_target to authenticated;
with warehouse_user as (
  select user_id from public.staff where role='warehouse' and is_active limit 1
), movement as (
  insert into public.movements (item_id,code,model,date,kind,qty,source,created_by,created_at)
  select 'r033','TEST-RPC','RPC rollback test',current_date - 1,'out',0.001,'app',user_id,now() - interval '1 day'
  from warehouse_user returning id,created_by
)
insert into soft_delete_old_target select id,created_by from movement;
select set_config('request.jwt.claim.sub', (select user_id::text from soft_delete_old_target), true);
set local role authenticated;
do $$
begin
  begin
    perform public.soft_delete_movement((select id from soft_delete_old_target));
    raise exception 'warehouse deleted an older movement';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- Auditor is preserved as read-only; production currently has no auditor user,
-- so this test temporarily changes the warehouse role and rolls it back.
begin;
create temp table soft_delete_auditor_target (id uuid, user_id uuid) on commit drop;
grant select on soft_delete_auditor_target to authenticated;
with warehouse_user as (
  select user_id from public.staff where role='warehouse' and is_active limit 1
), movement as (
  insert into public.movements (item_id,code,model,date,kind,qty,source,created_by,created_at)
  select 'r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app',user_id,now()
  from warehouse_user returning id,created_by
)
insert into soft_delete_auditor_target select id,created_by from movement;
update public.staff set role='auditor' where user_id=(select user_id from soft_delete_auditor_target);
select set_config('request.jwt.claim.sub', (select user_id::text from soft_delete_auditor_target), true);
set local role authenticated;
do $$
begin
  begin
    perform public.soft_delete_movement((select id from soft_delete_auditor_target));
    raise exception 'auditor deleted a movement';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- No authenticated role may update movements directly anymore.
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from public.staff where role='founder' and is_active limit 1), true);
set local role authenticated;
do $$
declare movement_id uuid;
begin
  insert into public.movements (item_id,code,model,date,kind,qty,source)
  values ('r033','TEST-RPC','RPC rollback test',current_date,'out',0.001,'app') returning id into movement_id;
  begin
    update public.movements set deleted_at=now() where id=movement_id;
    raise exception 'direct movement update unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

select 'soft-delete RPC role tests passed' as result;
