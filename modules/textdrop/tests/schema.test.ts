import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES, readPage, type TextDropPage } from '../src/lib/model';

const creator = randomUUID();
const collaborator = randomUUID();
const stranger = randomUUID();
const schema = new URL('../supabase/schema.sql', import.meta.url);
let database: PGlite;
let siblingState: Record<string, unknown>[];

async function identity(user: string | null, role = 'authenticated'): Promise<void> {
  await database.exec('reset role');
  await database.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
  await database.exec(`set role ${role}`);
}

async function create(id: string = randomUUID()): Promise<TextDropPage> {
  const result = await database.query<{ page: TextDropPage }>('select public.textdrop_create_page($1::uuid) as page', [id]);
  return result.rows[0]!.page;
}

async function join(code: string | null): Promise<TextDropPage> {
  const result = await database.query<{ page: TextDropPage }>('select public.textdrop_join_page($1) as page', [code]);
  return result.rows[0]!.page;
}

async function load(id: string): Promise<TextDropPage> {
  const result = await database.query<{ page: TextDropPage }>('select public.textdrop_load_page($1::uuid) as page', [id]);
  return result.rows[0]!.page;
}

async function save(id: string, text: string | null): Promise<TextDropPage> {
  const result = await database.query<{ page: TextDropPage }>('select public.textdrop_save_page($1::uuid, $2) as page', [id, text]);
  return result.rows[0]!.page;
}

async function siblings(): Promise<Record<string, unknown>[]> {
  return (await database.query<Record<string, unknown>>(`
    select c.relname, c.relacl::text, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('iou_groups','iou_group_access','kanban_boards','kanban_board_access')
    order by c.relname
  `)).rows;
}

describe('TextDrop schema in embedded PostgreSQL', () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      create schema private;
      create table public.iou_groups (id text primary key, payload jsonb not null);
      create table public.iou_group_access (group_id text, user_id uuid);
      create table public.kanban_boards (id text primary key, payload jsonb not null);
      create table public.kanban_board_access (board_id text, user_id uuid);
      alter table public.iou_groups enable row level security;
      alter table public.iou_group_access enable row level security;
      alter table public.kanban_boards enable row level security;
      alter table public.kanban_board_access enable row level security;
      revoke all on public.iou_groups, public.iou_group_access, public.kanban_boards, public.kanban_board_access from public, anon, authenticated;
      grant select on public.iou_groups, public.iou_group_access, public.kanban_boards, public.kanban_board_access to authenticated;
      create function public.iou_create_group(jsonb) returns jsonb language sql as $$ select $1; $$;
      revoke all on function public.iou_create_group(jsonb) from public, anon;
      grant execute on function public.iou_create_group(jsonb) to authenticated;
      insert into public.iou_groups values ('existing-iou', '{"name":"Untouched"}');
      insert into public.kanban_boards values ('existing-kanban', '{"title":"Untouched"}');
    `);
    await database.query('insert into auth.users (id) values ($1), ($2), ($3)', [creator, collaborator, stranger]);
    siblingState = await siblings();
    await database.exec(await readFile(schema, 'utf8'));
  }, 30_000);

  afterAll(async () => { await database?.close(); });

  it('installs additively without changing sibling data, permissions, or RLS', async () => {
    await database.exec('reset role');
    expect(await siblings()).toEqual(siblingState);
    expect((await database.query("select payload from public.iou_groups where id = 'existing-iou'")).rows).toEqual([{ payload: { name: 'Untouched' } }]);
    expect((await database.query("select payload from public.kanban_boards where id = 'existing-kanban'")).rows).toEqual([{ payload: { title: 'Untouched' } }]);
    const functions = await database.query<{ nspname: string; proname: string; prosecdef: boolean; proconfig: string[] }>(`
      select n.nspname, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('textdrop_create_page','textdrop_join_page','textdrop_load_page','textdrop_save_page')
      order by n.nspname, p.proname
    `);
    expect(functions.rows).toHaveLength(8);
    for (const row of functions.rows) {
      expect(row.prosecdef).toBe(row.nspname === 'private');
      expect(row.proconfig).toEqual(['search_path=""']);
    }
    const grants = await database.query(`
      select
        has_function_privilege('anon', 'public.textdrop_create_page(uuid)', 'execute') as anonymous,
        has_function_privilege('authenticated', 'public.textdrop_create_page(uuid)', 'execute') as signed_in,
        has_function_privilege('authenticated', 'private.textdrop_page_json(public.textdrop_pages)', 'execute') as serializer,
        has_table_privilege('authenticated', 'public.textdrop_pages', 'insert,update,delete') as direct_write,
        has_function_privilege('authenticated', 'public.iou_create_group(jsonb)', 'execute') as iou_unchanged
    `);
    expect(grants.rows[0]).toEqual({ anonymous: false, signed_in: true, serializer: false, direct_write: false, iou_unchanged: true });
  });

  it('denies anonymous visitors and signed-in strangers access to page contents and codes', async () => {
    await identity(creator);
    const page = await create();
    await identity(null, 'anon');
    await expect(database.query('select * from public.textdrop_pages')).rejects.toThrow('permission denied');
    await expect(join(page.code)).rejects.toThrow('permission denied');
    await expect(save(page.id, 'Stolen')).rejects.toThrow('permission denied');
    await identity(null);
    await expect(create()).rejects.toThrow('TEXTDROP_AUTH_REQUIRED');
    await expect(join(page.code)).rejects.toThrow('TEXTDROP_AUTH_REQUIRED');
    await expect(load(page.id)).rejects.toThrow('TEXTDROP_AUTH_REQUIRED');
    await expect(save(page.id, 'Stolen')).rejects.toThrow('TEXTDROP_AUTH_REQUIRED');
    await identity(stranger);
    expect((await database.query('select * from public.textdrop_pages where id = $1', [page.id])).rows).toEqual([]);
    expect((await database.query('select * from public.textdrop_page_access where page_id = $1', [page.id])).rows).toEqual([]);
    await expect(load(page.id)).rejects.toThrow('TEXTDROP_ACCESS_DENIED');
    await expect(save(page.id, 'Stolen')).rejects.toThrow('TEXTDROP_ACCESS_DENIED');
    await expect(database.query('update public.textdrop_pages set content = $1 where id = $2', ['Stolen', page.id])).rejects.toThrow('permission denied');
    await expect(database.query('delete from public.textdrop_pages where id = $1', [page.id])).rejects.toThrow('permission denied');
    await expect(database.query('insert into public.textdrop_page_access (page_id,user_id) values ($1,$2)', [page.id, stranger])).rejects.toThrow('permission denied');
    await expect(database.query('insert into public.textdrop_pages (id,code) values ($1,$2)', [randomUUID(), 'f'.repeat(32)])).rejects.toThrow('permission denied');
  });

  it('creates unique server codes and retries a stable ID without resetting later edits', async () => {
    await identity(creator);
    const page = await create();
    const other = await create();
    expect(page.code).toMatch(/^[a-f0-9]{32}$/);
    expect(other.code).not.toBe(page.code);
    expect(page.text).toBe('');
    expect(page.version).toBe(1);
    expect(readPage(page)).toEqual(page);
    const edited = await save(page.id, 'Edited after creation');
    expect(await create(page.id)).toEqual(edited);
    await identity(collaborator);
    await expect(create(page.id)).rejects.toThrow('TEXTDROP_INVALID_PAGE');
    await join(page.code);
    await expect(create(page.id)).rejects.toThrow('TEXTDROP_INVALID_PAGE');
    expect(await load(page.id)).toEqual(edited);
  });

  it('joins by a complete code with matching formatting rules and records membership once', async () => {
    await identity(creator);
    const page = await create();
    await identity(collaborator);
    await expect(join(page.code.slice(0, 8))).rejects.toThrow('TEXTDROP_INVALID_CODE');
    await expect(join('0'.repeat(32))).rejects.toThrow('TEXTDROP_INVALID_CODE');
    await expect(join(null)).rejects.toThrow('TEXTDROP_INVALID_CODE');
    await expect(join(`${page.code}\u00a0`)).rejects.toThrow('TEXTDROP_INVALID_CODE');
    const formatted = ` \t${page.code.slice(0, 16).toUpperCase()}-\n${page.code.slice(16).toUpperCase()}\r\f\v`;
    expect(await join(formatted)).toEqual(page);
    expect(await join(page.code)).toEqual(page);
    const access = await database.query<{ user_id: string }>('select user_id from public.textdrop_page_access where page_id = $1', [page.id]);
    expect(access.rows).toEqual([{ user_id: collaborator }]);
  });

  it('replaces the whole text in server acceptance order, including a stale client save', async () => {
    await identity(creator);
    const original = await create();
    await identity(collaborator);
    await join(original.code);
    const first = await save(original.id, 'The collaborator saves first');
    await identity(creator);
    // This caller still holds original version 1. There is deliberately no
    // expected-version argument: its later accepted save wins the entire text.
    const latest = await save(original.id, 'The creator saves later');
    expect(first.version).toBe(2);
    expect(latest.version).toBe(3);
    expect(latest.text).toBe('The creator saves later');
    expect(await load(original.id)).toEqual(latest);
    expect(Date.parse(latest.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
    const repeated = await save(original.id, latest.text);
    expect(repeated.version).toBe(4);
    await identity(collaborator);
    expect(await load(original.id)).toEqual(repeated);
  });

  it('preserves exact literal text and allows clearing a page', async () => {
    await identity(creator);
    const page = await create();
    const text = '\t<script>alert(1)</script>\r\nবাংলা 😀\u0001  \n';
    expect((await save(page.id, text)).text).toBe(text);
    expect((await load(page.id)).text).toBe(text);
    expect((await save(page.id, '')).text).toBe('');
  });

  it('enforces the UTF-8 byte limit at the database and leaves content intact after invalid saves', async () => {
    await identity(creator);
    const page = await create();
    const maximum = '😀'.repeat(MAX_TEXT_BYTES / 4);
    const saved = await save(page.id, maximum);
    expect(saved.text).toBe(maximum);
    await expect(save(page.id, `${maximum}x`)).rejects.toThrow('TEXTDROP_INVALID_TEXT');
    await expect(save(page.id, 'é'.repeat(MAX_TEXT_BYTES / 2 + 1))).rejects.toThrow('TEXTDROP_INVALID_TEXT');
    await expect(save(page.id, null)).rejects.toThrow('TEXTDROP_INVALID_TEXT');
    expect(await load(page.id)).toEqual(saved);
    await expect(database.query('select public.textdrop_create_page(null::uuid)')).rejects.toThrow('TEXTDROP_INVALID_PAGE');
    await expect(save(randomUUID(), 'Missing')).rejects.toThrow('TEXTDROP_ACCESS_DENIED');
  });

  it('rejects version overflow without losing the final safe version', async () => {
    await identity(creator);
    const page = await create();
    await database.exec('reset role');
    await database.query('update public.textdrop_pages set version = 9007199254740991 where id = $1', [page.id]);
    await identity(creator);
    await expect(save(page.id, 'Overflow')).rejects.toThrow('TEXTDROP_VERSION_LIMIT');
    const final = await load(page.id);
    expect(final.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(final.text).toBe('');
  });

  it('enforces create and join limits while allowing existing create and join retries', async () => {
    await database.exec('reset role');
    const limitedCreator = randomUUID();
    const limitedJoiner = randomUUID();
    await database.query('insert into auth.users (id) values ($1), ($2)', [limitedCreator, limitedJoiner]);
    await database.query(`
      insert into public.textdrop_pages (id,code,created_by)
      select gen_random_uuid(), lpad(to_hex(series), 32, '0'), $1::uuid
      from generate_series(1,100) as series
    `, [limitedCreator]);
    await database.query(`
      insert into public.textdrop_page_access (page_id,user_id)
      select id, $1::uuid from public.textdrop_pages where created_by = $1::uuid
    `, [limitedCreator]);
    const existing = (await database.query<{ id: string }>('select id from public.textdrop_pages where created_by = $1 limit 1', [limitedCreator])).rows[0]!;
    await identity(limitedCreator);
    await expect(create()).rejects.toThrow('TEXTDROP_PAGE_LIMIT');
    expect((await create(existing.id)).id).toBe(existing.id);
    await database.exec('reset role');
    await database.query(`
      insert into public.textdrop_pages (id,code)
      select gen_random_uuid(), lpad(to_hex(series), 32, '0')
      from generate_series(1001,2000) as series
    `);
    await database.query(`
      insert into public.textdrop_page_access (page_id,user_id)
      select id, $1::uuid from public.textdrop_pages where created_by is null
    `, [limitedJoiner]);
    const joined = (await database.query<{ code: string }>('select code from public.textdrop_pages where created_by is null limit 1')).rows[0]!;
    const unjoined = (await database.query<{ code: string }>('select code from public.textdrop_pages where created_by = $1 limit 1', [limitedCreator])).rows[0]!;
    await identity(limitedJoiner);
    await expect(join(unjoined.code)).rejects.toThrow('TEXTDROP_PAGE_LIMIT');
    await expect(create()).rejects.toThrow('TEXTDROP_PAGE_LIMIT');
    expect((await join(joined.code)).code).toBe(joined.code);
  });

  it('rolls back an attempted rerun without changing existing pages or sibling objects', async () => {
    await database.exec('reset role');
    const before = (await database.query('select count(*) as count from public.textdrop_pages')).rows;
    await expect(database.exec(await readFile(schema, 'utf8'))).rejects.toThrow('already exists');
    await database.exec('rollback');
    expect((await database.query('select count(*) as count from public.textdrop_pages')).rows).toEqual(before);
    expect(await siblings()).toEqual(siblingState);
  });
});

// Frozen legacy installation fixture: only upgrade tests retain these names.
const legacyInstallation = String.raw`
-- TextDrop: run once in the existing IOU project's Supabase SQL editor as administrator.
-- This additive transaction leaves IOU and Kanban objects unchanged.
-- Keep private OUT of the Data API's exposed schemas.
begin;

create schema if not exists private;

create table public.paste_pages (
  id uuid primary key,
  code text not null unique check (code ~ '^[a-f0-9]{32}$'),
  content text not null default '' check (octet_length(content) <= 1048576),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.paste_page_access (
  page_id uuid not null references public.paste_pages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (page_id, user_id)
);

create index paste_page_access_user_idx on public.paste_page_access (user_id, page_id);
create index paste_pages_creator_idx on public.paste_pages (created_by);

alter table public.paste_pages enable row level security;
alter table public.paste_page_access enable row level security;
revoke all on public.paste_pages, public.paste_page_access from public, anon, authenticated;
grant select on public.paste_pages, public.paste_page_access to authenticated;

create policy paste_read_own_access on public.paste_page_access
  for select to authenticated using (user_id = (select auth.uid()));
create policy paste_read_joined_pages on public.paste_pages
  for select to authenticated using (exists (
    select 1 from public.paste_page_access access
    where access.page_id = paste_pages.id and access.user_id = (select auth.uid())
  ));

create or replace function private.paste_page_json(p_page public.paste_pages)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_object('id', p_page.id, 'code', p_page.code, 'text', p_page.content,
    'version', p_page.version, 'updatedAt', p_page.updated_at);
$$;

create or replace function private.paste_create_page(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  invitation text;
  page_row public.paste_pages%rowtype;
begin
  if caller is null then raise exception 'PASTE_AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_id is null then raise exception 'PASTE_INVALID_PAGE' using errcode = '22023'; end if;
  -- Serialize this session's create/join limits, including concurrent requests.
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9185));
  select * into page_row from public.paste_pages where id = p_id;
  if found then
    if page_row.created_by = caller and exists (
      select 1 from public.paste_page_access where page_id = page_row.id and user_id = caller
    ) then return private.paste_page_json(page_row); end if;
    raise exception 'PASTE_INVALID_PAGE' using errcode = '22023';
  end if;
  if (select count(*) from public.paste_pages where created_by = caller) >= 100
    or (select count(*) from public.paste_page_access where user_id = caller) >= 1000
  then raise exception 'PASTE_PAGE_LIMIT' using errcode = 'P0001'; end if;
  loop
    invitation := replace(gen_random_uuid()::text, '-', '');
    begin
      insert into public.paste_pages (id, code, created_by)
      values (p_id, invitation, caller) returning * into page_row;
      exit;
    exception when unique_violation then
      -- Retry random invitation collisions without revealing an existing ID.
      if exists (select 1 from public.paste_pages where id = p_id) then
        raise exception 'PASTE_INVALID_PAGE' using errcode = '22023';
      end if;
    end;
  end loop;
  insert into public.paste_page_access (page_id, user_id) values (page_row.id, caller);
  return private.paste_page_json(page_row);
end;
$$;

create or replace function private.paste_join_page(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  normalized text := lower(regexp_replace(p_code, E'[\u0009-\u000d\u0020\u002d]+', '', 'g'));
  page_row public.paste_pages%rowtype;
begin
  if caller is null then raise exception 'PASTE_AUTH_REQUIRED' using errcode = '42501'; end if;
  if normalized is null or normalized !~ '^[a-f0-9]{32}$' then
    raise exception 'PASTE_INVALID_CODE' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 9185));
  select * into page_row from public.paste_pages where code = normalized;
  if not found then raise exception 'PASTE_INVALID_CODE' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.paste_page_access where page_id = page_row.id and user_id = caller)
    and (select count(*) from public.paste_page_access where user_id = caller) >= 1000
  then raise exception 'PASTE_PAGE_LIMIT' using errcode = 'P0001'; end if;
  insert into public.paste_page_access (page_id, user_id) values (page_row.id, caller) on conflict do nothing;
  return private.paste_page_json(page_row);
end;
$$;

create or replace function private.paste_load_page(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  page_row public.paste_pages%rowtype;
begin
  if caller is null then raise exception 'PASTE_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.paste_page_access where page_id = p_id and user_id = caller)
    then raise exception 'PASTE_ACCESS_DENIED' using errcode = '42501'; end if;
  select * into page_row from public.paste_pages where id = p_id;
  if not found then raise exception 'PASTE_ACCESS_DENIED' using errcode = '42501'; end if;
  return private.paste_page_json(page_row);
end;
$$;

create or replace function private.paste_save_page(p_id uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  page_row public.paste_pages%rowtype;
begin
  if caller is null then raise exception 'PASTE_AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from public.paste_page_access where page_id = p_id and user_id = caller)
    then raise exception 'PASTE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_text is null or octet_length(p_text) > 1048576
    then raise exception 'PASTE_INVALID_TEXT' using errcode = '22023'; end if;
  -- Every accepted save replaces the entire page after locking the current row.
  -- The server's acceptance order determines the winner, never a device clock.
  select * into page_row from public.paste_pages where id = p_id for update;
  if not found then raise exception 'PASTE_ACCESS_DENIED' using errcode = '42501'; end if;
  if page_row.version = 9007199254740991
    then raise exception 'PASTE_VERSION_LIMIT' using errcode = 'P0001'; end if;
  update public.paste_pages set content = p_text, version = version + 1, updated_at = clock_timestamp()
    where id = page_row.id returning * into page_row;
  return private.paste_page_json(page_row);
end;
$$;

-- Invoker entry points are exposed; checked privileged implementations stay private.
create or replace function public.paste_create_page(p_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.paste_create_page(p_id);
$$;
create or replace function public.paste_join_page(p_code text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.paste_join_page(p_code);
$$;
create or replace function public.paste_load_page(p_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.paste_load_page(p_id);
$$;
create or replace function public.paste_save_page(p_id uuid, p_text text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.paste_save_page(p_id, p_text);
$$;

revoke all on function private.paste_page_json(public.paste_pages), private.paste_create_page(uuid),
  private.paste_join_page(text), private.paste_load_page(uuid), private.paste_save_page(uuid,text)
  from public, anon, authenticated;
revoke all on function public.paste_create_page(uuid), public.paste_join_page(text),
  public.paste_load_page(uuid), public.paste_save_page(uuid,text) from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.paste_create_page(uuid), private.paste_join_page(text),
  private.paste_load_page(uuid), private.paste_save_page(uuid,text) to authenticated;
grant execute on function public.paste_create_page(uuid), public.paste_join_page(text),
  public.paste_load_page(uuid), public.paste_save_page(uuid,text) to authenticated;

commit;
`;

describe('TextDrop database identifier upgrade', () => {
  const upgrade = new URL('../supabase/upgrade-to-textdrop.sql', import.meta.url);
  let upgraded: PGlite;
  let original: TextDropPage;
  let originalMetadata: unknown[];
  let originalPages: unknown[];
  let originalAccess: unknown[];

  async function asUser(user: string | null, role = 'authenticated'): Promise<void> {
    await upgraded.exec('reset role');
    await upgraded.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
    await upgraded.exec(`set role ${role}`);
  }

  beforeAll(async () => {
    upgraded = new PGlite();
    await upgraded.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    await upgraded.query('insert into auth.users (id) values ($1), ($2), ($3)', [creator, collaborator, stranger]);
    await upgraded.exec(legacyInstallation);
    await asUser(creator);
    const created = await upgraded.query<{ page: TextDropPage }>('select public.paste_create_page($1::uuid) as page', [randomUUID()]);
    const saved = await upgraded.query<{ page: TextDropPage }>('select public.paste_save_page($1::uuid,$2) as page', [created.rows[0]!.page.id, 'Existing shared text\nবাংলা 😀']);
    original = saved.rows[0]!.page;
    await asUser(collaborator);
    await upgraded.query('select public.paste_join_page($1)', [original.code]);
    await upgraded.exec('reset role');
    originalMetadata = (await upgraded.query(`
      select oid, relacl::text, relrowsecurity from pg_class
      where oid in ('public.paste_pages'::regclass,'public.paste_page_access'::regclass) order by oid
    `)).rows;
    originalPages = (await upgraded.query('select to_jsonb(page) as page from public.paste_pages page order by id')).rows;
    originalAccess = (await upgraded.query('select to_jsonb(access) as access from public.paste_page_access access order by page_id,user_id')).rows;
    await upgraded.exec(await readFile(upgrade, 'utf8'));
  }, 30_000);

  afterAll(async () => { await upgraded?.close(); });

  it('preserves table identities, all page metadata, memberships, RLS, and grants', async () => {
    await upgraded.exec('reset role');
    expect((await upgraded.query(`
      select oid, relacl::text, relrowsecurity from pg_class
      where oid in ('public.textdrop_pages'::regclass,'public.textdrop_page_access'::regclass) order by oid
    `)).rows).toEqual(originalMetadata);
    expect((await upgraded.query('select to_jsonb(page) as page from public.textdrop_pages page order by id')).rows).toEqual(originalPages);
    expect((await upgraded.query('select to_jsonb(access) as access from public.textdrop_page_access access order by page_id,user_id')).rows).toEqual(originalAccess);
    await asUser(collaborator);
    expect((await upgraded.query<{ page: TextDropPage }>('select public.textdrop_load_page($1::uuid) as page', [original.id])).rows[0]!.page).toEqual(original);
  });

  it('uses only new RPCs and error codes while preserving codes, retries, and latest accepted saves', async () => {
    await asUser(creator);
    const saved = (await upgraded.query<{ page: TextDropPage }>('select public.textdrop_save_page($1::uuid,$2) as page', [original.id, 'New TextDrop save'])).rows[0]!.page;
    expect(saved.version).toBe(original.version + 1);
    expect(saved.code).toBe(original.code);
    expect((await upgraded.query<{ page: TextDropPage }>('select public.textdrop_create_page($1::uuid) as page', [original.id])).rows[0]!.page).toEqual(saved);
    await asUser(collaborator);
    expect((await upgraded.query<{ page: TextDropPage }>('select public.textdrop_join_page($1) as page', [original.code.toUpperCase()])).rows[0]!.page).toEqual(saved);
    await expect(upgraded.query('select public.textdrop_join_page($1)', ['bad'])).rejects.toThrow('TEXTDROP_INVALID_CODE');
    await asUser(stranger);
    await expect(upgraded.query('select public.textdrop_load_page($1::uuid)', [original.id])).rejects.toThrow('TEXTDROP_ACCESS_DENIED');
    await expect(upgraded.query('select public.textdrop_save_page($1::uuid,$2)', [original.id, 'Stolen'])).rejects.toThrow('TEXTDROP_ACCESS_DENIED');
    expect((await upgraded.query('select * from public.textdrop_pages')).rows).toEqual([]);
    await expect(upgraded.query('update public.textdrop_pages set content = $1 where id = $2', ['Stolen', original.id])).rejects.toThrow('permission denied');
    await asUser(null, 'anon');
    await expect(upgraded.query('select public.textdrop_join_page($1)', [original.code])).rejects.toThrow('permission denied');
  });

  it('removes every legacy relation, constraint, policy, function, type, and embedded function reference', async () => {
    await upgraded.exec('reset role');
    for (const sql of [
      "select relname from pg_class where left(relname,6) = 'paste_'",
      "select conname from pg_constraint where left(conname,6) = 'paste_'",
      "select polname from pg_policy where left(polname,6) = 'paste_'",
      "select proname from pg_proc where left(proname,6) = 'paste_'",
      "select typname from pg_type where left(typname,6) = 'paste_' or left(typname,7) = '_paste_'",
    ]) expect((await upgraded.query(sql)).rows).toEqual([]);
    const bodies = await upgraded.query<{ prosrc: string }>("select prosrc from pg_proc where left(proname,9) = 'textdrop_'");
    expect(bodies.rows.length).toBe(9);
    for (const body of bodies.rows) expect(body.prosrc).not.toMatch(/paste_|PASTE_/);
    await expect(upgraded.query('select public.paste_load_page($1::uuid)', [original.id])).rejects.toThrow('does not exist');
    const permissions = (await upgraded.query(`
      select
        has_function_privilege('authenticated','public.textdrop_save_page(uuid,text)','execute') as signed_in,
        has_function_privilege('anon','public.textdrop_save_page(uuid,text)','execute') as visitor,
        has_table_privilege('authenticated','public.textdrop_pages','insert,update,delete') as direct_write
    `)).rows[0];
    expect(permissions).toEqual({ signed_in: true, visitor: false, direct_write: false });
  });

  it('can rerun a completed upgrade without resetting shared records or access', async () => {
    await upgraded.exec('reset role');
    const pagesBefore = (await upgraded.query('select to_jsonb(page) as page from public.textdrop_pages page order by id')).rows;
    const accessBefore = (await upgraded.query('select to_jsonb(access) as access from public.textdrop_page_access access order by page_id,user_id')).rows;
    await upgraded.exec(await readFile(upgrade, 'utf8'));
    expect((await upgraded.query('select to_jsonb(page) as page from public.textdrop_pages page order by id')).rows).toEqual(pagesBefore);
    expect((await upgraded.query('select to_jsonb(access) as access from public.textdrop_page_access access order by page_id,user_id')).rows).toEqual(accessBefore);
  });

  it('rolls back every rename if an unexpected dependency prevents removing an old RPC', async () => {
    const blocked = new PGlite();
    try {
      await blocked.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
        $$;
      `);
      await blocked.exec(legacyInstallation);
      const pageId = randomUUID();
      await blocked.query('insert into public.paste_pages (id,code,content,version) values ($1,$2,$3,$4)', [pageId, 'f'.repeat(32), 'Preserve on rollback', 7]);
      await blocked.exec(`
        create function public.upgrade_dependency(p_id uuid) returns jsonb
        language sql begin atomic
          select public.paste_load_page(p_id);
        end;
      `);
      const before = (await blocked.query('select to_jsonb(page) as page from public.paste_pages page')).rows;
      await expect(blocked.exec(await readFile(upgrade, 'utf8'))).rejects.toThrow('other objects depend');
      await blocked.exec('rollback');
      expect((await blocked.query('select to_jsonb(page) as page from public.paste_pages page')).rows).toEqual(before);
      const objects = (await blocked.query(`
        select
          to_regclass('public.textdrop_pages') is null as no_new_table,
          to_regprocedure('public.paste_load_page(uuid)') is not null as old_rpc_preserved,
          to_regprocedure('public.textdrop_load_page(uuid)') is null as no_new_rpc
      `)).rows[0];
      expect(objects).toEqual({ no_new_table: true, old_rpc_preserved: true, no_new_rpc: true });
    } finally {
      await blocked.close();
    }
  }, 30_000);

  it('rejects missing, partial, or mixed installations before renaming anything', async () => {
    const script = await readFile(upgrade, 'utf8');
    const cases = [
      { tables: [], error: 'TEXTDROP_UPGRADE_MISSING_SCHEMA' },
      { tables: ['paste_pages'], error: 'TEXTDROP_UPGRADE_INCOMPLETE' },
      { tables: ['textdrop_pages'], error: 'TEXTDROP_UPGRADE_INCOMPLETE' },
      { tables: ['paste_pages','paste_page_access','textdrop_pages'], error: 'TEXTDROP_UPGRADE_AMBIGUOUS' },
    ];
    for (const fixture of cases) {
      const invalid = new PGlite();
      try {
        for (const table of fixture.tables) await invalid.exec(`create table public.${table} (id uuid primary key)`);
        const before = (await invalid.query("select relname from pg_class where relnamespace = 'public'::regnamespace order by relname")).rows;
        await expect(invalid.exec(script)).rejects.toThrow(fixture.error);
        await invalid.exec('rollback');
        expect((await invalid.query("select relname from pg_class where relnamespace = 'public'::regnamespace order by relname")).rows).toEqual(before);
      } finally {
        await invalid.close();
      }
    }
  }, 30_000);
});
