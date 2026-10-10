-- iou: run once in the Supabase SQL editor, as the project administrator.
-- Keep the private schema OUT of the Data API's exposed schemas.
begin;

create schema if not exists private;

create or replace function private.iou_has_keys(p_value jsonb, p_keys text[])
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  return p_value ?& p_keys and not exists (
    select 1 from jsonb_object_keys(p_value) as keys(key) where not (key = any(p_keys))
  );
end;
$$;

create or replace function private.iou_valid_text(p_value jsonb, p_max integer, p_required boolean default true)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  value := p_value #>> '{}';
  -- Match JavaScript's UTF-16 length and trim semantics, including emoji and BOM.
  return char_length(value) + char_length(regexp_replace(value, E'[^\U00010000-\U0010ffff]', '', 'g')) <= p_max
    and (not p_required or value !~ E'^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$')
    and translate(value, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]';
end;
$$;

create or replace function private.iou_valid_id(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
begin
  return jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'
    and (p_value #>> '{}') not in ('__proto__', 'constructor', 'prototype');
end;
$$;

create or replace function private.iou_valid_date(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  value := p_value #>> '{}';
  if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  return to_char(value::date, 'YYYY-MM-DD') = value;
exception when others then return false;
end;
$$;

create or replace function private.iou_valid_timestamp(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  value := p_value #>> '{}';
  if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?Z$'
    or not private.iou_valid_date(to_jsonb(left(value, 10))) then return false; end if;
  return value::timestamptz is not null;
exception when others then return false;
end;
$$;

create or replace function private.iou_valid_money(p_value jsonb, p_allow_zero boolean default false)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare value numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
  value := (p_value #>> '{}')::numeric;
  return value = trunc(value) and value <= 1000000000000 and value >= case when p_allow_zero then 0 else 1 end;
end;
$$;

create or replace function private.iou_valid_group(p_payload jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare
  member jsonb;
  transaction jsonb;
  participant record;
  member_ids text[] := '{}'::text[];
  transaction_ids text[] := '{}'::text[];
  shares_total numeric;
  shares_count integer;
begin
  if p_payload is null or octet_length(p_payload::text) > 8000000 then return false; end if;
  if not private.iou_has_keys(p_payload, array['id','name','description','currency','icon','color','inviteCode','createdAt','updatedAt','members','transactions'])
    or not private.iou_valid_id(p_payload->'id')
    or not private.iou_valid_text(p_payload->'name', 80)
    or not private.iou_valid_text(p_payload->'description', 500, false)
    or not private.iou_valid_text(p_payload->'icon', 32)
    or jsonb_typeof(p_payload->'currency') is distinct from 'string'
    or (p_payload->>'currency') !~ '^[A-Z]{3}$'
    or jsonb_typeof(p_payload->'color') is distinct from 'string'
    or (p_payload->>'color') !~* '^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$'
    or jsonb_typeof(p_payload->'inviteCode') is distinct from 'string'
    or (p_payload->>'inviteCode') !~ '^[a-f0-9]{32}$'
    or not private.iou_valid_timestamp(p_payload->'createdAt')
    or not private.iou_valid_timestamp(p_payload->'updatedAt')
    or jsonb_typeof(p_payload->'members') is distinct from 'array'
    or jsonb_typeof(p_payload->'transactions') is distinct from 'array'
  then return false; end if;

  if (p_payload->>'updatedAt')::timestamptz < (p_payload->>'createdAt')::timestamptz
    or jsonb_array_length(p_payload->'members') not between 1 and 100
    or jsonb_array_length(p_payload->'transactions') > 5000
  then return false; end if;

  for member in select value from jsonb_array_elements(p_payload->'members') loop
    if not private.iou_has_keys(member, array['id','name'])
      or not private.iou_valid_id(member->'id')
      or not private.iou_valid_text(member->'name', 80)
      or (member->>'id') = any(member_ids)
    then return false; end if;
    member_ids := array_append(member_ids, member->>'id');
  end loop;

  for transaction in select value from jsonb_array_elements(p_payload->'transactions') loop
    if jsonb_typeof(transaction) is distinct from 'object'
      or not private.iou_valid_id(transaction->'id')
      or (transaction->>'id') = any(transaction_ids)
      or not private.iou_valid_money(transaction->'amount')
      or not private.iou_valid_date(transaction->'date')
      or not private.iou_valid_timestamp(transaction->'createdAt')
    then return false; end if;
    transaction_ids := array_append(transaction_ids, transaction->>'id');

    if transaction->>'type' = 'expense' then
      if not private.iou_has_keys(transaction, array['id','type','description','amount','paidBy','shares','category','date','createdAt'])
        or not private.iou_valid_text(transaction->'description', 160)
        or not private.iou_valid_text(transaction->'category', 40)
        or jsonb_typeof(transaction->'paidBy') is distinct from 'string'
        or not ((transaction->>'paidBy') = any(member_ids))
        or jsonb_typeof(transaction->'shares') is distinct from 'object'
      then return false; end if;
      shares_total := 0;
      shares_count := 0;
      for participant in select key, value from jsonb_each(transaction->'shares') loop
        if not (participant.key = any(member_ids)) or not private.iou_valid_money(participant.value, true) then return false; end if;
        shares_count := shares_count + 1;
        shares_total := shares_total + (participant.value #>> '{}')::numeric;
      end loop;
      if shares_count not between 1 and 100 or shares_total <> (transaction->>'amount')::numeric then return false; end if;
    elsif transaction->>'type' = 'payment' then
      if not private.iou_has_keys(transaction, array['id','type','fromId','toId','amount','note','date','createdAt'])
        or not private.iou_valid_text(transaction->'note', 500, false)
        or jsonb_typeof(transaction->'fromId') is distinct from 'string'
        or jsonb_typeof(transaction->'toId') is distinct from 'string'
        or not ((transaction->>'fromId') = any(member_ids))
        or not ((transaction->>'toId') = any(member_ids))
        or transaction->>'fromId' = transaction->>'toId'
      then return false; end if;
    else
      return false;
    end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create table public.iou_groups (
  id text primary key,
  invite_code text not null unique check (invite_code ~ '^[a-f0-9]{32}$'),
  payload jsonb not null check (private.iou_valid_group(payload)),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (payload->>'id' = id),
  check (payload->>'inviteCode' = invite_code)
);

create table public.iou_group_access (
  group_id text not null references public.iou_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index iou_group_access_user_idx on public.iou_group_access (user_id, group_id);
create index iou_groups_creator_idx on public.iou_groups (created_by);

alter table public.iou_groups enable row level security;
alter table public.iou_group_access enable row level security;

-- All writes go through the checked RPCs. There are no public or direct write grants.
revoke all on public.iou_groups, public.iou_group_access from public, anon, authenticated;
grant select on public.iou_groups, public.iou_group_access to authenticated;

create policy iou_read_own_access on public.iou_group_access
  for select to authenticated using (user_id = (select auth.uid()));

create policy iou_read_joined_groups on public.iou_groups
  for select to authenticated using (exists (
    select 1 from public.iou_group_access access
    where access.group_id = iou_groups.id and access.user_id = (select auth.uid())
  ));

create or replace function private.iou_create_group(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  invite text;
  prepared jsonb;
  new_row public.iou_groups%rowtype;
begin
  if caller is null then raise exception 'IOU_AUTH_REQUIRED' using errcode = '42501'; end if;
  -- Bound one anonymous session's storage usage, including concurrent creates.
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9183));
  if jsonb_typeof(p_payload) is distinct from 'object'
    or not coalesce(private.iou_valid_id(p_payload->'id'), false)
  then raise exception 'IOU_INVALID_GROUP' using errcode = '22023'; end if;
  -- A response can be lost after commit. Retrying the same ID returns the
  -- creator's existing group, without overwriting it or generating another code.
  select * into new_row from public.iou_groups where id = p_payload->>'id';
  if found then
    if new_row.created_by = caller and exists (
      select 1 from public.iou_group_access where group_id = new_row.id and user_id = caller
    ) then
      return jsonb_build_object('payload', new_row.payload, 'version', new_row.version);
    end if;
    raise exception 'IOU_INVALID_GROUP' using errcode = '22023';
  end if;
  if (select count(*) from public.iou_groups where created_by = caller) >= 100 then
    raise exception 'IOU_GROUP_LIMIT' using errcode = 'P0001';
  end if;
  loop
    invite := replace(gen_random_uuid()::text, '-', '');
    prepared := jsonb_set(p_payload, '{inviteCode}', to_jsonb(invite));
    if not private.iou_valid_group(prepared) then raise exception 'IOU_INVALID_GROUP' using errcode = '22023'; end if;
    begin
      insert into public.iou_groups (id, invite_code, payload, created_by)
        values (prepared->>'id', invite, prepared, caller) returning * into new_row;
      exit;
    exception when unique_violation then
      -- Retry the exceedingly unlikely code collision, never an existing group ID.
      if exists (select 1 from public.iou_groups where id = prepared->>'id') then
        raise exception 'IOU_INVALID_GROUP' using errcode = '22023';
      end if;
    end;
  end loop;
  insert into public.iou_group_access (group_id, user_id) values (new_row.id, caller);
  return jsonb_build_object('payload', new_row.payload, 'version', new_row.version);
end;
$$;

create or replace function private.iou_join_group(p_invite_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  normalized text := lower(regexp_replace(p_invite_code, '\s+', '', 'g'));
  group_row public.iou_groups%rowtype;
begin
  if caller is null then raise exception 'IOU_AUTH_REQUIRED' using errcode = '42501'; end if;
  if normalized is null or normalized !~ '^[a-f0-9]{32}$' then
    raise exception 'IOU_INVALID_INVITE' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9183));
  select * into group_row from public.iou_groups where invite_code = normalized;
  if not found then raise exception 'IOU_INVALID_INVITE' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.iou_group_access where group_id = group_row.id and user_id = caller)
    and (select count(*) from public.iou_group_access where user_id = caller) >= 1000
  then raise exception 'IOU_GROUP_LIMIT' using errcode = 'P0001'; end if;
  insert into public.iou_group_access (group_id, user_id) values (group_row.id, caller) on conflict do nothing;
  return jsonb_build_object('payload', group_row.payload, 'version', group_row.version);
end;
$$;

create or replace function private.iou_save_group(p_payload jsonb, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  group_row public.iou_groups%rowtype;
begin
  if caller is null then raise exception 'IOU_AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_expected_version is null or p_expected_version not between 1 and 9007199254740990
    or not private.iou_valid_group(p_payload)
  then raise exception 'IOU_INVALID_GROUP' using errcode = '22023'; end if;
  if not exists (select 1 from public.iou_group_access where group_id = p_payload->>'id' and user_id = caller) then
    raise exception 'IOU_ACCESS_DENIED' using errcode = '42501';
  end if;
  -- The lock serializes writes. Compare the revision after obtaining the lock.
  select * into group_row from public.iou_groups where id = p_payload->>'id' for update;
  if not found then raise exception 'IOU_ACCESS_DENIED' using errcode = '42501'; end if;
  if group_row.version <> p_expected_version then raise exception 'IOU_CONFLICT' using errcode = 'PT409'; end if;
  if p_payload->>'id' is distinct from group_row.payload->>'id'
    or p_payload->>'inviteCode' is distinct from group_row.invite_code
    or p_payload->>'currency' is distinct from group_row.payload->>'currency'
    or p_payload->>'createdAt' is distinct from group_row.payload->>'createdAt'
  then raise exception 'IOU_IMMUTABLE_SETTINGS' using errcode = '22023'; end if;
  update public.iou_groups set payload = p_payload, version = version + 1, updated_at = now()
    where id = group_row.id and version = p_expected_version returning * into group_row;
  if not found then raise exception 'IOU_CONFLICT' using errcode = 'PT409'; end if;
  return jsonb_build_object('payload', group_row.payload, 'version', group_row.version);
end;
$$;

-- Exposed RPC entry points have invoker privileges. Privileged code stays private.
create or replace function public.iou_create_group(p_payload jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.iou_create_group(p_payload);
$$;
create or replace function public.iou_join_group(p_invite_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.iou_join_group(p_invite_code);
$$;
create or replace function public.iou_save_group(p_payload jsonb, p_expected_version bigint)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.iou_save_group(p_payload, p_expected_version);
$$;

-- Revoke PostgreSQL's default PUBLIC execution grants and Supabase role defaults.
revoke all on function private.iou_has_keys(jsonb,text[]), private.iou_valid_text(jsonb,integer,boolean),
  private.iou_valid_id(jsonb), private.iou_valid_date(jsonb), private.iou_valid_timestamp(jsonb),
  private.iou_valid_money(jsonb,boolean), private.iou_valid_group(jsonb),
  private.iou_create_group(jsonb), private.iou_join_group(text), private.iou_save_group(jsonb,bigint)
  from public, anon, authenticated;
revoke all on function public.iou_create_group(jsonb), public.iou_join_group(text), public.iou_save_group(jsonb,bigint)
  from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.iou_create_group(jsonb), private.iou_join_group(text), private.iou_save_group(jsonb,bigint)
  to authenticated;
grant execute on function public.iou_create_group(jsonb), public.iou_join_group(text), public.iou_save_group(jsonb,bigint)
  to authenticated;

commit;
