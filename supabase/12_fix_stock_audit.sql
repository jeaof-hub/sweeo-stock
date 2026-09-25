-- Fix the generic stock audit trigger so it also works for items, which do not
-- have movement-only deleted_at fields. Run after 11_usernames.sql.
-- Safe to run repeatedly.
begin;

create or replace function public.audit_stock_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  old_data jsonb;
  new_data jsonb;
  changed_id text;
  change_action text;
begin
  if tg_op = 'INSERT' then
    new_data := to_jsonb(new);
    changed_id := new.id::text;
    change_action := 'insert';
  elsif tg_op = 'DELETE' then
    old_data := to_jsonb(old);
    changed_id := old.id::text;
    change_action := 'delete';
  else
    old_data := to_jsonb(old);
    new_data := to_jsonb(new);
    changed_id := new.id::text;
    change_action := case
      when tg_table_name = 'movements'
        and (old_data ->> 'deleted_at') is null
        and (new_data ->> 'deleted_at') is not null
      then 'soft_delete'
      else 'update'
    end;
  end if;

  insert into public.stock_audit
    (actor_id, entity, entity_id, action, before_data, after_data)
  values
    (auth.uid(), tg_table_name, changed_id, change_action, old_data, new_data);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

revoke all on function public.audit_stock_change() from public;

commit;
