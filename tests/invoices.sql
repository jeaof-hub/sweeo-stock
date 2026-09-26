-- Phase 6A production role/invariant tests. Everything rolls back.
begin;

create temp table invoice_test_users as select role,user_id from public.staff where is_active and role in ('founder','owner','admin','warehouse','auditor');
create temp table invoice_test_ids(label text primary key,id uuid not null);
create temp table invoice_baseline as
select (select count(*) from public.movements) movement_count,
       ((select coalesce(sum(opening),0) from public.items)
        +(select coalesce(sum(case when kind='in' then qty else -qty end),0) from public.movements where deleted_at is null)) total_balance;

do $$
declare warehouse_id uuid; req_a uuid:=gen_random_uuid(); req_b uuid:=gen_random_uuid(); req_pending uuid:=gen_random_uuid(); req_rejected uuid:=gen_random_uuid(); req_cancelled uuid:=gen_random_uuid(); item_ids text[]; i int; line_id uuid;
begin
  select user_id into warehouse_id from invoice_test_users where role='warehouse' limit 1;
  if warehouse_id is null or not exists(select 1 from invoice_test_users where role='admin') then raise exception 'invoice tests require active admin and warehouse users'; end if;
  select array_agg(id order by id) into item_ids from (select id from public.items where active order by id limit 12) q;
  insert into public.dispatch_requests(id,requester_id,requester_role,status,document_date,delivery_date,delivery_note_no,customer,doc_no)
  values
    (req_a,warehouse_id,'warehouse','approved',current_date-5,current_date-4,'TEST-INV-A','Customer A','LEGACY-A'),
    (req_b,warehouse_id,'warehouse','approved',current_date-4,current_date-3,'TEST-INV-B','Customer A',''),
    (req_pending,warehouse_id,'warehouse','pending',current_date,current_date,'TEST-INV-P','Customer A',''),
    (req_rejected,warehouse_id,'warehouse','rejected',current_date,current_date,'TEST-INV-R','Customer A',''),
    (req_cancelled,warehouse_id,'warehouse','cancelled',current_date,current_date,'TEST-INV-C','Customer A','');
  insert into invoice_test_ids values('req_a',req_a),('req_b',req_b),('req_pending',req_pending),('req_rejected',req_rejected),('req_cancelled',req_cancelled);
  for i in 1..5 loop
    line_id:=gen_random_uuid();
    insert into public.dispatch_request_lines(id,request_id,item_id,code,model,requested_qty,approved_qty,purpose)
    select line_id,req_a,id,code,model,1,1,case when i=5 then 'gift' else 'sale' end from public.items where id=item_ids[i];
    insert into invoice_test_ids values('a'||i,line_id);
  end loop;
  for i in 1..4 loop
    line_id:=gen_random_uuid();
    insert into public.dispatch_request_lines(id,request_id,item_id,code,model,requested_qty,approved_qty,purpose)
    select line_id,req_b,id,code,model,1,1,'sale' from public.items where id=item_ids[i+5];
    insert into invoice_test_ids values('b'||i,line_id);
  end loop;
  for i in 1..3 loop
    line_id:=gen_random_uuid();
    insert into public.dispatch_request_lines(id,request_id,item_id,code,model,requested_qty,purpose)
    select line_id,case i when 1 then req_pending when 2 then req_rejected else req_cancelled end,id,code,model,1,'sale' from public.items where id=item_ids[i+9];
    insert into invoice_test_ids values(case i when 1 then 'pending_line' when 2 then 'rejected_line' else 'cancelled_line' end,line_id);
  end loop;
end $$;

grant select on invoice_test_users to authenticated;
grant select,insert on invoice_test_ids to authenticated;

-- The RPC permission gate must match every application role.
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='founder' limit 1),true);
set local role authenticated;
do $$ begin if not public.can_manage_invoices() then raise exception 'founder must manage invoices'; end if; end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='owner' limit 1),true);
set local role authenticated;
do $$ begin if not public.can_manage_invoices() then raise exception 'owner must manage invoices'; end if; end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='admin' limit 1),true);
set local role authenticated;
do $$ begin if not public.can_manage_invoices() then raise exception 'admin must manage invoices'; end if; end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='warehouse' limit 1),true);
set local role authenticated;
do $$ begin if public.can_manage_invoices() then raise exception 'warehouse must not manage invoices'; end if; end $$;
reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='auditor' limit 1),true);
set local role authenticated;
do $$ begin if public.can_manage_invoices() then raise exception 'auditor must not manage invoices'; end if; end $$;
reset role;

select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='admin' limit 1),true);
set local role authenticated;

do $$
declare inv1 uuid; inv2 uuid; ids uuid[];
begin
  select array_agg(id order by label) into ids from invoice_test_ids where label in ('a1','a2','a3','a4','b1','b2','b3');
  inv1:=public.create_invoice('TEST-INV-001',current_date,'Customer A',ids);
  select array_agg(id order by label) into ids from invoice_test_ids where label in ('a5','b4');
  inv2:=public.create_invoice('TEST-INV-002',current_date,'Different customer',ids);
  insert into invoice_test_ids values('inv1',inv1),('inv2',inv2);
  if (select count(*) from public.dispatch_request_lines where invoice_id=inv1)<>7 then raise exception 'INV1 line count mismatch'; end if;
  if (select count(*) from public.dispatch_request_lines where invoice_id=inv2)<>2 then raise exception 'INV2 line count mismatch'; end if;

  begin perform public.attach_invoice_lines(inv2,array[(select id from invoice_test_ids where label='a1')]); raise exception 'same line linked twice'; exception when raise_exception then if sqlerrm='same line linked twice' then raise; end if; end;
  begin perform public.create_invoice('test-inv-001',current_date,'x',array[(select id from invoice_test_ids where label='pending_line')]); raise exception 'duplicate number accepted'; exception when unique_violation then null; end;
  begin perform public.attach_invoice_lines(inv2,array[(select id from invoice_test_ids where label='pending_line')]); raise exception 'pending line accepted'; exception when raise_exception then if sqlerrm='pending line accepted' then raise; end if; end;
  begin perform public.attach_invoice_lines(inv2,array[(select id from invoice_test_ids where label='rejected_line')]); raise exception 'rejected line accepted'; exception when raise_exception then if sqlerrm='rejected line accepted' then raise; end if; end;
  begin perform public.attach_invoice_lines(inv2,array[(select id from invoice_test_ids where label='cancelled_line')]); raise exception 'cancelled line accepted'; exception when raise_exception then if sqlerrm='cancelled line accepted' then raise; end if; end;
  begin perform public.mark_line_no_invoice((select id from invoice_test_ids where label='b4'),'not allowed'); raise exception 'sale marked no invoice'; exception when raise_exception then if sqlerrm='sale marked no invoice' then raise; end if; end;
  perform public.detach_invoice_line((select id from invoice_test_ids where label='a5'));
  perform public.mark_line_no_invoice((select id from invoice_test_ids where label='a5'),'สินค้าตัวอย่าง ไม่เรียกเก็บเงิน');
  if not exists(select 1 from public.dispatch_request_lines where id=(select id from invoice_test_ids where label='a5') and invoice_id is null and no_invoice_reason is not null) then raise exception 'no-invoice status missing'; end if;
  perform public.clear_line_no_invoice((select id from invoice_test_ids where label='a5'));
  perform public.update_invoice(inv1,'TEST-INV-001A',current_date-1,'Customer A revised');
  perform public.cancel_invoice(inv2);
  if exists(select 1 from public.dispatch_request_lines where invoice_id=inv2) then raise exception 'cancel did not unlink lines'; end if;
end $$;

reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='warehouse' limit 1),true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.invoices)<>1 then raise exception 'warehouse invoice visibility mismatch'; end if;
  begin perform public.create_invoice('WAREHOUSE-DENIED',current_date,'x',array[(select id from invoice_test_ids where label='a5')]); raise exception 'warehouse created invoice';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
select set_config('request.jwt.claim.sub',(select user_id::text from invoice_test_users where role='auditor' limit 1),true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.invoices)<>2 then raise exception 'auditor invoice visibility mismatch'; end if;
  begin perform public.create_invoice('AUDITOR-DENIED',current_date,'x',array[(select id from invoice_test_ids where label='a5')]); raise exception 'auditor created invoice';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
do $$
declare before_count bigint; before_balance numeric; after_count bigint; after_balance numeric;
begin
  select movement_count,total_balance into before_count,before_balance from invoice_baseline;
  select count(*) into after_count from public.movements;
  select (select coalesce(sum(opening),0) from public.items)
       +(select coalesce(sum(case when kind='in' then qty else -qty end),0) from public.movements where deleted_at is null)
  into after_balance;
  if before_count<>after_count or before_balance<>after_balance then raise exception 'invoice workflow changed movements or stock: %/% -> %/%',before_count,before_balance,after_count,after_balance; end if;
  if (select count(*) from public.stock_audit where entity in ('invoices','invoice_lines') and entity_id in (select id::text from invoice_test_ids))<12 then raise exception 'invoice audit entries missing'; end if;
end $$;

rollback;
select 'phase 6A invoice tests passed' as result;
