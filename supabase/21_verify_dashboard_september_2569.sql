-- Read-only verification for Phase 6A adjustment exclusions.
-- Produces aggregate NOTICE output only; no customer or document data is returned.
do $$
declare
  unfiltered_total numeric;
  excluded_total numeric;
  filtered_total numeric;
  unfiltered_top jsonb;
  filtered_top jsonb;
begin
  select coalesce(sum(m.qty),0),
    coalesce(sum(m.qty) filter (where lower(trim(coalesce(m.source,'')))='adjustment'
      or lower(trim(coalesce(m.dept,'')))='stock adjust'),0),
    coalesce(sum(m.qty) filter (where lower(trim(coalesce(m.source,'')))<>'adjustment'
      and lower(trim(coalesce(m.dept,'')))<>'stock adjust'),0)
  into unfiltered_total,excluded_total,filtered_total
  from public.movements m
  where m.deleted_at is null and m.kind='out'
    and m.date>=date '2026-09-01' and m.date<date '2026-10-01';

  if filtered_total<>unfiltered_total-excluded_total then
    raise exception 'September dashboard total exclusion mismatch';
  end if;

  with ranked as (
    select m.item_id,coalesce(nullif(i.code,''),m.code) code,
      coalesce(nullif(i.model,''),m.model) model,sum(m.qty) qty
    from public.movements m left join public.items i on i.id=m.item_id
    where m.deleted_at is null and m.kind='out'
      and m.date>=date '2026-09-01' and m.date<date '2026-10-01'
    group by m.item_id,coalesce(nullif(i.code,''),m.code),coalesce(nullif(i.model,''),m.model)
    order by sum(m.qty) desc,m.item_id limit 5
  ) select coalesce(jsonb_agg(to_jsonb(ranked) order by qty desc,item_id),'[]'::jsonb) into unfiltered_top from ranked;

  with ranked as (
    select m.item_id,coalesce(nullif(i.code,''),m.code) code,
      coalesce(nullif(i.model,''),m.model) model,sum(m.qty) qty
    from public.movements m left join public.items i on i.id=m.item_id
    where m.deleted_at is null and m.kind='out'
      and lower(trim(coalesce(m.source,'')))<>'adjustment'
      and lower(trim(coalesce(m.dept,'')))<>'stock adjust'
      and m.date>=date '2026-09-01' and m.date<date '2026-10-01'
    group by m.item_id,coalesce(nullif(i.code,''),m.code),coalesce(nullif(i.model,''),m.model)
    order by sum(m.qty) desc,m.item_id limit 5
  ) select coalesce(jsonb_agg(to_jsonb(ranked) order by qty desc,item_id),'[]'::jsonb) into filtered_top from ranked;

  raise notice 'September 2026 outbound: before=%, excluded=%, dashboard=%',unfiltered_total,excluded_total,filtered_total;
  raise notice 'September 2026 top five before: %',unfiltered_top;
  raise notice 'September 2026 top five dashboard: %',filtered_top;
end $$;
