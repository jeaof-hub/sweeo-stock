-- Phase 1B: username login and enumeration-resistant rate limiting.
-- Run after 10_role_permissions.sql. Safe to run repeatedly.
begin;

alter table public.staff add column if not exists username text;

with candidates as (
  select user_id,
    trim(both '._-' from left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g'), 32)) as local_name
  from public.staff where username is null
), names as (
  select user_id,
    case when length(local_name) >= 3 then local_name
         else 'user_' || left(replace(user_id::text, '-', ''), 8) end as base_name
  from candidates
), numbered as (
  select user_id, base_name,
    row_number() over (partition by lower(base_name) order by user_id) as duplicate_number
  from names
)
update public.staff s
set username = case when n.duplicate_number = 1 then n.base_name
                    else left(n.base_name, 23) || '-' || left(replace(n.user_id::text, '-', ''), 8) end
from numbered n where s.user_id = n.user_id;

alter table public.staff alter column username set not null;
alter table public.staff drop constraint if exists staff_username_format;
alter table public.staff add constraint staff_username_format
  check (username = lower(username) and username ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$');
create unique index if not exists staff_username_unique on public.staff (lower(username));

create or replace function public.my_username()
returns text
language sql stable security definer set search_path = public
as $$
  select s.username from public.staff s
  where s.user_id = auth.uid() and s.is_active;
$$;
revoke all on function public.my_username() from public;
grant execute on function public.my_username() to authenticated;

-- Keys are salted SHA-256 hashes produced by login-username. The table never
-- stores an IP address or a submitted username.
create table if not exists public.username_login_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0)
);
alter table public.username_login_limits enable row level security;
revoke all on public.username_login_limits from public, anon, authenticated;
grant select, insert, update, delete on public.username_login_limits to service_role;

create or replace function public.consume_username_login_attempt(ip_bucket text, identity_bucket text)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
  ip_attempts integer;
  identity_attempts integer;
begin
  if ip_bucket !~ '^[0-9a-f]{64}$' or identity_bucket !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into public.username_login_limits as limits (bucket_key, window_started_at, attempts)
  values ('ip:' || ip_bucket, now(), 1)
  on conflict (bucket_key) do update set
    window_started_at = case when limits.window_started_at < now() - interval '10 minutes' then now() else limits.window_started_at end,
    attempts = case when limits.window_started_at < now() - interval '10 minutes' then 1 else limits.attempts + 1 end
  returning attempts into ip_attempts;

  insert into public.username_login_limits as limits (bucket_key, window_started_at, attempts)
  values ('identity:' || identity_bucket, now(), 1)
  on conflict (bucket_key) do update set
    window_started_at = case when limits.window_started_at < now() - interval '10 minutes' then now() else limits.window_started_at end,
    attempts = case when limits.window_started_at < now() - interval '10 minutes' then 1 else limits.attempts + 1 end
  returning attempts into identity_attempts;

  delete from public.username_login_limits where window_started_at < now() - interval '1 day';
  return ip_attempts <= 20 and identity_attempts <= 8;
end $$;
revoke all on function public.consume_username_login_attempt(text,text) from public, anon, authenticated;
grant execute on function public.consume_username_login_attempt(text,text) to service_role;

commit;
