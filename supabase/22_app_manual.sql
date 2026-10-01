-- Phase 7: role-scoped in-app manual. This migration never touches stock data.
begin;

create table if not exists public.app_manual_sections (
  slug text not null,
  lang text not null check (lang in ('th','zh-TW')),
  sort_order integer not null,
  roles text[] not null,
  title text not null,
  body_md text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (slug, lang),
  check (cardinality(roles) > 0),
  check (roles <@ array['visitor','warehouse','admin','owner','founder','auditor']::text[])
);

alter table public.app_manual_sections enable row level security;
revoke all on table public.app_manual_sections from public, anon, authenticated;
grant select, insert, update, delete on table public.app_manual_sections to service_role;

create or replace function public.get_manual(p_lang text default 'th')
returns table (
  slug text,
  title text,
  body_md text,
  sort_order integer,
  lang text,
  fallback boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with request_context as (
    select
      case
        when auth.uid() is null then 'visitor'
        else coalesce((
          select s.role from public.staff s
          where s.user_id = auth.uid() and s.is_active
          limit 1
        ), 'visitor')
      end as caller_role,
      case when p_lang in ('th','zh-TW') then p_lang else 'th' end as effective_lang,
      p_lang not in ('th','zh-TW') or p_lang is null as used_fallback
  )
  select m.slug, m.title, m.body_md, m.sort_order, m.lang, c.used_fallback
  from public.app_manual_sections m
  cross join request_context c
  where m.lang = c.effective_lang
    and c.caller_role = any(m.roles)
  order by m.sort_order, m.slug;
$$;

revoke all on function public.get_manual(text) from public;
grant execute on function public.get_manual(text) to anon, authenticated;

commit;
