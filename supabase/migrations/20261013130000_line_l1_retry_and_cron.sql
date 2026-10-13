-- LINE L1 reliability fix: claimed timestamps, stuck-job recovery and required pg_cron.
begin;

alter table public.notification_outbox
  add column if not exists claimed_at timestamptz;

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
    update public.notification_outbox set status='quota_exceeded',error='ถึงเพดานข้อความประจำเดือน',claimed_at=null
      where id=p_id and status in ('pending','failed');
    return false;
  end if;
  update public.notification_outbox
    set status='processing',attempts=attempts+1,error=null,claimed_at=now()
    where id=p_id and status in ('pending','failed') and attempts<3 and next_attempt_at<=now();
  return found;
end $$;

create or replace function public.line_finish_notification(p_id uuid,p_status text,p_error text default null)
returns boolean language plpgsql volatile security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception using errcode='42501',message='service role required'; end if;
  if p_status not in ('sent','failed','quota_exceeded') then raise exception 'สถานะ outbox ไม่ถูกต้อง'; end if;
  update public.notification_outbox set status=p_status,error=left(nullif(p_error,''),500),claimed_at=null,
    sent_at=case when p_status='sent' then now() else null end,
    next_attempt_at=case when p_status='failed' then now()+(interval '1 minute'*greatest(1,attempts)) else next_attempt_at end
  where id=p_id and status='processing';
  return found;
end $$;

create or replace function public.line_requeue_notifications()
returns integer language plpgsql volatile security definer set search_path=public as $$
declare changed int;
begin
  update public.notification_outbox
    set status='failed',error='หมดเวลารอผู้ส่ง',next_attempt_at=now(),claimed_at=null
    where status='processing' and claimed_at<now()-interval '2 minutes' and attempts<3;
  update public.notification_outbox set status='pending'
    where status='failed' and attempts<3 and next_attempt_at<=now();
  get diagnostics changed=row_count;
  return changed;
end $$;

revoke all on function public.line_claim_notification(uuid),public.line_finish_notification(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.line_claim_notification(uuid),public.line_finish_notification(uuid,text,text)
  to service_role;
revoke all on function public.line_requeue_notifications() from public,anon,authenticated,service_role;

do $$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron')
     or to_regclass('cron.job') is null then
    raise exception 'pg_cron is required: enable it in Database -> Extensions before running migration 24';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname='sweeo-line-maintenance';
select cron.schedule('sweeo-line-maintenance','* * * * *',
  $cron$select public.line_requeue_notifications(); delete from public.line_processed_events where processed_at<now()-interval '7 days'; delete from public.line_link_codes where created_at<now()-interval '1 day';$cron$);

commit;
