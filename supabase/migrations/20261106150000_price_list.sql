-- Price list (Triple P adjusted price + Project price), view-only for founder and owner.
-- Schema only. Price rows are loaded separately from a private seed that is never committed.
begin;

create table if not exists public.price_list (
  id uuid primary key default gen_random_uuid(),
  sort_order int not null,
  category text not null,
  commercial_name text not null unique,
  project_name text,
  watt text,
  pack_triplep text,
  pack_project text,
  triplep_ex_vat numeric(12,2),
  triplep_in_vat numeric(12,2),
  project_ex_vat numeric(12,2),
  project_in_vat numeric(12,2),
  note text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.price_list enable row level security;
-- Supabase grants new public tables to anon/authenticated by default; remove every grant first.
revoke all on table public.price_list from public, anon, authenticated;
grant select on table public.price_list to authenticated;

drop policy if exists price_list_founder_owner_read on public.price_list;
create policy price_list_founder_owner_read on public.price_list
  for select to authenticated
  using (public.is_founder_or_owner());
-- No insert/update/delete policy or grant: the app cannot change prices.

commit;
