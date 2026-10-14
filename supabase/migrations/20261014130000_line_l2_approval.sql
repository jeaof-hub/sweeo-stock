begin;

create table if not exists public.line_action_sessions (
  line_user_id text primary key,
  actor_user_id uuid not null references public.staff(user_id) on delete cascade,
  request_id uuid not null references public.dispatch_requests(id) on delete cascade,
  action text not null check (action in ('approve','reject')),
  state text not null check (state in ('awaiting_confirmation','awaiting_reason')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists line_action_sessions_expiry_idx on public.line_action_sessions(expires_at);
alter table public.line_action_sessions enable row level security;
revoke all on table public.line_action_sessions from public,anon,authenticated;
grant select,insert,update,delete on table public.line_action_sessions to service_role;

create or replace function public.line_pending_dispatch_requests(p_actor uuid)
returns table(
  id uuid,delivery_note_no text,customer text,requester_name text,
  line_count bigint,total_qty numeric,created_at timestamptz
) language sql stable security definer set search_path=public as $$
  select r.id,r.delivery_note_no,r.customer,coalesce(s.name,'–'),
    count(l.id),coalesce(sum(l.requested_qty),0),r.created_at
  from public.dispatch_requests r
  join public.staff actor on actor.user_id=p_actor and actor.is_active
    and actor.role in ('admin','owner','founder')
  left join public.staff s on s.user_id=r.requester_id
  join public.dispatch_request_lines l on l.request_id=r.id
  where r.status='pending' and r.requester_id<>p_actor
    and public.can_review_dispatch_as(p_actor,r.requester_role)
  group by r.id,r.delivery_note_no,r.customer,s.name,r.created_at
  order by r.created_at desc
  limit 10;
$$;
revoke all on function public.line_pending_dispatch_requests(uuid) from public,anon,authenticated;
grant execute on function public.line_pending_dispatch_requests(uuid) to service_role;

do $$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron') then
    raise exception 'pg_cron is required before installing LINE L2 cleanup';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname='sweeo-line-l2-session-cleanup';
  perform cron.schedule('sweeo-line-l2-session-cleanup','*/10 * * * *',
    $cron$delete from public.line_action_sessions where expires_at<now()-interval '1 hour';$cron$);
end $$;

commit;
