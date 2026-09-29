-- Run after supabase/19_dashboard_metrics.sql against production or a production clone.
-- Read-only role and arithmetic verification. No rows are inserted or updated.
begin;

do $$
declare
  role_name text;
  actor uuid;
  payload jsonb;
  expected numeric;
begin
  foreach role_name in array array['founder','owner','admin','warehouse','auditor'] loop
    select user_id into actor from public.staff where role=role_name and is_active limit 1;
    if actor is null then continue; end if;
    perform set_config('request.jwt.claim.sub',actor::text,true);
    set local role authenticated;
    payload:=public.dashboard_summary();
    reset role;

    if payload is null or jsonb_typeof(payload->'reorder_items')<>'array'
      or jsonb_typeof(payload->'monthly_top_items')<>'array' then
      raise exception 'invalid dashboard payload for %',role_name;
    end if;
    if role_name in ('warehouse','auditor') and payload->'invoice_waiting_count'<>'null'::jsonb then
      raise exception '% can see the global invoice count',role_name;
    end if;
  end loop;

  select coalesce(sum(qty),0) into expected from public.movements
  where deleted_at is null and kind='out'
    and date>=date_trunc('week',timezone('Asia/Bangkok',now()))::date
    and date<date_trunc('week',timezone('Asia/Bangkok',now()))::date+7;
  select user_id into actor from public.staff where role='founder' and is_active limit 1;
  if actor is not null then
    perform set_config('request.jwt.claim.sub',actor::text,true);
    set local role authenticated;
    payload:=public.dashboard_summary();
    reset role;
    if (payload->>'weekly_out_qty')::numeric<>expected then raise exception 'weekly outbound mismatch'; end if;
  end if;
end $$;

rollback;
