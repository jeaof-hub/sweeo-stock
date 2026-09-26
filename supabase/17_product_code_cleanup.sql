-- Phase 4B: owner-reviewed product-code corrections for active Project items.
-- Data-specific migration. Safe to run repeatedly; do not apply to unrelated datasets.
begin;

create temp table phase4_code_updates (
  item_id text primary key,
  expected_dept text not null,
  old_code text not null,
  new_code text not null
) on commit drop;

insert into phase4_code_updates(item_id,expected_dept,old_code,new_code) values
  ('r474','Project','---1100420T','5991100420T'),
  ('r232','Project','---1301193T','5991301193T'),
  ('r235','Project','---1301103T','5991301103T'),
  ('r231','Project','---1301194T','5991301194T'),
  ('r233','Project','---1301195T','5991301195T'),
  ('r234','Project','---1301196T','5991301196T'),
  ('r239','Project','---1100496T','5991100496T'),
  ('r473','Project','---1301119T','5991301119T'),
  ('r472','Project','---1301148T','5991301148T'),
  ('r461','Project','---1301209T','5991301209T');

do $$
begin
  if (select count(*) from phase4_code_updates) <> 10 then
    raise exception 'Phase 4B must contain exactly 10 reviewed items';
  end if;
  if exists(select 1 from phase4_code_updates where new_code !~ '^599[0-9]{7}T$') then
    raise exception 'Phase 4B contains a non-standard new product code';
  end if;
  if exists(select new_code from phase4_code_updates group by new_code having count(*)>1) then
    raise exception 'Phase 4B contains duplicate proposed codes';
  end if;
  if exists(
    select 1 from phase4_code_updates u
    left join public.items i on i.id=u.item_id
    where i.id is null or not i.active or i.dept<>u.expected_dept or coalesce(i.code,'') not in (u.old_code,u.new_code)
  ) then
    raise exception 'Production item state no longer matches the reviewed Phase 4B file';
  end if;
  if exists(
    select 1 from phase4_code_updates u
    join public.items i on trim(coalesce(i.code,''))=u.new_code and i.id<>u.item_id and i.active
  ) then
    raise exception 'A reviewed Phase 4B code is already used by another active item';
  end if;
end $$;

update public.items i
set code=u.new_code
from phase4_code_updates u
where i.id=u.item_id and i.code=u.old_code;

do $$
begin
  if exists(
    select 1 from phase4_code_updates u
    left join public.items i on i.id=u.item_id
    where i.code is distinct from u.new_code
  ) then
    raise exception 'Phase 4B product-code update did not complete';
  end if;
end $$;

commit;
