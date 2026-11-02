-- Reapply under a new version because production already recorded 20261102180000
-- for the superseded addition_* implementation before this migration was authored.
-- LINE notifications for every approval request: quantity changes and product additions on
-- approved delivery notes join the existing new-request notifications.
-- Safe to run repeatedly. Requires 23-25 (LINE L1), 30 (quantity re-approval) and 31 (additions).
begin;

alter table public.notification_outbox add column if not exists ref_id uuid;
alter table public.notification_outbox add column if not exists ref_at timestamptz;
alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('pending','result','qty_change','add_line'));
drop index if exists public.notification_outbox_dedupe;
create unique index if not exists notification_outbox_dedupe on public.notification_outbox(
  request_id,
  coalesce(recipient_user_id,'00000000-0000-0000-0000-000000000000'::uuid),
  kind,
  coalesce(ref_id,'00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(ref_at,'epoch'::timestamptz)
);

-- line-notify reads the proposal it is announcing.
grant select on table public.dispatch_line_additions to service_role;

-- One helper decides who is told about a revision: enabled LINE recipients who are an active
-- founder/owner/admin, linked to LINE, and not the person asking for the change.
create or replace function public.enqueue_line_revision(p_request_id uuid,p_kind text,p_ref_id uuid,p_ref_at timestamptz,p_requested_by uuid)
returns void language plpgsql security definer set search_path=public as $$
declare inserted integer:=0; recipient record;
begin
  for recipient in
    select r.user_id from public.line_notification_recipients r
    join public.staff s on s.user_id=r.user_id and s.is_active and s.role in ('founder','owner','admin')
    join public.staff_line_links l on l.user_id=r.user_id and l.active
    where r.enabled and r.user_id<>p_requested_by
  loop
    insert into public.notification_outbox(request_id,recipient_user_id,kind,ref_id,ref_at)
    values(p_request_id,recipient.user_id,p_kind,p_ref_id,p_ref_at) on conflict do nothing;
    inserted:=inserted+1;
  end loop;
  if inserted=0 then
    insert into public.notification_outbox(request_id,recipient_user_id,kind,ref_id,ref_at,status,error)
    values(p_request_id,null,p_kind,p_ref_id,p_ref_at,'no_recipient','ไม่มีผู้รับแจ้งเตือนที่เข้าเงื่อนไข') on conflict do nothing;
  end if;
end $$;
revoke all on function public.enqueue_line_revision(uuid,text,uuid,timestamptz,uuid) from public,anon,authenticated,service_role;

create or replace function public.enqueue_line_qty_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.qty_change_status='pending' and old.qty_change_status is distinct from 'pending' then
    perform public.enqueue_line_revision(new.request_id,'qty_change',new.id,new.qty_change_requested_at,new.qty_change_requested_by);
  end if;
  return new;
end $$;
drop trigger if exists dispatch_line_qty_change_line_notify on public.dispatch_request_lines;
create trigger dispatch_line_qty_change_line_notify after update of qty_change_status on public.dispatch_request_lines
for each row execute function public.enqueue_line_qty_change();
revoke all on function public.enqueue_line_qty_change() from public;

create or replace function public.enqueue_line_addition()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status='pending' then
    perform public.enqueue_line_revision(new.request_id,'add_line',new.id,null,new.requested_by);
  end if;
  return new;
end $$;
drop trigger if exists dispatch_line_addition_line_notify on public.dispatch_line_additions;
create trigger dispatch_line_addition_line_notify after insert on public.dispatch_line_additions
for each row execute function public.enqueue_line_addition();
revoke all on function public.enqueue_line_addition() from public;

-- Rollback smoke test: a proposal enqueues one row per eligible recipient and none for the proposer.
do $$
declare req uuid; itm text; proposer uuid; add_id uuid; queued integer; self_queued integer; eligible integer;
begin
  select id into req from public.dispatch_requests where status='approved' order by created_at desc limit 1;
  select user_id into proposer from public.staff where role in ('admin','owner','founder') and is_active order by role,user_id limit 1;
  select i.id into itm from public.items i where i.active and req is not null
    and not exists(select 1 from public.dispatch_request_lines l where l.request_id=req and l.item_id=i.id and l.voided_at is null)
  order by i.id limit 1;
  if req is null or proposer is null or itm is null then raise notice 'SWEEO_LINE_REVISION_TEST=SKIP'; return; end if;
  select count(*) into eligible from public.line_notification_recipients r
    join public.staff s on s.user_id=r.user_id and s.is_active and s.role in ('founder','owner','admin')
    join public.staff_line_links l on l.user_id=r.user_id and l.active
    where r.enabled and r.user_id<>proposer;
  begin
    -- The outbox webhook queues its HTTP call through pg_net, which only sends after commit;
    -- this block is rolled back, so nothing reaches LINE.
    perform set_config('request.jwt.claim.sub',proposer::text,true);
    add_id:=public.request_dispatch_line_addition(req,itm,1,'sale',false,'line notify rollback test');
    select count(*) into queued from public.notification_outbox where ref_id=add_id and kind='add_line' and status='pending';
    select count(*) into self_queued from public.notification_outbox where ref_id=add_id and recipient_user_id=proposer;
    if queued<>eligible or self_queued<>0 then raise exception 'addition notify mismatch queued=% eligible=% self=%',queued,eligible,self_queued; end if;
    if eligible=0 and not exists(select 1 from public.notification_outbox where ref_id=add_id and status='no_recipient') then
      raise exception 'addition without recipients was not recorded';
    end if;
    raise exception 'SWEEO_ROLLBACK_LINE_REVISION';
  exception when raise_exception then
    if sqlerrm<>'SWEEO_ROLLBACK_LINE_REVISION' then raise; end if;
    raise notice 'SWEEO_LINE_REVISION_TEST=PASS(eligible=%)',eligible;
  end;
end $$;

commit;
