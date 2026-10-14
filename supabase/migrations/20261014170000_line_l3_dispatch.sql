begin;

create table if not exists public.line_sessions (
  line_user_id text primary key,
  actor_user_id uuid not null references public.staff(user_id) on delete cascade,
  step text not null check (step in ('customer','purpose','items','confirm')),
  customer text not null default '',
  purpose text check (purpose is null or purpose in ('sale','gift','claim','other')),
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines)='array'),
  pending_match jsonb,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists line_sessions_expiry_idx on public.line_sessions(expires_at);
alter table public.line_sessions enable row level security;
revoke all on table public.line_sessions from public,anon,authenticated;
grant select,insert,update,delete on table public.line_sessions to service_role;

create or replace function public.line_product_catalog()
returns table(id text,code text,model text,spec text,dept text,balance numeric)
language sql stable security definer set search_path=public as $$
  select i.id,i.code,i.model,i.spec,i.dept,
    i.opening+coalesce(sum(case when m.kind='in' then m.qty else -m.qty end) filter(where m.deleted_at is null),0)
  from public.items i left join public.movements m on m.item_id=i.id
  where i.active
  group by i.id,i.code,i.model,i.spec,i.dept,i.opening
  order by i.id;
$$;

create or replace function public.line_my_dispatch_requests(p_actor uuid)
returns table(id uuid,delivery_note_no text,status text,customer text,created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select r.id,r.delivery_note_no,r.status,r.customer,r.created_at
  from public.dispatch_requests r join public.staff s on s.user_id=p_actor and s.is_active
  where r.requester_id=p_actor and s.role in ('warehouse','admin','owner','founder')
  order by r.created_at desc limit 10;
$$;

revoke all on function public.line_product_catalog(),public.line_my_dispatch_requests(uuid) from public,anon,authenticated;
grant execute on function public.line_product_catalog(),public.line_my_dispatch_requests(uuid) to service_role;

do $$
begin
  if not exists(select 1 from pg_extension where extname='pg_cron') then
    raise exception 'pg_cron is required before installing LINE L3 cleanup';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname='sweeo-line-l3-session-cleanup';
  perform cron.schedule('sweeo-line-l3-session-cleanup','*/10 * * * *',
    $cron$delete from public.line_sessions where expires_at<now();$cron$);
end $$;

commit;
