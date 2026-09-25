-- Phase 3B production smoke tests. All changes roll back.
begin;
create temp table delivery_roles as select role,user_id from public.staff where is_active;
grant select on delivery_roles to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from delivery_roles where role='warehouse'),true);
set local role authenticated;
do $$
declare req uuid; line_row public.dispatch_request_lines%rowtype; note_no text;
begin
  req:=public.create_dispatch_request(current_date,current_date+1,'TEST CUSTOMER','TEST-DELIVERY','','','',jsonb_build_array(jsonb_build_object('item_id','r439','qty',2,'purpose','gift','return_required',true,'line_note','test note')));
  select * into line_row from public.dispatch_request_lines where request_id=req;
  select delivery_note_no into note_no from public.dispatch_requests where id=req;
  if note_no is null or note_no !~ '^TD-[0-9]{8}-[0-9]{5}$' then raise exception 'invalid delivery-note number: %',note_no; end if;
  if (select delivery_date from public.dispatch_requests where id=req)<>current_date+1 then raise exception 'delivery date was not saved'; end if;
  if line_row.purpose<>'gift' or not line_row.return_required or line_row.line_note<>'test note' then raise exception 'delivery line metadata was not saved'; end if;
  perform set_config('request.jwt.claim.sub',(select user_id::text from delivery_roles where role='admin'),true);
  perform public.approve_dispatch_request(req,jsonb_build_array(jsonb_build_object('line_id',line_row.id,'qty',1)));
  if (select approved_qty from public.dispatch_request_lines where id=line_row.id)<>1 then raise exception 'approved quantity was not retained'; end if;
end $$;
rollback;

select 'phase 3B delivery-note tests passed' as result;
