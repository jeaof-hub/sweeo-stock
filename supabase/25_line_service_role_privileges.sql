-- LINE L1: least-privilege table access used directly by Edge Functions.
begin;

grant select,insert,delete on table public.line_processed_events to service_role;
grant select,update on table public.staff_line_links to service_role;
grant select on table public.notification_outbox to service_role;
grant select on table public.dispatch_requests to service_role;
grant select on table public.dispatch_request_lines to service_role;
grant select on table public.items to service_role;

commit;
