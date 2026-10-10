import { normalizeCode } from './model';

export interface DeviceSnippet {
  code: string;
  openedAt: string;
  name?: string;
}

export const DEVICE_SNIPPETS_KEY = 'textdrop-snippets';
export const MAX_SNIPPET_NAME_LENGTH = 80;
type SnippetStorage = Pick<Storage, 'getItem' | 'setItem' | 'length' | 'key'>;
const prefix = `${DEVICE_SNIPPETS_KEY}:`;
const removalPrefix = `${prefix}removed:`;
const openingPrefix = `${prefix}opened:`;
const namePrefix = `${prefix}name:`;
interface StoredSnippet extends DeviceSnippet { removalToken?: string }
interface StoredState { row: string | null; marker: string | null }

function newestFirst(snippets: DeviceSnippet[]): DeviceSnippet[] {
  return snippets.sort((left, right) => right.openedAt.localeCompare(left.openedAt) || left.code.localeCompare(right.code));
}

function normalizedName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

function readName(code: string, saved: string | null): string | undefined {
  if (saved === null) return undefined;
  try {
    const row: unknown = JSON.parse(saved);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const { code: storedCode, name } = row as Record<string, unknown>;
    if (normalizeCode(storedCode) !== code || typeof name !== 'string') return undefined;
    const normalized = normalizedName(name);
    return normalized && normalized.length <= MAX_SNIPPET_NAME_LENGTH ? normalized : undefined;
  } catch { return undefined; }
}

function readEntry(code: string, saved: string | null): StoredSnippet | null {
  if (saved === null) return null;
  try {
    const row: unknown = JSON.parse(saved);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const { code: storedCode, openedAt, removed, removalToken } = row as Record<string, unknown>;
    if (normalizeCode(storedCode) !== code || removed === true || typeof openedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(openedAt)) return null;
    const date = new Date(openedAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== openedAt) return null;
    if (removalToken !== undefined && (typeof removalToken !== 'string' || !removalToken)) return null;
    return { code, openedAt, ...(removalToken === undefined ? {} : { removalToken }) };
  } catch {
    return null;
  }
}

function inlineRemoved(code: string, saved: string | null): boolean {
  if (saved === null) return false;
  try {
    const row: unknown = JSON.parse(saved);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const { code: storedCode, removed } = row as Record<string, unknown>;
    return removed === true && normalizeCode(storedCode) === code;
  } catch { return false; }
}

function readRemovalToken(code: string, saved: string | null): string | null {
  if (saved === null) return null;
  try {
    const row: unknown = JSON.parse(saved);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const { code: storedCode, removed, token } = row as Record<string, unknown>;
    return removed === true && normalizeCode(storedCode) === code && typeof token === 'string' && token ? token : null;
  } catch { return null; }
}

function snapshotOf(state: StoredState): string | null {
  return state.row === null && state.marker === null ? null : JSON.stringify([state.row, state.marker]);
}

function openingKey(code: string, token: string | null): string {
  return token === null ? `${prefix}${code}` : `${openingPrefix}${code}:${token}`;
}

function isRemovedState(code: string, state: StoredState): boolean {
  if (inlineRemoved(code, state.row)) return true;
  return (readEntry(code, state.row)?.removalToken ?? null) !== readRemovalToken(code, state.marker);
}

/** Device history stores invitations, opening times and optional names, never snippet content. */
export class DeviceSnippets {
  private getStorage: () => SnippetStorage;
  private now: () => Date;

  constructor(getStorage: () => SnippetStorage = () => window.localStorage, now: () => Date = () => new Date()) {
    this.getStorage = getStorage;
    this.now = now;
  }

  private storage(): SnippetStorage {
    try {
      return this.getStorage();
    } catch {
      throw new Error('Could not read snippets saved on this device. Check browser storage permissions.');
    }
  }

  private state(storage: SnippetStorage, code: string): StoredState {
    try {
      // Choose the opening for the current removal epoch. Retry a changing
      // marker so a snapshot never combines a new removal with an old row.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const marker = storage.getItem(`${removalPrefix}${code}`);
        const row = storage.getItem(openingKey(code, readRemovalToken(code, marker)));
        if (storage.getItem(`${removalPrefix}${code}`) === marker) return { row, marker };
      }
    } catch {
      throw new Error('Could not read snippets saved on this device. Check browser storage permissions.');
    }
    throw new Error('Snippets on this device changed while reading. Try again.');
  }

  private read(storage: SnippetStorage): DeviceSnippet[] {
    const snippets: DeviceSnippet[] = [];
    try {
      const codes = new Set<string>();
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix) && /^[a-f\d]{32}$/.test(key.slice(prefix.length))) codes.add(key.slice(prefix.length));
        else if (key?.startsWith(removalPrefix) && /^[a-f\d]{32}$/.test(key.slice(removalPrefix.length))) codes.add(key.slice(removalPrefix.length));
      }
      for (const code of codes) {
        const state = this.state(storage, code);
        const snippet = readEntry(code, state.row);
        if (snippet && !isRemovedState(code, state)) {
          const name = readName(code, storage.getItem(`${namePrefix}${code}`));
          snippets.push({ code, openedAt: snippet.openedAt, ...(name === undefined ? {} : { name }) });
        }
      }
    } catch {
      throw new Error('Could not read snippets saved on this device. Check browser storage permissions.');
    }
    return newestFirst(snippets);
  }

  list(): DeviceSnippet[] {
    return this.read(this.storage());
  }

  /** An opaque opening guard includes both the row and its independent removal. */
  snapshot(code: string): string | null {
    const normalized = normalizeCode(code);
    return snapshotOf(this.state(this.storage(), normalized));
  }

  isRemoved(code: string): boolean {
    const normalized = normalizeCode(code);
    return isRemovedState(normalized, this.state(this.storage(), normalized));
  }

  rename(code: string, name: string): DeviceSnippet[] {
    const normalized = normalizeCode(code);
    const nextName = normalizedName(name);
    if (nextName.length > MAX_SNIPPET_NAME_LENGTH) throw new Error(`Use a name with ${MAX_SNIPPET_NAME_LENGTH} characters or fewer.`);
    const storage = this.storage();
    const previous = this.read(storage);
    if (!previous.some(snippet => snippet.code === normalized)) throw new Error('This snippet is no longer saved on this device. Open it again before naming it.');
    try {
      // Names are independent of opening rows and removal markers: an opening
      // cannot erase a name, and naming can never restore a removed snippet.
      storage.setItem(`${namePrefix}${normalized}`, JSON.stringify({ code: normalized, name: nextName }));
    } catch {
      throw new Error('Could not save the snippet name on this device. Check browser storage permissions or available space.');
    }
    try { return this.read(storage); }
    catch { return previous.filter(snippet => snippet.code !== normalized); }
  }

  remember(code: string, expected?: string | null): DeviceSnippet[] {
    const normalized = normalizeCode(code);
    const storage = this.storage();
    const previous = this.read(storage);
    const observed = this.state(storage, normalized);
    // Only an explicit opening with a fresh guard can acknowledge a removal.
    if ((expected !== undefined && snapshotOf(observed) !== expected) || (expected === undefined && isRemovedState(normalized, observed))) return this.read(storage);
    const opened = this.now();
    if (!Number.isFinite(opened.getTime())) throw new Error('Could not record when this snippet was opened.');
    const removalToken = readRemovalToken(normalized, observed.marker);
    try {
      // Never rewrite a removal or another epoch's opening. A late reply can
      // neither undo a removal nor hide a successful rejoin after that removal.
      storage.setItem(openingKey(normalized, removalToken), JSON.stringify({ code: normalized, openedAt: opened.toISOString(), ...(removalToken === null ? {} : { removalToken }) }));
    } catch {
      throw new Error('Could not save the snippet on this device. Check browser storage permissions or available space.');
    }
    // The row is committed. If visibility cannot be checked, omit it until the
    // next successful read instead of displaying a possibly concurrent removal.
    try { return this.read(storage); }
    catch { return previous.filter(row => row.code !== normalized); }
  }

  remove(code: string): DeviceSnippet[] {
    const normalized = normalizeCode(code);
    const storage = this.storage();
    const previous = this.read(storage);
    try {
      const token = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      storage.setItem(`${removalPrefix}${normalized}`, JSON.stringify({ code: normalized, removed: true, token }));
    } catch {
      throw new Error('Could not remove the snippet from this device. Check browser storage permissions.');
    }
    try { return this.read(storage); }
    catch { return previous.filter(row => row.code !== normalized); }
  }
}
