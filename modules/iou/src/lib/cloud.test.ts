import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '../types';

const mock = vi.hoisted(() => {
  const getSession = vi.fn();
  const signInAnonymously = vi.fn();
  const range = vi.fn();
  const order = vi.fn(() => ({ range }));
  const select = vi.fn(() => ({ order }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn();
  const client = { auth: { getSession, signInAnonymously }, from, rpc };
  return { getSession, signInAnonymously, range, order, select, from, rpc, client, createClient: vi.fn(() => client) };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mock.createClient }));

const group: Group = {
  id: 'trip-2026', name: 'Weekend away', description: '', currency: 'THB', icon: '🌴', color: '#b1c69a',
  inviteCode: 'a'.repeat(32), createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  members: [{ id: 'alex', name: 'Alex' }, { id: 'sam', name: 'Sam' }], transactions: [],
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key');
  mock.getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mock.signInAnonymously.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mock.range.mockResolvedValue({ data: [], error: null, count: 0 });
  mock.rpc.mockResolvedValue({ data: { payload: group, version: 1 }, error: null });
});

describe('shared group access', () => {
  it('reports absent cloud configuration without starting a session', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const cloud = await import('./cloud');
    expect(cloud.cloudConfigured).toBe(false);
    await expect(cloud.initializeCloud()).rejects.toThrow('not configured');
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it('restores the existing identity without creating another anonymous user', async () => {
    const cloud = await import('./cloud');
    await Promise.all([cloud.initializeCloud(), cloud.initializeCloud(), cloud.initializeCloud()]);
    expect(mock.getSession).toHaveBeenCalledTimes(1);
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
    expect(mock.createClient).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }));
  });

  it('creates one anonymous identity when there is no stored session', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const cloud = await import('./cloud');
    await Promise.all([cloud.initializeCloud(), cloud.initializeCloud()]);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('allows initialization to be retried after a connection error', async () => {
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: { message: 'Failed to fetch' } });
    const cloud = await import('./cloud');
    await expect(cloud.initializeCloud()).rejects.toThrow('Check your connection');
    await expect(cloud.initializeCloud()).resolves.toBeUndefined();
    expect(mock.getSession).toHaveBeenCalledTimes(2);
  });

  it('detects a lost session after successful initialization and restores anonymous access', async () => {
    const cloud = await import('./cloud');
    await cloud.initializeCloud();
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await cloud.loadCloudGroups();
    expect(mock.getSession).toHaveBeenCalledTimes(2);
    expect(mock.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('checks restored sessions again without replacing a valid browser identity', async () => {
    const cloud = await import('./cloud');
    await cloud.initializeCloud();
    await cloud.loadCloudGroups();
    await cloud.joinCloudGroup(group.inviteCode);
    expect(mock.getSession).toHaveBeenCalledTimes(3);
    expect(mock.signInAnonymously).not.toHaveBeenCalled();
  });

  it('uses the server-generated invite code returned by create', async () => {
    const created = { ...group, inviteCode: 'b'.repeat(32) };
    mock.rpc.mockResolvedValue({ data: { payload: created, version: 1 }, error: null });
    const cloud = await import('./cloud');
    const record = await cloud.createCloudGroup(group);
    expect(record.group.inviteCode).toBe(created.inviteCode);
    expect(mock.rpc).toHaveBeenCalledWith('iou_create_group', { p_payload: group });
    expect(record.group).not.toBe(created);
  });

  it('normalizes complete invitation codes before the join RPC', async () => {
    const cloud = await import('./cloud');
    await cloud.joinCloudGroup(`  ${'A'.repeat(16)} \n${'A'.repeat(16)}  `);
    expect(mock.rpc).toHaveBeenCalledWith('iou_join_group', { p_invite_code: 'a'.repeat(32) });
  });

  it('rejects malformed invitation codes without contacting the server', async () => {
    const cloud = await import('./cloud');
    await expect(cloud.joinCloudGroup('abcd')).rejects.toThrow('32-character');
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('passes the expected revision and reports current application conflicts distinctly', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'IOU_CONFLICT' } });
    const cloud = await import('./cloud');
    await expect(cloud.saveCloudGroup(group, 7)).rejects.toBeInstanceOf(cloud.CloudConflictError);
    expect(mock.rpc).toHaveBeenCalledWith('iou_save_group', { p_payload: group, p_expected_version: 7 });
  });

  it('reports database serialization failures without treating them as application conflicts', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'could not serialize transaction' } });
    const cloud = await import('./cloud');
    const failure = await cloud.saveCloudGroup(group, 7).catch(error => error);
    expect(failure).not.toBeInstanceOf(cloud.CloudConflictError);
    expect(failure.message).toMatch(/Could not save.*serialize transaction/);
  });

  it('rejects unsafe revisions before sending any update', async () => {
    const cloud = await import('./cloud');
    await expect(cloud.saveCloudGroup(group, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow('revision is invalid');
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('reads through RLS and validates every received ledger', async () => {
    mock.range.mockResolvedValue({ data: [{ payload: group, version: '3' }], error: null, count: 1 });
    const cloud = await import('./cloud');
    await expect(cloud.loadCloudGroups()).resolves.toEqual([{ group, revision: 3 }]);
    expect(mock.from).toHaveBeenCalledWith('iou_groups');
    expect(mock.select).toHaveBeenCalledWith('payload,version', { count: 'exact' });
    mock.range.mockResolvedValue({ data: [{ payload: { ...group, members: [] }, version: 3 }], error: null, count: 1 });
    await expect(cloud.loadCloudGroups()).rejects.toThrow('invalid group data');
  });

  it('loads every joined group even when the API cap is smaller than a page', async () => {
    const groups = [group, { ...group, id: 'trip-2027' }, { ...group, id: 'trip-2028' }];
    mock.range.mockResolvedValueOnce({ data: groups.slice(0, 2).map(payload => ({ payload, version: 1 })), error: null, count: 3 });
    mock.range.mockResolvedValueOnce({ data: [{ payload: groups[2], version: 1 }], error: null, count: 3 });
    const cloud = await import('./cloud');
    await expect(cloud.loadCloudGroups()).resolves.toEqual(groups.map(group => ({ group, revision: 1 })));
    expect(mock.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(mock.range.mock.calls).toEqual([[0, 99], [2, 101]]);
  });

  it('rejects a failed later page instead of returning a partial successful sync', async () => {
    mock.range.mockResolvedValueOnce({ data: [{ payload: group, version: 1 }], error: null, count: 2 });
    mock.range.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' }, count: null });
    const cloud = await import('./cloud');
    await expect(cloud.loadCloudGroups()).rejects.toThrow('Check your connection');
  });

  it('explains missing database setup without a false success', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing function' } });
    const cloud = await import('./cloud');
    await expect(cloud.createCloudGroup(group)).rejects.toThrow('schema.sql');
  });

  it('reports a lost create response without automatically creating another group', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    const cloud = await import('./cloud');
    await expect(cloud.createCloudGroup(group)).rejects.toThrow('Check your connection');
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    await expect(cloud.createCloudGroup(group)).resolves.toEqual({ group, revision: 1 });
    expect(mock.rpc).toHaveBeenLastCalledWith('iou_create_group', { p_payload: group });
  });
});
