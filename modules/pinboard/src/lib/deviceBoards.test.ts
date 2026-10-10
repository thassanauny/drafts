import { describe, expect, it, vi } from 'vitest';
import { DeviceBoards, DEVICE_BOARDS_PREFIX } from './deviceBoards';

const first = 'a'.repeat(32);
const second = 'b'.repeat(32);
const key = (code: string) => DEVICE_BOARDS_PREFIX + code;
function fixture() {
  const values = new Map<string, string>([
    ['pinboard-auth', 'existing session'],
    ['iou-store', 'existing groups'],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
    }),
  };
  return { values, storage, device: new DeviceBoards(() => storage) };
}

describe('local board removal preferences', () => {
  it('persists one removal, saves no board contents, and preserves other apps and authentication', () => {
    const { device, storage, values } = fixture();
    device.remove(first.toUpperCase());
    expect(new DeviceBoards(() => storage).removedCodes()).toEqual(
      new Set([first]),
    );
    expect(device.removal(first)).toMatch(/^[a-f\d-]{36}$/);
    expect([...values.keys()]).toEqual([
      'pinboard-auth',
      'iou-store',
      key(first),
    ]);
    expect(values.get('pinboard-auth')).toBe('existing session');
    expect(values.get('iou-store')).toBe('existing groups');
  });

  it('restores only the explicitly joined board and keeps unrelated tab removals', () => {
    const { device, storage } = fixture();
    device.remove(first);
    const marker = device.removal(first);
    new DeviceBoards(() => storage).remove(second);
    expect(device.restore(first, marker)).toBe(true);
    expect(device.removedCodes()).toEqual(new Set([second]));
    expect(device.restore(first, null)).toBe(true);
  });

  it('lets a newer removal supersede an older pending join', () => {
    const { device, storage } = fixture();
    expect(device.removal(first)).toBeNull();
    new DeviceBoards(() => storage).remove(first);
    expect(device.restore(first, null)).toBe(false);
    const earlier = device.removal(first);
    device.remove(first);
    expect(device.restore(first, earlier)).toBe(false);
    expect(device.removedCodes()).toEqual(new Set([first]));
  });

  it('cannot erase a newer removal inserted between the restore read and write', () => {
    const { device, storage } = fixture();
    device.remove(first);
    const earlier = device.removal(first);
    const otherTab = new DeviceBoards(() => storage);
    const originalWrite = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementationOnce((name, value) => {
      otherTab.remove(first);
      originalWrite(name, value);
    });
    expect(device.restore(first, earlier)).toBe(false);
    expect(device.removal(first)).not.toBe(earlier);
    expect(device.removedCodes()).toEqual(new Set([first]));
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('lets two joins acknowledge the same removal and requires a fresh join after another removal', () => {
    const { device, storage } = fixture();
    device.remove(first);
    const marker = device.removal(first);
    const otherTab = new DeviceBoards(() => storage);
    expect(device.restore(first, marker)).toBe(true);
    expect(otherTab.restore(first, marker)).toBe(true);
    expect(new DeviceBoards(() => storage).removedCodes()).toEqual(new Set());
    otherTab.remove(first);
    expect(device.restore(first, marker)).toBe(false);
    expect(device.restore(first, device.removal(first))).toBe(true);
    expect(device.removedCodes()).toEqual(new Set());
  });

  it('preserves existing device markers and ignores acknowledgements for another epoch', () => {
    const { device, values } = fixture();
    const marker = 'existing removal';
    values.set(key(first), marker);
    values.set(`${key(first)}:restored:another removal`, '1');
    expect(device.removal(first)).toBe(marker);
    expect(device.restore(first, marker)).toBe(true);
    expect(values.get(key(first))).toBe(marker);
    expect(device.removal(first)).toBeNull();
  });

  it.each(['removal', 'list', 'restore'] as const)(
    'keeps a newer removal written between marker and acknowledgement reads during %s',
    (operation) => {
      const { device, storage, values } = fixture();
      device.remove(first);
      const earlier = device.removal(first)!;
      device.restore(first, earlier);
      const acknowledgement = `${key(first)}:restored:${earlier}`;
      let interleaved = false;
      storage.getItem.mockImplementation((name) => {
        if (name === acknowledgement && !interleaved) {
          interleaved = true;
          new DeviceBoards(() => storage).remove(first);
        }
        return values.get(name) ?? null;
      });
      if (operation === 'removal')
        expect(device.removal(first)).toBe(values.get(key(first)));
      if (operation === 'list')
        expect(device.removedCodes()).toEqual(new Set([first]));
      if (operation === 'restore')
        expect(device.restore(first, earlier)).toBe(false);
      expect(interleaved).toBe(true);
      expect(device.removal(first)).not.toBeNull();
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );

  it.each(['removal', 'list', 'restore'] as const)(
    'fails retryably rather than returning a preference that keeps changing during %s',
    (operation) => {
      const { device, storage, values } = fixture();
      device.remove(first);
      const earlier = device.removal(first);
      const originalRead = storage.getItem.getMockImplementation()!;
      let markerReads = 0;
      storage.getItem.mockImplementation((name) => {
        const result = originalRead(name);
        if (name === key(first)) {
          markerReads += 1;
          if (markerReads > 20) throw new Error('Fixture retry limit');
          values.set(name, `removal-${markerReads}`);
        }
        return result;
      });
      const read = () =>
        operation === 'removal'
          ? device.removal(first)
          : operation === 'list'
            ? device.removedCodes()
            : device.restore(first, earlier);
      expect(read).toThrow('Could not read boards');
      expect(markerReads).toBeLessThanOrEqual(6);
      expect(values.get('pinboard-auth')).toBe('existing session');
      storage.getItem.mockImplementation(originalRead);
      expect(device.removal(first)).toBe(values.get(key(first)));
      expect(device.restore(first, device.removal(first))).toBe(true);
    },
  );

  it('rejects invalid codes without reading or changing storage', () => {
    const { device, storage } = fixture();
    expect(() => device.remove('bad')).toThrow('32-character');
    expect(() => device.restore('bad', null)).toThrow('32-character');
    expect(() => device.removal('bad')).toThrow('32-character');
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('ignores unrelated and malformed keys and returns independent sets', () => {
    const { device, values } = fixture();
    values.set(key('invalid'), 'removed');
    device.remove(first);
    device.removedCodes().clear();
    expect(device.removedCodes()).toEqual(new Set([first]));
  });

  it('reports unavailable reads without silently treating removals as missing', () => {
    const denied = new DeviceBoards(() => {
      throw new Error('SecurityError');
    });
    expect(() => denied.removedCodes()).toThrow('Could not read boards');
    expect(() => denied.removal(first)).toThrow('Could not read boards');
    const { device, storage } = fixture();
    storage.key.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => device.removedCodes()).toThrow('Could not read boards');
  });

  it('keeps the previous preference when a remove or restore write fails', () => {
    const { device, storage } = fixture();
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => device.remove(first)).toThrow('Could not remove the board');
    expect(device.removal(first)).toBeNull();
    device.remove(first);
    const marker = device.removal(first);
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    expect(() => device.restore(first, marker)).toThrow(
      'Could not restore the board',
    );
    expect(device.removal(first)).toBe(marker);
  });
});
