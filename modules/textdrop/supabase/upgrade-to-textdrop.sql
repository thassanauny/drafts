-- TextDrop: upgrade the earlier installation in the same Supabase project.
-- Run as administrator. Existing IDs, codes, text, versions and access survive.
-- The transaction refuses missing, incomplete or mixed legacy/current tables.
-- A rerun against a completed TextDrop installation is safe.
begin;

do $$
declare
  legacy_pages boolean := to_regclass('public.paste_pages') is not null;
  legacy_access boolean := to_regclass('public.paste_page_access') is not null;
  current_pages boolean := to_regclass('public.textdrop_pages') is not null;
  current_access boolean := to_regclass('public.textdrop_page_access') is not null;
  object_row record;
begin
  if (legacy_pages or legacy_access) and (current_pages or current_access) then
    raise exception 'TEXTDROP_UPGRADE_AMBIGUOUS: legacy and TextDrop tables both exist; resolve this before upgrading';
  end if;
  if legacy_pages or legacy_access then
    if not (legacy_pages and legacy_access) then
      raise exception 'TEXTDROP_UPGRADE_INCOMPLETE: both legacy tables are required';
    end if;
    alter table public.paste_pages rename to textdrop_pages;
    alter table public.paste_page_access rename to textdrop_page_access;
  elsif current_pages or current_access then
    if not (current_pages and current_access) then
      raise exception 'TEXTDROP_UPGRADE_INCOMPLETE: both TextDrop tables are required';
    end if;
  else
    raise exception 'TEXTDROP_UPGRADE_MISSING_SCHEMA: install schema.sql for a new project';
  end if;

  -- Renaming constraints also renames their primary/unique indexes.
  for object_row in
    select constraint_row.conname, table_row.relname
    from pg_constraint constraint_row join pg_class table_row on table_row.oid = constraint_row.conrelid
    where constraint_row.conrelid in ('public.textdrop_pages'::regclass, 'public.textdrop_page_access'::regclass)
      and left(constraint_row.conname, 6) = 'paste_'
  loop
    execute format('alter table public.%I rename constraint %I to %I',
      object_row.relname, object_row.conname, 'textdrop_' || substr(object_row.conname, 7));
  end loop;
  for object_row in
    select indexname from pg_indexes
    where schemaname = 'public' and tablename in ('textdrop_pages','textdrop_page_access')
      and left(indexname, 6) = 'paste_'
  loop
    execute format('alter index public.%I rename to %I', object_row.indexname,
      'textdrop_' || substr(object_row.indexname, 7));
  end loop;
  for object_row in
    select policy_row.polname, table_row.relname
    from pg_policy policy_row join pg_class table_row on table_row.oid = policy_row.polrelid
    where policy_row.polrelid in ('public.textdrop_pages'::regclass, 'public.textdrop_page_access'::regclass)
      and left(policy_row.polname, 6) = 'paste_'
  loop
    execute format('alter policy %I on public.%I rename to %I', object_row.polname,
      object_row.relname, 'textdrop_' || substr(object_row.polname, 7));
  end loop;
end;
$$;

create schema if not exists private;

create or replace function private.textdrop_page_json(p_page public.textdrop_pages)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_object('id', p_page.id, 'code', p_page.code, 'text', p_page.content,
    'version', p_page.version, 'updatedAt', p_page.updated_at);
$$;

create or replace function private.textdrop_create_page(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  invitation text;
  page_row public.textdrop_pages%rowtype;
begin
  if caller is null then raise exception 'TEXTDROP_AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_id is null then raise exception 'TEXTDROP_INVALID_PAGE' using errcode = '22023'; end if;
  -- Serialize this session's create/join limits, including concurrent requests.
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9185));
  select * into page_row from public.textdrop_pages where id = p_id;
  if found then
    if page_row.created_by = caller and exists (
      select 1 from public.textdrop_page_access where page_id = page_row.id and user_id = caller
    ) then return private.textdrop_page_json(page_row); end if;
    raise exception 'TEXTDROP_INVALID_PAGE' using errcode = '22023';
  end if;
  if (select count(*) from public.textdrop_pages where created_by = caller) >= 100
    or (select count(*) from public.textdrop_page_access where user_id = caller) >= 1000
  then raise exception 'TEXTDROP_PAGE_LIMIT' using errcode = 'P0001'; end if;
  loop
    invitation := replace(gen_random_uuid()::text, '-', '');
    begin
      insert into public.textdrop_pages (id, code, created_by)
      values (p_id, invitation, caller) returning * into page_row;
      exit;
    exception when unique_violation then
      -- Retry random invitation collisions without revealing an existing ID.
      if exists (select 1 from public.textdrop_pages where id = p_id) then
        raise exception 'TEXTDROP_INVALID_PAGE' using errcode = '22023';
      end if;
    end;
  end loop;
  insert into public.textdrop_page_access (page_id, user_id) values (page_row.id, caller);
  return private.textdrop_page_json(page_row);
end;
$$;

create or replace function private.textdrop_join_page(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  normalized text := lower(regexp_replace(p_code, E'[\u0009-\u000d\u0020\u002d]+', '', 'g'));
  page_row public.textdrop_pages%rowtype;
begin
  if caller is null then raise exception 'TEXTDROP_AUTH_REQUIRED' using errcode = '42501'; end if;
  if normalized is null or normalized !~ '^[a-f0-9]{32}$' then
    raise exception 'TEXTDROP_INVALID_CODE' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9185));
  select * into page_row from public.textdrop_pages where code = normalized;
  if not found then raise exception 'TEXTDROP_INVALID_CODE' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.textdrop_page_access where page_id = page_row.id and user_id = caller)
    and (select count(*) from public.textdrop_page_access where user_id = caller) >= 1000
  then raise exception 'TEXTDROP_PAGE_LIMIT' using errcode = 'P0001'; end if;
  insert into public.textdrop_page_access (page_id, user_id) values (page_row.id, caller) on conflict do nothing;
  return private.textdrop_page_json(page_row);
end;
$$;

create or replace function private.textdrop_load_page(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  page_row public.textdrop_pages%rowtype;
begin
  if caller is null then raise exception 'TEXTDROP_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.textdrop_page_access where page_id = p_id and user_id = caller)
    then raise exception 'TEXTDROP_ACCESS_DENIED' using errcode = '42501'; end if;
  select * into page_row from public.textdrop_pages where id = p_id;
  if not found then raise exception 'TEXTDROP_ACCESS_DENIED' using errcode = '42501'; end if;
  return private.textdrop_page_json(page_row);
end;
$$;

create or replace function private.textdrop_save_page(p_id uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  page_row public.textdrop_pages%rowtype;
begin
  if caller is null then raise exception 'TEXTDROP_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.textdrop_page_access where page_id = p_id and user_id = caller)
    then raise exception 'TEXTDROP_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_text is null or octet_length(p_text) > 1048576
    then raise exception 'TEXTDROP_INVALID_TEXT' using errcode = '22023'; end if;
  -- Every accepted save replaces the entire page after locking the current row.
  -- The server's acceptance order determines the winner, never a device clock.
  select * into page_row from public.textdrop_pages where id = p_id for update;
  if not found then raise exception 'TEXTDROP_ACCESS_DENIED' using errcode = '42501'; end if;
  if page_row.version = 9007199254740991
    then raise exception 'TEXTDROP_VERSION_LIMIT' using errcode = 'P0001'; end if;
  update public.textdrop_pages set content = p_text, version = version + 1, updated_at = clock_timestamp()
    where id = page_row.id returning * into page_row;
  return private.textdrop_page_json(page_row);
end;
$$;

-- Invoker entry points are exposed; checked privileged implementations stay private.
create or replace function public.textdrop_create_page(p_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.textdrop_create_page(p_id);
$$;
create or replace function public.textdrop_join_page(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.textdrop_join_page(p_code);
$$;
create or replace function public.textdrop_load_page(p_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.textdrop_load_page(p_id);
$$;
create or replace function public.textdrop_save_page(p_id uuid, p_text text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.textdrop_save_page(p_id, p_text);
$$;

revoke all on function private.textdrop_page_json(public.textdrop_pages), private.textdrop_create_page(uuid),
  private.textdrop_join_page(text), private.textdrop_load_page(uuid), private.textdrop_save_page(uuid,text)
  from public, anon, authenticated;
revoke all on function public.textdrop_create_page(uuid), public.textdrop_join_page(text),
  public.textdrop_load_page(uuid), public.textdrop_save_page(uuid,text) from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.textdrop_create_page(uuid), private.textdrop_join_page(text),
  private.textdrop_load_page(uuid), private.textdrop_save_page(uuid,text) to authenticated;
grant execute on function public.textdrop_create_page(uuid), public.textdrop_join_page(text),
  public.textdrop_load_page(uuid), public.textdrop_save_page(uuid,text) to authenticated;

-- Remove obsolete entry points without CASCADE: unexpected dependencies cause
-- rollback instead of silently deleting unrelated objects.
drop function if exists public.paste_create_page(uuid), public.paste_join_page(text),
  public.paste_load_page(uuid), public.paste_save_page(uuid,text);
drop function if exists private.paste_create_page(uuid), private.paste_join_page(text),
  private.paste_load_page(uuid), private.paste_save_page(uuid,text);
-- The table rename updates the serializer's composite argument type in place.
drop function if exists private.paste_page_json(public.textdrop_pages);

notify pgrst, 'reload schema';
commit;
