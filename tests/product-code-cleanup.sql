-- Phase 4B verification. Read-only: no production data is changed.
do $$
declare
  target_count integer;
  audit_count integer;
begin
  select count(*) into target_count
  from public.items
  where (id,code) in (
    ('r474','5991100420T'),('r232','5991301193T'),('r235','5991301103T'),
    ('r231','5991301194T'),('r233','5991301195T'),('r234','5991301196T'),
    ('r239','5991100496T'),('r473','5991301119T'),('r472','5991301148T'),
    ('r461','5991301209T')
  ) and active and dept='Project';
  if target_count<>10 then raise exception 'Expected 10 corrected Project items, found %',target_count; end if;

  if exists(
    select code from public.items
    where active and code in ('5991100420T','5991301193T','5991301103T','5991301194T','5991301195T','5991301196T','5991100496T','5991301119T','5991301148T','5991301209T')
    group by code having count(*)>1
  ) then raise exception 'A corrected code is duplicated'; end if;

  if (select code from public.items where id='r133') is distinct from '1196G30301T'
    or (select code from public.items where id='r134') is distinct from '1196F20001T'
    or coalesce((select code from public.items where id='r081'),'')<>''
    or coalesce((select code from public.items where id='r082'),'')<>''
    or (select code from public.items where id='r074') is distinct from 'T8FTbox'
  then raise exception 'A skipped Phase 4 item was changed'; end if;

  select count(distinct entity_id) into audit_count
  from public.stock_audit
  where entity='items' and action='update'
    and entity_id in ('r474','r232','r235','r231','r233','r234','r239','r473','r472','r461')
    and after_data->>'code' in ('5991100420T','5991301193T','5991301103T','5991301194T','5991301195T','5991301196T','5991100496T','5991301119T','5991301148T','5991301209T');
  if audit_count<>10 then raise exception 'Expected audit records for 10 corrected items, found %',audit_count; end if;
end $$;

select 'phase 4B product-code tests passed' as result;
