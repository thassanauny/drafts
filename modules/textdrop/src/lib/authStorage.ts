export const TEXTDROP_AUTH_KEY = 'textdrop-auth';
const legacyAuthKey = 'paste-auth';
type AuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type AuthLocks = Pick<LockManager, 'request'>;

function isStoredSession(value: string): boolean {
  try {
    const session: unknown = JSON.parse(value);
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return false;
    const fields = session as Record<string, unknown>;
    return typeof fields.access_token === 'string' && Boolean(fields.access_token.trim())
      && typeof fields.refresh_token === 'string' && Boolean(fields.refresh_token.trim())
      && Number.isSafeInteger(fields.expires_at) && Number(fields.expires_at) > 0;
  } catch {
    return false;
  }
}

/** Share the auth client's locks so another tab cannot replace an identity during migration. */
export async function migrateLegacyAuthStorage(
  storage?: AuthStorage,
  locks: AuthLocks | null | undefined = globalThis.navigator?.locks,
): Promise<void> {
  if (!storage && typeof window === 'undefined') return;
  try {
    const target = storage ?? window.localStorage;
    const migrate = () => {
      const current = target.getItem(TEXTDROP_AUTH_KEY);
      if (current !== null && !isStoredSession(current)) throw new Error('Invalid current session.');
      const legacy = target.getItem(legacyAuthKey);
      if (legacy === null) return;
      if (current !== null && current !== legacy) return;
      if (!isStoredSession(legacy)) throw new Error('Invalid legacy session.');
      // A browser without Web Locks cannot safely rename credentials while
      // another tab writes. Leave the original available for recovery.
      if (!locks) throw new Error('Browser session locking is unavailable.');
      if (current === null) {
        target.setItem(TEXTDROP_AUTH_KEY, legacy);
        if (target.getItem(TEXTDROP_AUTH_KEY) !== legacy) throw new Error('Session copy was not stored.');
      }
      // Retain the original for older app versions whose writers may not use
      // these locks. No migration discards recoverable credentials.
    };
    if (locks) {
      await locks.request(`lock:${TEXTDROP_AUTH_KEY}`, () => locks.request(`lock:${legacyAuthKey}`, migrate));
    } else migrate();
  } catch {
    throw new Error('Could not preserve your existing TextDrop session. Check browser storage permissions and try again.');
  }
}
