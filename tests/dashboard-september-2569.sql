-- Read-only production check for September 2026 (B.E. 2569).
-- Run as an active Founder. Returns expected totals and top five for comparison
-- with dashboard_summary(). No production rows are changed.
with eligible as (
  select m.item_id,coalesce(nullif(i.code,''),m.code) code,
    coalesce(nullif(i.model,''),m.model) model,m.qty
  from public.movements m
  left join public.items i on i.id=m.item_id
  where m.deleted_at is null and m.kind='out'
    and lower(trim(coalesce(m.source,'')))<>'adjustment'
    and lower(trim(coalesce(m.dept,'')))<>'stock adjust'
    and m.date>=date '2026-09-01' and m.date<date '2026-10-01'
), expected_top as (
  select item_id,code,model,sum(qty) qty
  from eligible group by item_id,code,model order by sum(qty) desc,item_id limit 5
)
select 'september_out_total' check_name,to_jsonb(coalesce(sum(qty),0)) result from eligible
union all
select 'september_top_five',coalesce(jsonb_agg(to_jsonb(expected_top) order by qty desc,item_id),'[]'::jsonb) from expected_top;

select public.dashboard_summary() as september_dashboard_payload;
