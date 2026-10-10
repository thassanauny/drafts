import { normalizeInviteCode } from './board';

export const DEVICE_BOARDS_PREFIX = 'pinboard-removed-board:';
type BoardStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'length' | 'key'
>;
const restoredKey = (key: string, marker: string) => `${key}:restored:${marker}`;
function activeRemoval(storage: BoardStorage, key: string): string | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const marker = storage.getItem(key);
    const restored =
      marker !== null && storage.getItem(restoredKey(key, marker)) === '1';
    // The marker can change in another tab while its acknowledgement is read.
    if (storage.getItem(key) === marker) return restored ? null : marker;
  }
  throw new Error('Board removal changed while reading. Try again.');
}

/** Only removal preferences are saved here, never board contents or credentials. */
export class DeviceBoards {
  private getStorage: () => BoardStorage;

  constructor(getStorage: () => BoardStorage = () => window.localStorage) {
    this.getStorage = getStorage;
  }

  removedCodes(): Set<string> {
    const codes = new Set<string>();
    try {
      const storage = this.getStorage();
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(DEVICE_BOARDS_PREFIX)) {
          const code = key.slice(DEVICE_BOARDS_PREFIX.length);
          if (/^[a-f0-9]{32}$/.test(code) && activeRemoval(storage, key) !== null)
            codes.add(code);
        }
      }
      return codes;
    } catch {
      throw new Error(
        'Could not read boards on this device. Allow browser storage and try again.',
      );
    }
  }

  removal(code: string): string | null {
    const key = DEVICE_BOARDS_PREFIX + normalizeInviteCode(code);
    try {
      return activeRemoval(this.getStorage(), key);
    } catch {
      throw new Error(
        'Could not read boards on this device. Allow browser storage and try again.',
      );
    }
  }

  remove(code: string): void {
    const key = DEVICE_BOARDS_PREFIX + normalizeInviteCode(code);
    try {
      // A different marker lets an older Join response respect a newer removal.
      this.getStorage().setItem(key, crypto.randomUUID());
    } catch {
      throw new Error(
        'Could not remove the board from this device. Allow browser storage and try again.',
      );
    }
  }

  restore(code: string, previousRemoval: string | null): boolean {
    const key = DEVICE_BOARDS_PREFIX + normalizeInviteCode(code);
    const current = this.removal(code);
    if (current === null) return true;
    if (current !== previousRemoval) return false;
    try {
      // Acknowledge only this removal epoch. A newer tab removal keeps its own
      // marker even if it arrives between our comparison and this write.
      this.getStorage().setItem(restoredKey(key, current), '1');
      return this.removal(code) === null;
    } catch {
      throw new Error(
        'Could not restore the board on this device. Allow browser storage and try again.',
      );
    }
  }
}
