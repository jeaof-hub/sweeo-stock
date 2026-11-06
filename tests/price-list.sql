-- Run in the Supabase SQL Editor after supabase/33_price_list.sql and the private seed.
-- Read-only: it always ends with an exception, so every change is rolled back.
-- Expected result: an error that starts with SWEEO_PRICE_PROBE_OK followed by per-role row counts.
do $$
declare
  role_name text; actor uuid; n int; total int; report text := '';
  blocked boolean; tested_privileged int := 0;
begin
  select count(*) into total from public.price_list;
  if total = 0 then raise exception 'SWEEO_PRICE_PROBE_FAIL: price_list is empty'; end if;

  foreach role_name in array array['founder','owner','admin','warehouse','auditor'] loop
    select user_id into actor from public.staff where role = role_name and is_active limit 1;
    if actor is null then
      report := report || format(' %s=no-user', role_name); continue;
    end if;
    if role_name in ('founder','owner') then tested_privileged := tested_privileged + 1; end if;
    perform set_config('request.jwt.claim.sub', actor::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.price_list;
    blocked := false;
    begin
      update public.price_list set note = note where true;
      get diagnostics n = row_count;
      if n > 0 then blocked := false; else blocked := true; end if;
    exception when insufficient_privilege then blocked := true;
    end;
    begin
      insert into public.price_list(sort_order, category, commercial_name) values (0, 'probe', 'SWEEO_PROBE_ROW');
      blocked := false;
    exception when insufficient_privilege or check_violation then null;
    end;
    begin
      delete from public.price_list where true;
      get diagnostics n = row_count;
      if n > 0 then blocked := false; end if;
    exception when insufficient_privilege then null;
    end;
    select count(*) into n from public.price_list;
    reset role;
    if role_name in ('founder','owner') and n <> total then
      raise exception 'SWEEO_PRICE_PROBE_FAIL: % sees % of % rows', role_name, n, total; end if;
    if role_name not in ('founder','owner') and n <> 0 then
      raise exception 'SWEEO_PRICE_PROBE_FAIL: % can read % price rows', role_name, n; end if;
    if not blocked then raise exception 'SWEEO_PRICE_PROBE_FAIL: % can change prices', role_name; end if;
    report := report || format(' %s=%s', role_name, n);
  end loop;

  if tested_privileged = 0 then raise exception 'SWEEO_PRICE_PROBE_FAIL: no active founder/owner to test'; end if;

  -- Signed-in account with no staff row (visitor) must see nothing.
  actor := gen_random_uuid();
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.price_list;
  reset role;
  if n <> 0 then raise exception 'SWEEO_PRICE_PROBE_FAIL: visitor can read % price rows', n; end if;
  report := report || ' visitor=0';

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  blocked := false;
  begin
    select count(*) into n from public.price_list;
  exception when insufficient_privilege then blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'SWEEO_PRICE_PROBE_FAIL: anon can query price_list'; end if;

  raise exception 'SWEEO_PRICE_PROBE_OK: total=%;%; anon=denied; writes=denied', total, report;
end $$;
