-- Phase 6A: role-scoped dashboard metrics.
-- Read-only: this migration creates one stable RPC and never writes stock data.
begin;

create or replace function public.dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller_role text;
  bangkok_today date := timezone('Asia/Bangkok', now())::date;
  week_start date;
  month_start date;
  result jsonb;
begin
  select s.role into caller_role
  from public.staff s
  where s.user_id = auth.uid() and s.is_active;

  if caller_role is null or caller_role not in ('founder','owner','admin','warehouse','auditor') then
    raise exception using errcode='42501', message='ไม่มีสิทธิ์ดู Dashboard';
  end if;

  week_start := date_trunc('week', bangkok_today::timestamp)::date;
  month_start := date_trunc('month', bangkok_today::timestamp)::date;

  with balances as (
    select i.id, i.code, i.model, i.spec, i.rop, i.sort_order,
      i.opening + coalesce(sum(case when m.kind='in' then m.qty else -m.qty end),0) as balance
    from public.items i
    left join public.movements m on m.item_id=i.id and m.deleted_at is null
    where i.active
    group by i.id
  ), reorder_rows as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'model', b.model, 'spec', b.spec,
      'balance', b.balance, 'rop', b.rop,
      'severity', case when b.balance<=b.rop then 'red' else 'amber' end
    ) order by (b.balance/nullif(b.rop,0)), b.sort_order, b.id), '[]'::jsonb) value
    from balances b
    where b.rop is not null and b.rop>0 and b.balance<=b.rop*1.3
  ), top_rows as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', ranked.item_id, 'code', ranked.code, 'model', ranked.model,
      'qty', ranked.qty
    ) order by ranked.qty desc, ranked.item_id), '[]'::jsonb) value
    from (
      select m.item_id, coalesce(nullif(i.code,''),m.code) code,
        coalesce(nullif(i.model,''),m.model) model, sum(m.qty) qty
      from public.movements m
      left join public.items i on i.id=m.item_id
      where m.deleted_at is null and m.kind='out'
        and m.date>=month_start and m.date<month_start+interval '1 month'
      group by m.item_id, coalesce(nullif(i.code,''),m.code), coalesce(nullif(i.model,''),m.model)
      order by sum(m.qty) desc, m.item_id
      limit 5
    ) ranked
  )
  select jsonb_build_object(
    'as_of', bangkok_today,
    'week_start', week_start,
    'month_start', month_start,
    'reorder_items', reorder_rows.value,
    'pending_approval_count', (
      select count(*) from public.dispatch_requests r
      where r.status='pending' and r.requester_id<>auth.uid()
        and case
          when caller_role='admin' then r.requester_role='warehouse'
          when caller_role in ('owner','founder') then r.requester_role in ('warehouse','admin')
          else false
        end
    ),
    'invoice_waiting_count', case when caller_role in ('admin','owner','founder') then (
      select count(*) from public.dispatch_request_lines l
      join public.dispatch_requests r on r.id=l.request_id
      where r.status='approved' and l.invoice_id is null
        and nullif(trim(l.no_invoice_reason),'') is null
    ) else null end,
    'weekly_out_qty', (
      select coalesce(sum(m.qty),0) from public.movements m
      where m.deleted_at is null and m.kind='out'
        and m.date>=week_start and m.date<week_start+7
    ),
    'monthly_top_items', top_rows.value
  ) into result
  from reorder_rows, top_rows;

  return result;
end $$;

revoke all on function public.dashboard_summary() from public, anon;
grant execute on function public.dashboard_summary() to authenticated;

commit;
