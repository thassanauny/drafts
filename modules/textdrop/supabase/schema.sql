-- TextDrop: run once in the existing IOU project's Supabase SQL editor as administrator.
-- This additive transaction leaves IOU and Kanban objects unchanged.
-- Keep private OUT of the Data API's exposed schemas.
begin;

create schema if not exists private;

create table public.textdrop_pages (
  id uuid primary key,
  code text not null unique check (code ~ '^[a-f0-9]{32}$'),
  content text not null default '' check (octet_length(content) <= 1048576),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.textdrop_page_access (
  page_id uuid not null references public.textdrop_pages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (page_id, user_id)
);

create index textdrop_page_access_user_idx on public.textdrop_page_access (user_id, page_id);
create index textdrop_pages_creator_idx on public.textdrop_pages (created_by);

alter table public.textdrop_pages enable row level security;
alter table public.textdrop_page_access enable row level security;
revoke all on public.textdrop_pages, public.textdrop_page_access from public, anon, authenticated;
grant select on public.textdrop_pages, public.textdrop_page_access to authenticated;

create policy textdrop_read_own_access on public.textdrop_page_access
  for select to authenticated using (user_id = (select auth.uid()));
create policy textdrop_read_joined_pages on public.textdrop_pages
  for select to authenticated using (exists (
    select 1 from public.textdrop_page_access access
    where access.page_id = textdrop_pages.id and access.user_id = (select auth.uid())
  ));

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

commit;
