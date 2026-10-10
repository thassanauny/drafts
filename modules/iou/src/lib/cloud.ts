import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Group } from '../types';
import { validateGroup } from './ledger';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

export const cloudConfigured = Boolean(supabaseUrl && supabaseKey);

export interface CloudRecord {
  group: Group;
  revision: number;
}

export class CloudConflictError extends Error {
  readonly code = 'CLOUD_CONFLICT';

  constructor() {
    super('This group is being updated. Your saved changes will retry automatically.');
    this.name = 'CloudConflictError';
  }
}

let client: SupabaseClient | undefined;
let authentication: Promise<void> | undefined;

function getClient(): SupabaseClient {
  if (!cloudConfigured) {
    throw new Error('Live sharing is not configured. Add the Supabase settings and rebuild the app.');
  }
  if (!client) {
    try {
      client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    } catch {
      throw new Error('The Supabase settings are invalid. Check the project URL and public API key.');
    }
  }
  return client;
}

interface ServiceError {
  message?: string;
  code?: string;
}

function serviceError(error: ServiceError, action: string): Error {
  if (error.code === 'PT409' && error.message === 'IOU_CONFLICT') return new CloudConflictError();
  if (error.message === 'IOU_INVALID_INVITE') return new Error('That invite code was not found. Check the code and try again.');
  if (error.message === 'IOU_ACCESS_DENIED') return new Error('You no longer have access to this group. Join again using its invite code.');
  if (error.message === 'IOU_IMMUTABLE_SETTINGS') return new Error('A shared group’s currency, invite code, ID, and creation time cannot change.');
  if (error.message === 'IOU_GROUP_LIMIT') return new Error('This session has reached the supported number of shared groups.');
  if (error.message === 'IOU_INVALID_GROUP') return new Error('The group contains invalid data. Review its members and transactions.');
  if (error.code === 'PGRST202' || error.code === '42P01' || error.code === '42883') {
    return new Error('Live sharing needs database setup. Run supabase/schema.sql in your Supabase project.');
  }
  if (/anonymous.*(?:disabled|not allowed)|anonymous_provider_disabled/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
    return new Error('Enable anonymous sign-ins in Supabase Authentication to use shared groups.');
  }
  if (error.message === 'IOU_AUTH_REQUIRED' || error.code === 'PGRST301' || error.code === 'PGRST303') {
    return new Error('The shared-group session could not be verified. Reload the app and try again.');
  }
  if (/fetch|network|connection|failed to send|load failed/i.test(error.message ?? '')) {
    return new Error('Could not connect to shared groups. Check your connection and try again.');
  }
  return new Error(`Could not ${action}. ${error.message || 'Please try again.'}`);
}

/** Rechecks the current browser identity; concurrent checks share one attempt. */
export async function initializeCloud(): Promise<void> {
  if (!authentication) {
    authentication = (async () => {
      const supabase = getClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) throw serviceError(error, 'restore your shared-group session');
      if (data.session) return;
      const result = await supabase.auth.signInAnonymously();
      if (result.error) throw serviceError(result.error, 'start your shared-group session');
      if (!result.data.session) throw new Error('Supabase did not create a shared-group session. Please try again.');
    })().finally(() => {
      authentication = undefined;
    });
  }
  await authentication;
}

function readRecord(input: unknown): CloudRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The server returned an invalid group record.');
  }
  const row = input as Record<string, unknown>;
  const revision = typeof row.version === 'string' && /^\d+$/.test(row.version) ? Number(row.version) : row.version;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('The server returned an invalid group revision.');
  }
  try {
    return { group: validateGroup(row.payload), revision };
  } catch {
    throw new Error('The server returned invalid group data. Refresh the app or check the database setup.');
  }
}

export async function loadCloudGroups(): Promise<CloudRecord[]> {
  await initializeCloud();
  // RLS filters these rows by auth.uid(); no global group list is readable.
  const records: CloudRecord[] = [];
  let offset = 0;
  for (;;) {
    // ID order remains stable as other members edit groups during pagination.
    const { data, error, count } = await getClient().from('iou_groups')
      .select('payload,version', { count: 'exact' }).order('id', { ascending: true }).range(offset, offset + 99);
    if (error) throw serviceError(error, 'load your shared groups');
    if (!Array.isArray(data) || !Number.isSafeInteger(count) || count === null || count < 0
      || offset + data.length > count || (data.length === 0 && offset < count)) {
      throw new Error('The server returned an invalid group list.');
    }
    records.push(...data.map(readRecord));
    offset += data.length;
    if (offset >= count) return records;
  }
}

export async function createCloudGroup(group: Group): Promise<CloudRecord> {
  const payload = validateGroup(group);
  await initializeCloud();
  const { data, error } = await getClient().rpc('iou_create_group', { p_payload: payload });
  if (error) throw serviceError(error, 'create the shared group');
  // The database generates the invitation code. Use this returned group.
  return readRecord(data);
}

export async function joinCloudGroup(inviteCode: string): Promise<CloudRecord> {
  const normalized = inviteCode.trim().replace(/\s+/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new Error('Enter the complete 32-character invite code.');
  await initializeCloud();
  const { data, error } = await getClient().rpc('iou_join_group', { p_invite_code: normalized });
  if (error) throw serviceError(error, 'join the shared group');
  return readRecord(data);
}

export async function saveCloudGroup(group: Group, expectedRevision: number): Promise<CloudRecord> {
  const payload = validateGroup(group);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('The group revision is invalid. Reload the group before editing it.');
  await initializeCloud();
  const { data, error } = await getClient().rpc('iou_save_group', { p_payload: payload, p_expected_version: expectedRevision });
  if (error) throw serviceError(error, 'save the shared group');
  return readRecord(data);
}
