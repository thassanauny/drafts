import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, Card } from '../types';

const mock = vi.hoisted(() => {
  const getSession = vi.fn();
  const signInAnonymously = vi.fn();
  const range = vi.fn();
  const order = vi.fn(() => ({ range }));
  const select = vi.fn(() => ({ order }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn();
  const client = { auth: { getSession, signInAnonymously }, from, rpc };
  return { getSession, signInAnonymously, range, order, select, from, rpc, createClient: vi.fn(() => client), navigatorLock: vi.fn() };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mock.createClient, navigatorLock: mock.navigatorLock }));

const card: Card = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Book the room', description: '',
  columnId: 'todo', position: 1_024, priority: 'medium', assignee: '', dueDate: '', labels: [],
};
const board: Board = {
  id: '22222222-2222-4222-8222-222222222222', invite_code: 'a'.repeat(32), title: 'Trip plans', description: '',
  columns: [{ id: 'todo', title: 'To do', color: 'slate' }], cards: [card], revision: 1,
  created_at: '2026-10-10T01:00:00.123456+00:00', updated_at: '2026-10-10T01:00:00.123456+00:00',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key');
  vi.stubGlobal('navigator', { onLine: true });
  mock.getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mock.signInAnonymously.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mock.range.mockResolvedValue({ data: [], error: null, count: 0 });
  mock.rpc.mockResolvedValue({ data: board, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('online board sharing', () => {
  it('reports absent configuration without starting a session', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const cloud = await import('./cloud');
    expect(cloud.cloudConfigured).toBe(false);
    await expect(cloud.initializeCloud()).rejects.toThrow('not configured');
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it('shares simultaneous session checks and uses storage separate from IOU', async () => {
    const cloud = await import('./cloud');
    await Promise.all([cloud.initializeCloud(), cloud.initializeCloud(), cloud.initializeCloud()]);
    expect(mock.getSession).toHaveBeenCalledTimes(1);
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.createClient).toHaveBeenCalledWith('https://test-project.supabase.co', 'public-test-key', {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'pinboard-auth' },
    });
  });

  it('creates an anonymous identity only when the stored session is missing', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const cloud = await import('./cloud');
    await Promise.all([cloud.initializeCloud(), cloud.initializeCloud()]);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('rechecks the identity on later actions and can restore a lost session', async () => {
    const cloud = await import('./cloud');
    await cloud.initializeCloud();
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await cloud.loadBoards();
    expect(mock.getSession).toHaveBeenCalledTimes(2);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('allows authentication to retry after a failed connection', async () => {
    mock.getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const cloud = await import('./cloud');
    await expect(cloud.initializeCloud()).rejects.toThrow('Check your connection');
    await expect(cloud.initializeCloud()).resolves.toBeUndefined();
    expect(mock.getSession).toHaveBeenCalledTimes(2);
  });

  it('keeps session-restoration errors from creating a replacement identity and allows retry', async () => {
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: { message: 'Failed to fetch' } });
    const cloud = await import('./cloud');
    await expect(cloud.initializeCloud()).rejects.toThrow('Check your connection');
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    await expect(cloud.initializeCloud()).resolves.toBeUndefined();
    expect(mock.getSession).toHaveBeenCalledTimes(2);
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
  });

  it('does not sign in or send a board request if connectivity drops while checking a missing session', async () => {
    mock.getSession.mockImplementationOnce(async () => {
      vi.stubGlobal('navigator', { onLine: false });
      return { data: { session: null }, error: null };
    });
    const cloud = await import('./cloud');
    await expect(cloud.loadBoards()).rejects.toThrow('offline');
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.from).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    await expect(cloud.loadBoards()).resolves.toEqual([]);
  });

  it('retries an unsuccessful anonymous sign-in instead of retaining a failed initialization', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mock.signInAnonymously.mockResolvedValueOnce({ data: { session: null }, error: { message: 'Failed to fetch' } });
    const cloud = await import('./cloud');
    await expect(cloud.initializeCloud()).rejects.toThrow('Check your connection');
    await expect(cloud.initializeCloud()).resolves.toBeUndefined();
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(2);
  });

  it('moves the stored identity before creating the Supabase client without writing board data', async () => {
    vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_name: string, callback: () => unknown) => callback()) } });
    const session = JSON.stringify({ access_token: 'previous-token', refresh_token: 'previous-refresh', expires_at: 4_000_000_000 });
    const values = new Map([['kanban-auth', session]]);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    };
    vi.stubGlobal('window', { localStorage: storage });
    mock.createClient.mockImplementationOnce(() => {
      expect(values.get('pinboard-auth')).toBe(session);
      expect(values.get('kanban-auth')).toBe(session);
      return { auth: { getSession: mock.getSession, signInAnonymously: mock.signInAnonymously }, from: mock.from, rpc: mock.rpc };
    });
    const cloud = await import('./cloud');
    await expect(cloud.loadBoards()).resolves.toEqual([]);
    expect(storage.setItem.mock.calls).toEqual([['pinboard-auth', session]]);
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
  });

  it('explicitly coordinates ordinary auth writers with the migration Web Lock', async () => {
    vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn() } });
    const cloud = await import('./cloud');
    await cloud.initializeCloud();
    expect(mock.createClient).toHaveBeenCalledWith('https://test-project.supabase.co', 'public-test-key',
      expect.objectContaining({ auth: expect.objectContaining({ lock: mock.navigatorLock }) }));
  });

  it('does not replace an identity when browser storage is unavailable and retries once storage returns', async () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    let blocked = true;
    vi.stubGlobal('window', {
      get localStorage() {
        if (blocked) throw new Error('Storage disabled');
        return storage;
      },
    });
    const cloud = await import('./cloud');
    await expect(cloud.initializeCloud()).rejects.toThrow('saved board session');
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    blocked = false;
    await expect(cloud.initializeCloud()).resolves.toBeUndefined();
    expect(mock.createClient).toHaveBeenCalledTimes(1);
  });

  it('retains malformed migrated credentials without initializing or replacing the identity', async () => {
    const raw = JSON.stringify({ access_token: 'old-token', refresh_token: 'old-refresh' });
    const values = new Map([['kanban-auth', raw]]);
    const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('window', { localStorage: storage });
    const cloud = await import('./cloud');
    await expect(cloud.initializeCloud()).rejects.toThrow('original credentials are preserved');
    expect(values.get('kanban-auth')).toBe(raw);
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('refuses offline reads and writes without creating a queue or contacting Supabase', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const cloud = await import('./cloud');
    await expect(cloud.loadBoards()).rejects.toThrow('offline');
    await expect(cloud.createBoard(board.id, board.title, '')).rejects.toThrow('offline');
    await expect(cloud.joinBoard(board.invite_code)).rejects.toThrow('offline');
    await expect(cloud.mutateBoard(board.id, { type: 'delete_card', id: card.id })).rejects.toThrow('offline');
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('does not send a write if the browser becomes offline during session initialization', async () => {
    mock.getSession.mockImplementationOnce(async () => {
      vi.stubGlobal('navigator', { onLine: false });
      return { data: { session: {} }, error: null };
    });
    const cloud = await import('./cloud');
    await expect(cloud.mutateBoard(board.id, { type: 'update_board', patch: { title: 'New' } })).rejects.toThrow('offline');
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('loads every joined board through RLS with stable pagination even under a smaller API cap', async () => {
    const boards = [board, { ...board, id: '33333333-3333-4333-8333-333333333333' }, { ...board, id: '44444444-4444-4444-8444-444444444444' }];
    mock.range.mockResolvedValueOnce({ data: boards.slice(0, 2), error: null, count: 3 });
    mock.range.mockResolvedValueOnce({ data: boards.slice(2), error: null, count: 3 });
    const cloud = await import('./cloud');
    await expect(cloud.loadBoards()).resolves.toEqual(boards);
    expect(mock.from).toHaveBeenCalledWith('pinboard_boards');
    expect(mock.select).toHaveBeenCalledWith('id,invite_code,title,description,columns,cards,revision,created_at,updated_at', { count: 'exact' });
    expect(mock.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(mock.range.mock.calls).toEqual([[0, 99], [2, 101]]);
  });

  it('fails the whole refresh when a later page fails instead of returning partial data', async () => {
    mock.range.mockResolvedValueOnce({ data: [board], error: null, count: 2 });
    mock.range.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' }, count: null });
    const cloud = await import('./cloud');
    await expect(cloud.loadBoards()).rejects.toThrow('Check your connection');
  });

  it('rejects a shifted page rather than returning a duplicate or incomplete board list', async () => {
    mock.range.mockResolvedValueOnce({ data: [board], error: null, count: 2 });
    mock.range.mockResolvedValueOnce({ data: [board], error: null, count: 2 });
    const cloud = await import('./cloud');
    await expect(cloud.loadBoards()).rejects.toThrow('board list changed while loading');
    await expect(cloud.loadBoards()).resolves.toEqual([]);
  });

  it('rejects invalid page counts and received board data', async () => {
    const cloud = await import('./cloud');
    mock.range.mockResolvedValueOnce({ data: [board], error: null, count: 0 });
    await expect(cloud.loadBoards()).rejects.toThrow('invalid board list');
    mock.range.mockResolvedValueOnce({ data: [{ ...board, cards: [{ ...card, dueDate: '2026-02-30' }] }], error: null, count: 1 });
    await expect(cloud.loadBoards()).rejects.toThrow('invalid board data');
    mock.range.mockResolvedValueOnce({ data: [], error: null, count: 2 });
    await expect(cloud.loadBoards()).rejects.toThrow('invalid board list');
  });

  it('uses the server-generated invitation and reuses the stable ID after a lost create response', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    const created = { ...board, invite_code: 'b'.repeat(32) };
    mock.rpc.mockResolvedValueOnce({ data: created, error: null });
    const cloud = await import('./cloud');
    await expect(cloud.createBoard(board.id, board.title, '')).rejects.toThrow('Check your connection');
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    await expect(cloud.createBoard(board.id, board.title, '')).resolves.toEqual(created);
    expect(mock.rpc.mock.calls).toEqual([
      ['pinboard_create_board', { p_id: board.id, p_title: board.title, p_description: '' }],
      ['pinboard_create_board', { p_id: board.id, p_title: board.title, p_description: '' }],
    ]);
  });

  it('normalizes complete invite codes before joining', async () => {
    const cloud = await import('./cloud');
    await expect(cloud.joinBoard(` ${'A'.repeat(16)}\n${'A'.repeat(16)} `)).resolves.toEqual(board);
    expect(mock.rpc).toHaveBeenCalledWith('pinboard_join_board', { p_code: board.invite_code });
  });

  it('rejects malformed fields locally before authentication or writes', async () => {
    const cloud = await import('./cloud');
    await expect(cloud.joinBoard('abcd')).rejects.toThrow('32-character');
    await expect(cloud.createBoard('bad-id', 'Title', '')).rejects.toThrow('ID');
    await expect(cloud.createBoard(board.id, ' ', '')).rejects.toThrow('required');
    await expect(cloud.mutateBoard(board.id, { type: 'move_card', id: card.id, columnId: 'todo', position: Infinity })).rejects.toThrow('position');
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('sends one field-level operation without an expected revision or full board replacement', async () => {
    const cloud = await import('./cloud');
    const operation = { type: 'update_card' as const, id: card.id, patch: { title: 'Booked' } };
    await expect(cloud.mutateBoard(board.id, operation)).resolves.toEqual(board);
    expect(mock.rpc).toHaveBeenCalledWith('pinboard_mutate_board', { p_board_id: board.id, p_operation: operation });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it('sends only column IDs and accepts the server’s current order, metadata, and cards', async () => {
    const done = { id: 'done', title: 'Finished together', color: 'emerald' as const };
    const incoming = { ...board, columns: [done, { ...board.columns[0]!, title: 'Ready next' }], revision: 2 };
    mock.rpc.mockResolvedValueOnce({ data: incoming, error: null });
    const cloud = await import('./cloud');
    const columnIds = ['done', 'todo'];
    const result = await cloud.mutateBoard(board.id, { type: 'reorder_columns', columnIds });
    expect(mock.rpc).toHaveBeenCalledWith('pinboard_mutate_board', {
      p_board_id: board.id, p_operation: { type: 'reorder_columns', columnIds: ['done', 'todo'] },
    });
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual(incoming);
    expect(result.columns.map((column) => column.id)).toEqual(['done', 'todo']);
    expect(result.cards).toEqual(board.cards);
    expect(mock.rpc.mock.calls[0]![1].p_operation.columnIds).not.toBe(columnIds);
  });

  it('rejects an invalid column order before authentication and explains server validation failures', async () => {
    const cloud = await import('./cloud');
    await expect(cloud.mutateBoard(board.id, { type: 'reorder_columns', columnIds: ['todo', 'todo'] })).rejects.toThrow('unique');
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'PINBOARD_INVALID_OPERATION' } });
    await expect(cloud.mutateBoard(board.id, { type: 'reorder_columns', columnIds: ['todo'] })).rejects.toThrow('invalid data');
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched RPC records instead of opening a different board', async () => {
    mock.rpc.mockResolvedValueOnce({ data: { ...board, id: '33333333-3333-4333-8333-333333333333' }, error: null });
    mock.rpc.mockResolvedValueOnce({ data: { ...board, invite_code: 'b'.repeat(32) }, error: null });
    const cloud = await import('./cloud');
    await expect(cloud.mutateBoard(board.id, { type: 'delete_card', id: card.id })).rejects.toThrow('different board');
    await expect(cloud.joinBoard(board.invite_code)).rejects.toThrow('different invitation');
  });

  it('explains missing schema, disabled anonymous auth, and removed-card errors honestly', async () => {
    const cloud = await import('./cloud');
    mock.range.mockResolvedValueOnce({ data: null, count: null, error: { code: 'PGRST205', message: 'Could not find the table public.pinboard_boards in the schema cache' } });
    await expect(cloud.loadBoards()).rejects.toThrow('webapps/everydayapps/apps/pinboard/supabase/README.md');
    mock.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'missing function' } });
    await expect(cloud.createBoard(board.id, board.title, '')).rejects.toThrow('upgrade-to-pinboard.sql');
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    mock.signInAnonymously.mockResolvedValueOnce({ data: { session: null }, error: { code: 'anonymous_provider_disabled', message: 'Anonymous sign-ins are disabled' } });
    await expect(cloud.initializeCloud()).rejects.toThrow('Enable anonymous sign-ins');
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'PINBOARD_CARD_NOT_FOUND' } });
    await expect(cloud.mutateBoard(board.id, { type: 'delete_card', id: card.id })).rejects.toThrow('card was removed');
  });
});
