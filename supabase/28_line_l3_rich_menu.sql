begin;

alter table public.line_settings add column if not exists member_rich_menu_id text;
alter table public.line_settings add column if not exists approver_rich_menu_id text;
alter table public.staff_line_links add column if not exists rich_menu_id text;

create or replace function public.line_rich_menu_settings()
returns table(member_rich_menu_id text,approver_rich_menu_id text)
language sql stable security definer set search_path=public as $$
  select s.member_rich_menu_id,s.approver_rich_menu_id from public.line_settings s where s.singleton;
$$;

create or replace function public.line_save_rich_menus(p_member text,p_approver text)
returns void language plpgsql volatile security definer set search_path=public as $$
begin
  if coalesce(p_member,'')='' or coalesce(p_approver,'')='' then raise exception 'rich menu ids are required'; end if;
  update public.line_settings set member_rich_menu_id=p_member,approver_rich_menu_id=p_approver,updated_at=now() where singleton;
end;
$$;

revoke all on function public.line_rich_menu_settings(),public.line_save_rich_menus(text,text) from public,anon,authenticated;
grant execute on function public.line_rich_menu_settings(),public.line_save_rich_menus(text,text) to service_role;

commit;
