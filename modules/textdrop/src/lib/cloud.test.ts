import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloud } from './cloud';
import { MAX_TEXT_BYTES } from './model';
import { TEXTDROP_AUTH_KEY } from './authStorage';

const mock = vi.hoisted(() => {
  const getSession = vi.fn();
  const signInAnonymously = vi.fn();
  const rpc = vi.fn();
  const client = { auth: { getSession, signInAnonymously }, rpc };
  return { getSession, signInAnonymously, rpc, createClient: vi.fn(() => client) };
});
vi.mock('@supabase/supabase-js', async (original) => ({ ...await original<object>(), createClient: mock.createClient }));

const page = {
  id: '22222222-2222-4222-8222-222222222222', code: 'a'.repeat(32),
  text: 'Shared text', version: 1, updatedAt: '2026-10-10T01:00:00.123456+00:00',
};

function cloud() {
  return createCloud(' https://test-project.supabase.co ', ' public-test-key ');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
  mock.getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mock.signInAnonymously.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mock.rpc.mockResolvedValue({ data: page, error: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('online snippet sharing', () => {
  it('requires public configuration and never initializes a client with secret keys', async () => {
    await expect(createCloud('', '').loadPage(page.id)).rejects.toThrow('not configured');
    await expect(createCloud('https://test-project.supabase.co', 'sb_secret_private').loadPage(page.id)).rejects.toThrow('public anon');
    const serviceKey = `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`;
    await expect(createCloud('https://test-project.supabase.co', serviceKey).loadPage(page.id)).rejects.toThrow('public anon');
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it('blocks authentication migration with malformed current credentials before creating a new identity', async () => {
    // This is a browser-session migration fixture, so it retains the old key.
    const legacyKey = 'paste-auth';
    const credentials = JSON.stringify({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 1 });
    const values = new Map([[legacyKey, credentials], [TEXTDROP_AUTH_KEY, '{malformed']]);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    };
    vi.stubGlobal('window', { localStorage: storage });
    await expect(cloud().loadPage(page.id)).rejects.toThrow('Could not preserve your existing TextDrop session');
    expect(values.get(legacyKey)).toBe(credentials);
    expect(values.get(TEXTDROP_AUTH_KEY)).toBe('{malformed');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('reports browser storage read failures before creating a cloud client', async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('Storage denied'); } } });
    await expect(cloud().loadPage(page.id)).rejects.toThrow('Could not preserve your existing TextDrop session');
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('shares concurrent auth checks and stores only a session under its own key', async () => {
    const shared = cloud();
    await Promise.all([shared.loadPage(page.id), shared.loadPage(page.id), shared.joinPage(page.code)]);
    expect(mock.getSession).toHaveBeenCalledTimes(1);
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.createClient).toHaveBeenCalledWith('https://test-project.supabase.co', 'public-test-key', {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'textdrop-auth' },
    });
  });

  it('coordinates ordinary auth writers with migration through the SDK browser lock', async () => {
    vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn() } });
    await cloud().loadPage(page.id);
    const options = (mock.createClient.mock.calls as unknown[][])[0]![2] as { auth: { lock: unknown } };
    const { navigatorLock } = await import('@supabase/supabase-js');
    expect(options.auth.lock).toBe(navigatorLock);
  });

  it('starts one anonymous identity when concurrent actions lack a saved session', async () => {
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    const shared = cloud();
    await Promise.all([shared.loadPage(page.id), shared.joinPage(page.code)]);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(1);
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await shared.loadPage(page.id);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(2);
  });

  it('can retry authentication after a network error or a missing returned session', async () => {
    const shared = cloud();
    mock.getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(shared.loadPage(page.id)).rejects.toThrow('Check your connection');
    await expect(shared.loadPage(page.id)).resolves.toEqual(page);
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    mock.signInAnonymously.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(shared.loadPage(page.id)).rejects.toThrow('did not create');
  });

  it('refuses offline reads, creation, joins, and writes without contacting Supabase', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const shared = cloud();
    await expect(shared.createPage(page.id)).rejects.toThrow('offline');
    await expect(shared.joinPage(page.code)).rejects.toThrow('offline');
    await expect(shared.loadPage(page.id)).rejects.toThrow('offline');
    await expect(shared.savePage(page.id, 'Changes')).rejects.toThrow('offline');
    expect(mock.createClient).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('checks connectivity again after session restoration', async () => {
    mock.getSession.mockImplementationOnce(async () => {
      vi.stubGlobal('navigator', { onLine: false });
      return { data: { session: {} }, error: null };
    });
    await expect(cloud().savePage(page.id, 'Changes')).rejects.toThrow('offline');
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('does not create an anonymous identity after disconnecting during session restoration and can retry online', async () => {
    const shared = cloud();
    mock.getSession.mockImplementationOnce(async () => {
      vi.stubGlobal('navigator', { onLine: false });
      return { data: { session: null }, error: null };
    });
    await expect(shared.joinPage(page.code)).rejects.toThrow('offline');
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();

    vi.stubGlobal('navigator', { onLine: true });
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(shared.joinPage(page.code)).resolves.toEqual(page);
    expect(mock.createClient).toHaveBeenCalledTimes(1);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('textdrop_join_page', { p_code: page.code });
  });

  it('uses only app RPCs and returns whole-snippet server versions without conflict negotiation', async () => {
    const shared = cloud();
    await shared.createPage(page.id);
    await shared.joinPage(` ${'A'.repeat(16)}-${'A'.repeat(16)}\n`);
    await shared.loadPage(page.id);
    const saved = { ...page, text: 'A new text\n  ', version: 2 };
    mock.rpc.mockResolvedValueOnce({ data: saved, error: null });
    await expect(shared.savePage(page.id, saved.text)).resolves.toEqual(saved);
    expect(mock.rpc.mock.calls).toEqual([
      ['textdrop_create_page', { p_id: page.id }],
      ['textdrop_join_page', { p_code: page.code }],
      ['textdrop_load_page', { p_id: page.id }],
      ['textdrop_save_page', { p_id: page.id, p_text: saved.text }],
    ]);
  });

  it('keeps create IDs stable after a lost response and never silently retries a text write', async () => {
    const shared = cloud();
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    await expect(shared.createPage(page.id)).rejects.toThrow('Check your connection');
    await expect(shared.createPage(page.id)).resolves.toEqual(page);
    expect(mock.rpc.mock.calls.slice(0, 2)).toEqual([
      ['textdrop_create_page', { p_id: page.id }], ['textdrop_create_page', { p_id: page.id }],
    ]);
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    await expect(shared.savePage(page.id, 'Changes')).rejects.toThrow('Check your connection');
    expect(mock.rpc).toHaveBeenCalledTimes(3);
  });

  it('validates inputs before authentication or network requests', async () => {
    const shared = cloud();
    await expect(shared.createPage('bad')).rejects.toThrow('ID');
    await expect(shared.loadPage('bad')).rejects.toThrow('ID');
    await expect(shared.joinPage('abc')).rejects.toThrow('32-character');
    await expect(shared.savePage(page.id, 'x'.repeat(MAX_TEXT_BYTES + 1))).rejects.toThrow('1 MiB');
    await expect(shared.savePage(page.id, '\u0000')).rejects.toThrow('cannot be saved');
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('rejects missing save text before authentication while allowing an intentional empty snippet', async () => {
    const shared = cloud();
    await expect(shared.savePage(page.id, undefined as unknown as string)).rejects.toThrow('must contain text');
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
    mock.rpc.mockResolvedValueOnce({ data: { ...page, text: '', version: 2 }, error: null });
    await expect(shared.savePage(page.id, '')).resolves.toEqual({ ...page, text: '', version: 2 });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('textdrop_save_page', { p_id: page.id, p_text: '' });
  });

  it('rejects malformed responses or a response for another snippet or code', async () => {
    const shared = cloud();
    mock.rpc.mockResolvedValueOnce({ data: { ...page, version: 0 }, error: null });
    await expect(shared.loadPage(page.id)).rejects.toThrow('invalid snippet data');
    mock.rpc.mockResolvedValueOnce({ data: { ...page, id: '33333333-3333-4333-8333-333333333333' }, error: null });
    await expect(shared.savePage(page.id, 'Changes')).rejects.toThrow('different snippet');
    mock.rpc.mockResolvedValueOnce({ data: { ...page, code: 'b'.repeat(32) }, error: null });
    await expect(shared.joinPage(page.code)).rejects.toThrow('different code');
  });

  it('explains schema, access, code, limit, and disabled-auth errors', async () => {
    const shared = cloud();
    for (const [error, expected] of [
      [{ code: 'PGRST202', message: 'missing function' }, 'schema.sql'],
      [{ message: 'TEXTDROP_ACCESS_DENIED' }, 'Join again'],
      [{ message: 'TEXTDROP_INVALID_CODE' }, 'not found'],
      [{ message: 'TEXTDROP_PAGE_LIMIT' }, 'supported number'],
      [{ message: 'TEXTDROP_INVALID_TEXT' }, '1 MiB'],
      [{ message: 'TEXTDROP_AUTH_REQUIRED' }, 'could not be verified'],
    ] as const) {
      mock.rpc.mockResolvedValueOnce({ data: null, error });
      await expect(shared.loadPage(page.id)).rejects.toThrow(expected);
    }
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    mock.signInAnonymously.mockResolvedValueOnce({ data: { session: null }, error: { code: 'anonymous_provider_disabled', message: 'Anonymous sign-ins are disabled' } });
    await expect(shared.loadPage(page.id)).rejects.toThrow('Enable anonymous sign-ins');
  });

  it('distinguishes an existing database upgrade from a fresh setup when a new RPC is missing', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'missing function' } });
    const error = await cloud().loadPage(page.id).catch(failure => failure as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('upgrade-to-textdrop.sql for an earlier installation');
    expect((error as Error).message).toContain('schema.sql for a new project');
  });
});
