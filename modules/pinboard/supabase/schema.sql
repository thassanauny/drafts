-- Pinboard: run once in the existing IOU project's Supabase SQL editor as administrator.
-- This additive transaction does not change IOU tables, functions, or policies.
-- Keep private OUT of the Data API's exposed schemas.
begin;

create schema if not exists private;

create or replace function private.pinboard_has_keys(p_value jsonb, p_keys text[])
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  return p_value ?& p_keys and not exists (
    select 1 from jsonb_object_keys(p_value) as keys(key) where not (key = any(p_keys))
  );
end;
$$;

create or replace function private.pinboard_allowed_keys(p_value jsonb, p_keys text[])
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  return not exists (
    select 1 from jsonb_object_keys(p_value) as keys(key) where not (key = any(p_keys))
  );
end;
$$;

create or replace function private.pinboard_valid_text(p_value jsonb, p_max integer, p_required boolean default true)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  value := p_value #>> '{}';
  -- Match JavaScript UTF-16 lengths and its whitespace-only strings.
  return char_length(value) + char_length(regexp_replace(value, E'[^\U00010000-\U0010ffff]', '', 'g')) <= p_max
    and (not p_required or value !~ E'^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$')
    and value !~ E'[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]';
end;
$$;

create or replace function private.pinboard_valid_uuid(p_value jsonb)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
$$;

create or replace function private.pinboard_valid_column_id(p_value jsonb)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    and (p_value #>> '{}') not in ('__proto__', 'constructor', 'prototype');
$$;

create or replace function private.pinboard_valid_date(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  value := p_value #>> '{}';
  if value = '' then return true; end if;
  if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  return to_char(value::date, 'YYYY-MM-DD') = value;
exception when others then return false;
end;
$$;

create or replace function private.pinboard_valid_position(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
  value := (p_value #>> '{}')::numeric;
  return value >= 0 and value <= 1000000000000;
exception when others then return false;
end;
$$;

create or replace function private.pinboard_valid_state(p_columns jsonb, p_cards jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare
  column_value jsonb;
  card_value jsonb;
  label jsonb;
  column_ids text[] := '{}'::text[];
  card_ids text[] := '{}'::text[];
begin
  if jsonb_typeof(p_columns) is distinct from 'array' or jsonb_typeof(p_cards) is distinct from 'array'
    then return false; end if;
  if jsonb_array_length(p_columns) not between 1 and 20 or jsonb_array_length(p_cards) > 2000
    then return false; end if;
  for column_value in select value from jsonb_array_elements(p_columns) loop
    if not private.pinboard_has_keys(column_value, array['id','title','color'])
      or not coalesce(private.pinboard_valid_column_id(column_value->'id'), false)
      or not private.pinboard_valid_text(column_value->'title', 160)
      or jsonb_typeof(column_value->'color') is distinct from 'string'
      or (column_value->>'color') not in ('slate','blue','amber','emerald','rose','violet')
      or (column_value->>'id') = any(column_ids)
    then return false; end if;
    column_ids := array_append(column_ids, column_value->>'id');
  end loop;
  for card_value in select value from jsonb_array_elements(p_cards) loop
    if not private.pinboard_has_keys(card_value, array['id','title','description','columnId','position','priority','assignee','dueDate','labels'])
      or not coalesce(private.pinboard_valid_uuid(card_value->'id'), false)
      or not private.pinboard_valid_text(card_value->'title', 160)
      or not private.pinboard_valid_text(card_value->'description', 10000, false)
      or jsonb_typeof(card_value->'columnId') is distinct from 'string'
      or not ((card_value->>'columnId') = any(column_ids))
      or not private.pinboard_valid_position(card_value->'position')
      or jsonb_typeof(card_value->'priority') is distinct from 'string'
      or (card_value->>'priority') not in ('low','medium','high')
      or not private.pinboard_valid_text(card_value->'assignee', 80, false)
      or not private.pinboard_valid_date(card_value->'dueDate')
      or jsonb_typeof(card_value->'labels') is distinct from 'array'
      or (card_value->>'id') = any(card_ids)
    then return false; end if;
    if jsonb_array_length(card_value->'labels') > 8 then return false; end if;
    for label in select value from jsonb_array_elements(card_value->'labels') loop
      if not private.pinboard_valid_text(label, 30) then return false; end if;
    end loop;
    card_ids := array_append(card_ids, card_value->>'id');
  end loop;
  return true;
exception when others then return false;
end;
$$;

create table public.pinboard_boards (
  id uuid primary key,
  invite_code text not null unique check (invite_code ~ '^[a-f0-9]{32}$'),
  title text not null check (private.pinboard_valid_text(to_jsonb(title), 160)),
  description text not null default '' check (private.pinboard_valid_text(to_jsonb(description), 10000, false)),
  columns jsonb not null,
  cards jsonb not null default '[]'::jsonb,
  deleted_card_ids text[] not null default '{}'::text[],
  deleted_column_ids text[] not null default '{}'::text[],
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (private.pinboard_valid_state(columns, cards))
);

create table public.pinboard_board_access (
  board_id uuid not null references public.pinboard_boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create index pinboard_board_access_user_idx on public.pinboard_board_access (user_id, board_id);
create index pinboard_boards_creator_idx on public.pinboard_boards (created_by);

alter table public.pinboard_boards enable row level security;
alter table public.pinboard_board_access enable row level security;
revoke all on public.pinboard_boards, public.pinboard_board_access from public, anon, authenticated;
grant select on public.pinboard_boards, public.pinboard_board_access to authenticated;

create policy pinboard_read_own_access on public.pinboard_board_access
  for select to authenticated using (user_id = (select auth.uid()));
create policy pinboard_read_joined_boards on public.pinboard_boards
  for select to authenticated using (exists (
    select 1 from public.pinboard_board_access access
    where access.board_id = pinboard_boards.id and access.user_id = (select auth.uid())
  ));

create or replace function private.pinboard_board_json(p_board public.pinboard_boards)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select to_jsonb(p_board) - array['created_by', 'deleted_card_ids', 'deleted_column_ids'];
$$;

create or replace function private.pinboard_create_board(p_id uuid, p_title text, p_description text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  invite text;
  board_row public.pinboard_boards%rowtype;
begin
  if caller is null then raise exception 'PINBOARD_AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_id is null or not coalesce(private.pinboard_valid_text(to_jsonb(p_title), 160), false)
    or not coalesce(private.pinboard_valid_text(to_jsonb(p_description), 10000, false), false)
  then raise exception 'PINBOARD_INVALID_BOARD' using errcode = '22023'; end if;
  -- Serialize a session's create/join limits, including concurrent requests.
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9184));
  select * into board_row from public.pinboard_boards where id = p_id;
  if found then
    if board_row.created_by = caller and exists (
      select 1 from public.pinboard_board_access where board_id = board_row.id and user_id = caller
    ) then return private.pinboard_board_json(board_row); end if;
    raise exception 'PINBOARD_INVALID_BOARD' using errcode = '22023';
  end if;
  if (select count(*) from public.pinboard_boards where created_by = caller) >= 100
    or (select count(*) from public.pinboard_board_access where user_id = caller) >= 1000
  then raise exception 'PINBOARD_BOARD_LIMIT' using errcode = 'P0001'; end if;
  loop
    invite := replace(gen_random_uuid()::text, '-', '');
    begin
      insert into public.pinboard_boards (id, invite_code, title, description, columns, created_by)
      values (p_id, invite, p_title, p_description,
        '[{"id":"todo","title":"To do","color":"slate"},{"id":"doing","title":"In progress","color":"amber"},{"id":"done","title":"Done","color":"emerald"}]'::jsonb,
        caller) returning * into board_row;
      exit;
    exception when unique_violation then
      -- Retry a code collision; another creator's existing ID must remain inaccessible.
      if exists (select 1 from public.pinboard_boards where id = p_id) then
        raise exception 'PINBOARD_INVALID_BOARD' using errcode = '22023';
      end if;
    end;
  end loop;
  insert into public.pinboard_board_access (board_id, user_id) values (board_row.id, caller);
  return private.pinboard_board_json(board_row);
end;
$$;

create or replace function private.pinboard_join_board(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  normalized text := lower(regexp_replace(p_code, '\s+', '', 'g'));
  board_row public.pinboard_boards%rowtype;
begin
  if caller is null then raise exception 'PINBOARD_AUTH_REQUIRED' using errcode = '42501'; end if;
  if normalized is null or normalized !~ '^[a-f0-9]{32}$' then
    raise exception 'PINBOARD_INVALID_INVITE' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9184));
  select * into board_row from public.pinboard_boards where invite_code = normalized;
  if not found then raise exception 'PINBOARD_INVALID_INVITE' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.pinboard_board_access where board_id = board_row.id and user_id = caller)
    and (select count(*) from public.pinboard_board_access where user_id = caller) >= 1000
  then raise exception 'PINBOARD_BOARD_LIMIT' using errcode = 'P0001'; end if;
  insert into public.pinboard_board_access (board_id, user_id) values (board_row.id, caller) on conflict do nothing;
  return private.pinboard_board_json(board_row);
end;
$$;

create or replace function private.pinboard_mutate_board(p_board_id uuid, p_operation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  board_row public.pinboard_boards%rowtype;
  new_columns jsonb;
  new_cards jsonb;
  new_deleted_card_ids text[];
  new_deleted_column_ids text[];
  new_title text;
  new_description text;
  operation_type text;
  target_index integer;
  patch jsonb;
  entity_id text;
  order_id jsonb;
  ordered_ids text[] := '{}'::text[];
begin
  if caller is null then raise exception 'PINBOARD_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.pinboard_board_access where board_id = p_board_id and user_id = caller)
    then raise exception 'PINBOARD_ACCESS_DENIED' using errcode = '42501'; end if;
  -- Apply each operation to the CURRENT row after locking it. A later accepted
  -- patch wins only for its fields; independent changes and deletions survive.
  select * into board_row from public.pinboard_boards where id = p_board_id for update;
  if not found then raise exception 'PINBOARD_ACCESS_DENIED' using errcode = '42501'; end if;
  if jsonb_typeof(p_operation) is distinct from 'object'
    or jsonb_typeof(p_operation->'type') is distinct from 'string'
  then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
  operation_type := p_operation->>'type';
  new_columns := board_row.columns;
  new_cards := board_row.cards;
  new_deleted_card_ids := board_row.deleted_card_ids;
  new_deleted_column_ids := board_row.deleted_column_ids;
  new_title := board_row.title;
  new_description := board_row.description;
  patch := p_operation->'patch';
  entity_id := p_operation->>'id';

  if operation_type = 'update_board' then
    if not private.pinboard_has_keys(p_operation, array['type','patch'])
      or not private.pinboard_allowed_keys(patch, array['title','description'])
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    if patch ? 'title' then
      if not private.pinboard_valid_text(patch->'title', 160) then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
      new_title := patch->>'title';
    end if;
    if patch ? 'description' then
      if not private.pinboard_valid_text(patch->'description', 10000, false) then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
      new_description := patch->>'description';
    end if;
  elsif operation_type = 'add_column' then
    if not private.pinboard_has_keys(p_operation, array['type','column'])
      or not private.pinboard_valid_state(jsonb_build_array(p_operation->'column'), '[]'::jsonb)
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    -- Stable create IDs stay consumed after deletion, preserving later edits.
    if (p_operation->'column'->>'id') = any(new_deleted_column_ids)
      or exists (select 1 from jsonb_array_elements(new_columns) where value->>'id' = p_operation->'column'->>'id')
      then return private.pinboard_board_json(board_row); end if;
    new_columns := new_columns || jsonb_build_array(p_operation->'column');
  elsif operation_type = 'reorder_columns' then
    if not private.pinboard_has_keys(p_operation, array['type','columnIds'])
      or jsonb_typeof(p_operation->'columnIds') is distinct from 'array'
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    if jsonb_array_length(p_operation->'columnIds') not between 1 and 20
      then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    for order_id in select value from jsonb_array_elements(p_operation->'columnIds') loop
      if not coalesce(private.pinboard_valid_column_id(order_id), false)
        or (order_id #>> '{}') = any(ordered_ids)
      then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
      ordered_ids := array_append(ordered_ids, order_id #>> '{}');
    end loop;
    -- Order CURRENT objects by stable IDs, retaining their latest metadata.
    -- Deleted IDs are harmless; columns added since the editor's snapshot
    -- stay present at the end in their current relative order.
    select jsonb_agg(value order by coalesce(array_position(ordered_ids, value->>'id'), 21), ordinality)
      into new_columns from jsonb_array_elements(new_columns) with ordinality;
  elsif operation_type = 'update_column' then
    if not private.pinboard_has_keys(p_operation, array['type','id','patch'])
      or not coalesce(private.pinboard_valid_column_id(p_operation->'id'), false)
      or not private.pinboard_allowed_keys(patch, array['title','color'])
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    select ordinality::integer - 1 into target_index
      from jsonb_array_elements(new_columns) with ordinality where value->>'id' = entity_id;
    if not found then raise exception 'PINBOARD_COLUMN_NOT_FOUND' using errcode = 'P0001'; end if;
    new_columns := jsonb_set(new_columns, array[target_index::text], (new_columns->target_index) || patch);
  elsif operation_type = 'delete_column' then
    if not private.pinboard_has_keys(p_operation, array['type','id','targetColumnId'])
      or not coalesce(private.pinboard_valid_column_id(p_operation->'id'), false)
      or not coalesce(private.pinboard_valid_column_id(p_operation->'targetColumnId'), false)
      or entity_id = p_operation->>'targetColumnId' or jsonb_array_length(new_columns) <= 1
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    if not exists (select 1 from jsonb_array_elements(new_columns) where value->>'id' = entity_id)
      or not exists (select 1 from jsonb_array_elements(new_columns) where value->>'id' = p_operation->>'targetColumnId')
    then raise exception 'PINBOARD_COLUMN_NOT_FOUND' using errcode = 'P0001'; end if;
    new_deleted_column_ids := array_append(new_deleted_column_ids, entity_id);
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb) into new_columns
      from jsonb_array_elements(new_columns) with ordinality where value->>'id' <> entity_id;
    select coalesce(jsonb_agg(case when value->>'columnId' = entity_id
      then jsonb_set(value, '{columnId}', p_operation->'targetColumnId') else value end order by ordinality), '[]'::jsonb)
      into new_cards from jsonb_array_elements(new_cards) with ordinality;
  elsif operation_type = 'create_card' then
    if not private.pinboard_has_keys(p_operation, array['type','card'])
      or not coalesce(private.pinboard_valid_uuid(p_operation->'card'->'id'), false)
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    -- A retry remains a no-op after another member deletes the created card.
    if (p_operation->'card'->>'id') = any(new_deleted_card_ids)
      or exists (select 1 from jsonb_array_elements(new_cards) where value->>'id' = p_operation->'card'->>'id')
      then return private.pinboard_board_json(board_row); end if;
    new_cards := new_cards || jsonb_build_array(p_operation->'card');
  elsif operation_type in ('update_card','move_card') then
    if operation_type = 'update_card' then
      if not private.pinboard_has_keys(p_operation, array['type','id','patch'])
        or not private.pinboard_allowed_keys(patch, array['title','description','columnId','position','priority','assignee','dueDate','labels'])
      then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    else
      if not private.pinboard_has_keys(p_operation, array['type','id','columnId','position'])
        then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
      patch := jsonb_build_object('columnId', p_operation->'columnId', 'position', p_operation->'position');
    end if;
    if not coalesce(private.pinboard_valid_uuid(p_operation->'id'), false)
      then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    select ordinality::integer - 1 into target_index
      from jsonb_array_elements(new_cards) with ordinality where value->>'id' = entity_id;
    -- A stale editor must never recreate a card another person deleted.
    if not found then raise exception 'PINBOARD_CARD_NOT_FOUND' using errcode = 'P0001'; end if;
    new_cards := jsonb_set(new_cards, array[target_index::text], (new_cards->target_index) || patch);
  elsif operation_type = 'delete_card' then
    if not private.pinboard_has_keys(p_operation, array['type','id'])
      or not coalesce(private.pinboard_valid_uuid(p_operation->'id'), false)
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(new_cards) where value->>'id' = entity_id) then
      new_deleted_card_ids := array_append(new_deleted_card_ids, entity_id);
    end if;
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb) into new_cards
      from jsonb_array_elements(new_cards) with ordinality where value->>'id' <> entity_id;
  else
    raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023';
  end if;

  if not private.pinboard_valid_state(new_columns, new_cards)
    then raise exception 'PINBOARD_INVALID_OPERATION' using errcode = '22023'; end if;
  if new_columns is distinct from board_row.columns or new_cards is distinct from board_row.cards
    or new_title is distinct from board_row.title or new_description is distinct from board_row.description
  then
    if board_row.revision = 9007199254740991 then raise exception 'PINBOARD_BOARD_LIMIT' using errcode = 'P0001'; end if;
    update public.pinboard_boards set columns = new_columns, cards = new_cards,
      deleted_card_ids = new_deleted_card_ids, deleted_column_ids = new_deleted_column_ids,
      title = new_title, description = new_description, revision = revision + 1, updated_at = clock_timestamp()
      where id = board_row.id returning * into board_row;
  end if;
  return private.pinboard_board_json(board_row);
end;
$$;

-- Only invoker entry points are exposed through the Data API. Privileged work
-- stays in private functions that verify the caller and their board membership.
create or replace function public.pinboard_create_board(p_id uuid, p_title text, p_description text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.pinboard_create_board(p_id, p_title, p_description);
$$;
create or replace function public.pinboard_join_board(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.pinboard_join_board(p_code);
$$;
create or replace function public.pinboard_mutate_board(p_board_id uuid, p_operation jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.pinboard_mutate_board(p_board_id, p_operation);
$$;

revoke all on function private.pinboard_has_keys(jsonb,text[]), private.pinboard_allowed_keys(jsonb,text[]),
  private.pinboard_valid_text(jsonb,integer,boolean), private.pinboard_valid_uuid(jsonb),
  private.pinboard_valid_column_id(jsonb), private.pinboard_valid_date(jsonb),
  private.pinboard_valid_position(jsonb), private.pinboard_valid_state(jsonb,jsonb),
  private.pinboard_board_json(public.pinboard_boards), private.pinboard_create_board(uuid,text,text),
  private.pinboard_join_board(text), private.pinboard_mutate_board(uuid,jsonb)
  from public, anon, authenticated;
revoke all on function public.pinboard_create_board(uuid,text,text), public.pinboard_join_board(text),
  public.pinboard_mutate_board(uuid,jsonb) from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.pinboard_create_board(uuid,text,text), private.pinboard_join_board(text),
  private.pinboard_mutate_board(uuid,jsonb) to authenticated;
grant execute on function public.pinboard_create_board(uuid,text,text), public.pinboard_join_board(text),
  public.pinboard_mutate_board(uuid,jsonb) to authenticated;

commit;
