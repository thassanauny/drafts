type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SessionLocks = Pick<LockManager, 'request'>;
const currentKey = 'pinboard-auth';
const previousKey = 'kanban-auth';

function validateSession(raw: string): void {
  const session: unknown = JSON.parse(raw);
  if (typeof session !== 'object' || session === null || Array.isArray(session)) throw new Error('Invalid saved session');
  const value = session as Record<string, unknown>;
  if (typeof value.access_token !== 'string' || !value.access_token.trim()
    || typeof value.refresh_token !== 'string' || !value.refresh_token.trim()
    || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= 0) {
    throw new Error('Invalid saved session');
  }
}

/** Copy the previous app's identity without replacing an existing Pinboard session. */
export async function migratePinboardSession(
  storage: SessionStorage,
  locks: SessionLocks | null | undefined = globalThis.navigator?.locks,
): Promise<void> {
  try {
    const migrate = () => {
      const current = storage.getItem(currentKey);
      if (current !== null) { validateSession(current); return; }
      const previous = storage.getItem(previousKey);
      if (previous === null) return;
      validateSession(previous);
      if (!locks) throw new Error('Cross-tab session locking is unavailable');
      // Respect writers that do not use the auth client's browser locks.
      const latestCurrent = storage.getItem(currentKey);
      if (latestCurrent !== null) { validateSession(latestCurrent); return; }
      if (storage.getItem(previousKey) !== previous) throw new Error('Saved session changed');
      storage.setItem(currentKey, previous);
      if (storage.getItem(currentKey) !== previous) throw new Error('Session copy failed');
      // Earlier versions may still write without these locks. Retain the old
      // identity as a recovery copy rather than deleting a rotated credential.
    };
    if (locks) {
      await locks.request(`lock:${currentKey}`, () =>
        locks.request(`lock:${previousKey}`, migrate));
    } else migrate();
  } catch {
    throw new Error('Could not restore your saved board session. Your original credentials are preserved. Check browser storage and reload, or join again with your invitation code.');
  }
}
