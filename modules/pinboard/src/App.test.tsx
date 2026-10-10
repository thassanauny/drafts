// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { Board, Card } from './types';
import { DeviceBoards, DEVICE_BOARDS_PREFIX } from './lib/deviceBoards';

const cloud = vi.hoisted(() => ({
  configured: true,
  loadBoards: vi.fn(),
  createBoard: vi.fn(),
  joinBoard: vi.fn(),
  mutateBoard: vi.fn(),
}));
vi.mock('./lib/cloud', () => ({
  get cloudConfigured() {
    return cloud.configured;
  },
  loadBoards: cloud.loadBoards,
  createBoard: cloud.createBoard,
  joinBoard: cloud.joinBoard,
  mutateBoard: cloud.mutateBoard,
}));

const board: Board = {
  id: '22222222-2222-4222-8222-222222222222',
  invite_code: 'a'.repeat(32),
  title: 'Weekend plans',
  description: '',
  columns: [
    { id: 'todo', title: 'To do', color: 'slate' },
    { id: 'doing', title: 'In progress', color: 'amber' },
    { id: 'done', title: 'Done', color: 'emerald' },
  ],
  cards: [],
  revision: 1,
  created_at: '2026-10-10T01:00:00Z',
  updated_at: '2026-10-10T01:00:00Z',
};
const card: Card = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Buy coffee',
  description: '',
  columnId: 'todo',
  position: 1024,
  priority: 'medium',
  assignee: 'Alex',
  dueDate: '',
  labels: [],
};
let root: Root | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function button(
  name: string,
  parent: ParentNode = document,
): HTMLButtonElement {
  const found = [...parent.querySelectorAll('button')].find(
    (element) =>
      (
        element.getAttribute('aria-label') ??
        element.textContent ??
        ''
      ).trim() === name,
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}
function field(name: string): HTMLInputElement | HTMLTextAreaElement {
  const label = [...document.querySelectorAll('label')].find((element) => {
    const caption = element.cloneNode(true) as HTMLLabelElement;
    caption
      .querySelectorAll('input, textarea, select')
      .forEach((control) => control.remove());
    return caption.textContent?.replace(/\s+/g, ' ').trim() === name;
  });
  const input = label?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  );
  if (!input) throw new Error(`Field not found: ${name}`);
  return input;
}
async function click(name: string, parent?: ParentNode) {
  await act(async () => {
    button(name, parent).click();
  });
}
async function fill(name: string, value: string) {
  const input = field(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(name: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${name}"]`,
  )!;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function mount(
  boards: Board[] = [board],
  code = board.invite_code,
  strict = false,
  hash?: string,
) {
  window.history.replaceState(
    null,
    '',
    hash ? `/${hash}` : code ? `/#board/${code}` : '/',
  );
  cloud.loadBoards.mockResolvedValue(boards);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => {
    root!.render(
      strict
        ? createElement(StrictMode, null, createElement(App))
        : createElement(App),
    );
  });
}
async function refresh() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}
async function removeInAnotherTab() {
  await act(async () => {
    new DeviceBoards().remove(board.invite_code);
    window.dispatchEvent(new StorageEvent('storage', { key: DEVICE_BOARDS_PREFIX + board.invite_code, storageArea: window.localStorage }));
  });
}
async function navigateHash(hash: string) {
  await act(async () => {
    window.history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new Event('hashchange'));
  });
}
function columnTitles() {
  return [...document.querySelectorAll('main section[aria-label] h2')].map(
    (item) => item.textContent,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.resetAllMocks();
  cloud.configured = true;
  cloud.joinBoard.mockRejectedValue(new Error('Invitation unavailable'));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, 'onLine', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(document, 'hidden', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Pinboard UI and synchronization', () => {
  it('opens direct invitation links, clears a cancelled invitation, and stays closed after reload', async () => {
    await mount([], '', false, `#join/${board.invite_code}`);
    expect(field('Invitation code or link').value).toBe(board.invite_code);
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    await click('Cancel');
    expect(window.location.hash).toBe('');
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await mount([], '');
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('keeps removal and a retryable form when restoring its device preference fails', async () => {
    const device = new DeviceBoards();
    device.remove(board.invite_code);
    await mount();
    cloud.joinBoard.mockResolvedValue(board);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    await click('Join board');
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(document.querySelector('dialog')?.textContent).toContain(
      'Could not restore the board',
    );
    expect(device.removal(board.invite_code)).not.toBeNull();
    await click('Join board');
    expect(device.removal(board.invite_code)).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe(board.title);
  });

  it('confirms local removal, preserves cancelled details, and stays hidden after polling and reload', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Keep this draft');
    await click('Remove from this device');
    expect(field('Invitation code').value).toBe(board.invite_code);
    expect(document.body.textContent).toContain('Everyone else keeps access');
    await click('Keep on this device');
    expect(field('Board name').value).toBe('Keep this draft');
    await click('Remove from this device');
    await click('Remove from this device');
    expect(window.location.hash).toBe('');
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(cloud.mutateBoard).not.toHaveBeenCalled();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    await refresh();
    expect(document.querySelector('.board-preview')).toBeNull();
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await mount([board], '');
    expect(document.querySelector('.board-preview')).toBeNull();
  });

  it('allows opening settings and removing locally while offline', async () => {
    await mount();
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(button('Settings').disabled).toBe(false);
    await click('Settings');
    expect(button('Save details').disabled).toBe(true);
    await click('Remove from this device');
    expect(button('Remove from this device').disabled).toBe(false);
    await click('Remove from this device');
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(cloud.mutateBoard).not.toHaveBeenCalled();
  });

  it('keeps the board and confirmation when its local removal cannot be saved', async () => {
    await mount();
    await click('Settings');
    await click('Remove from this device');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    await click('Remove from this device');
    expect(document.querySelector('h1')?.textContent).toBe(board.title);
    expect(document.querySelector('dialog')?.textContent).toContain(
      'Could not remove the board',
    );
    expect(window.location.hash).toBe(`#board/${board.invite_code}`);
    expect(cloud.mutateBoard).not.toHaveBeenCalled();
  });

  it('requires an explicit successful join to restore a removed ordinary board link', async () => {
    const device = new DeviceBoards();
    device.remove(board.invite_code);
    device.remove('b'.repeat(32));
    await mount();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    expect(field('Invitation code or link').value).toBe(board.invite_code);
    await click('Join board');
    expect(device.removal(board.invite_code)).not.toBeNull();
    expect(document.querySelector('.board-preview')).toBeNull();
    cloud.joinBoard.mockResolvedValueOnce(board);
    await click('Join board');
    expect(device.removal(board.invite_code)).toBeNull();
    expect(device.removal('b'.repeat(32))).not.toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe(board.title);
  });

  it('does not restore a removed board from a refresh that was already in flight', async () => {
    await mount();
    const pending = deferred<Board[]>();
    cloud.loadBoards.mockReturnValueOnce(pending.promise);
    await refresh();
    await click('Settings');
    await click('Remove from this device');
    await click('Remove from this device');
    await act(async () => {
      pending.resolve([{ ...board, revision: 5 }]);
    });
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it('keeps another tab’s removal after a pending save completes', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Accepted later');
    const pending = deferred<Board>();
    cloud.mutateBoard.mockReturnValueOnce(pending.promise);
    await click('Save details');
    await act(async () => {
      new DeviceBoards().remove(board.invite_code);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DEVICE_BOARDS_PREFIX + board.invite_code,
          storageArea: window.localStorage,
        }),
      );
      pending.resolve({ ...board, title: 'Accepted later', revision: 2 });
    });
    expect(field('Board name').value).toBe('Accepted later');
    expect(document.querySelector('[aria-label="Draft recovery"]')).not.toBeNull();
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(window.location.hash).toBe('');
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it.each([
    ['Settings', 'Board name', 'Save details'],
    ['Edit Buy coffee', 'Card title', 'Save'],
    ['Settings for To do', 'Column name', 'Save'],
    ['Add a card', 'Card title', 'Save'],
    ['Add column', 'Column name', 'Save'],
  ])('preserves and recovers the %s draft after cross-tab removal', async (opener, label, saveButton) => {
    const populated = { ...board, cards: [card] };
    await mount([populated]);
    await click(opener);
    await fill(label, 'Unsaved work');
    await removeInAnotherTab();
    expect(field(label).value).toBe('Unsaved work');
    expect(button(saveButton).disabled).toBe(true);
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    const storedValues = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.getItem(window.localStorage.key(index)!));
    expect(storedValues.join('')).not.toContain('Unsaved work');
    cloud.joinBoard.mockResolvedValueOnce({ ...populated, revision: 2 });
    await click('Join again and keep draft');
    expect(cloud.joinBoard).toHaveBeenCalledWith(board.invite_code);
    expect(new DeviceBoards().removal(board.invite_code)).toBeNull();
    expect(field(label).value).toBe('Unsaved work');
    expect(button(saveButton).disabled).toBe(false);
    expect(window.location.hash).toBe(`#board/${board.invite_code}`);
  });

  it('keeps a removed draft available offline, copies it and confirms explicit discard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount();
    await click('Settings');
    await fill('Board name', 'Recovery title');
    await fill('Description optional', 'Recovery details');
    await removeInAnotherTab();
    await act(async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    expect(button('Join again and keep draft').disabled).toBe(true);
    await click('Copy draft');
    expect(writeText).toHaveBeenCalledWith('Recovery title\nRecovery details');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Draft for recovery"]')?.value).toBe('Recovery title\nRecovery details');
    await click('Close dialog');
    expect(document.querySelector('dialog h2')?.textContent).toBe('Discard this draft?');
    expect(document.activeElement).toBe(button('Keep draft'));
    await click('Keep draft');
    expect(document.activeElement).toBe(field('Board name'));
    expect(field('Board name').value).toBe('Recovery title');
    await click('Discard draft');
    await click('Discard draft');
    expect(document.querySelector('dialog')).toBeNull();
    expect(new DeviceBoards().removal(board.invite_code)).not.toBeNull();
    expect(cloud.mutateBoard).not.toHaveBeenCalled();
  });

  it('keeps a recovery draft hidden if restoring the device preference fails', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Keep on storage failure');
    await removeInAnotherTab();
    cloud.joinBoard.mockResolvedValueOnce(board);
    const restore = vi.spyOn(DeviceBoards.prototype, 'restore').mockImplementationOnce(() => {
      throw new Error('Storage unavailable');
    });
    await click('Join again and keep draft');
    expect(restore).toHaveBeenCalled();
    expect(field('Board name').value).toBe('Keep on storage failure');
    expect(button('Save details').disabled).toBe(true);
    expect(new DeviceBoards().removal(board.invite_code)).not.toBeNull();
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(window.location.hash).toBe('');
    restore.mockRestore();
  });

  it('retains a recovery draft if joining fails or a newer removal arrives during recovery', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Keep through retries');
    await removeInAnotherTab();
    await click('Join again and keep draft');
    expect(field('Board name').value).toBe('Keep through retries');
    expect(new DeviceBoards().removal(board.invite_code)).not.toBeNull();
    const pending = deferred<Board>();
    cloud.joinBoard.mockReturnValueOnce(pending.promise);
    await click('Join again and keep draft');
    expect(button('Discard draft').disabled).toBe(true);
    expect(button('Close dialog').disabled).toBe(true);
    await act(async () => {
      new DeviceBoards().remove(board.invite_code);
      pending.resolve(board);
    });
    expect(field('Board name').value).toBe('Keep through retries');
    expect(new DeviceBoards().removal(board.invite_code)).not.toBeNull();
    expect(button('Save details').disabled).toBe(true);
  });

  it('keeps a newer removal when an older automatic join completes', async () => {
    const pending = deferred<Board>();
    cloud.joinBoard.mockReturnValueOnce(pending.promise);
    await mount([], board.invite_code);
    await act(async () => {
      new DeviceBoards().remove(board.invite_code);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DEVICE_BOARDS_PREFIX + board.invite_code,
        }),
      );
      pending.resolve(board);
    });
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('keeps a newer removal when an older explicit join completes', async () => {
    await mount([], '');
    await click('Join with a code');
    await fill('Invitation code or link', board.invite_code);
    const pending = deferred<Board>();
    cloud.joinBoard.mockReturnValueOnce(pending.promise);
    await click('Join board');
    await act(async () => {
      new DeviceBoards().remove(board.invite_code);
      pending.resolve(board);
    });
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(document.querySelector('dialog')?.textContent).toContain(
      'removed from this device while joining',
    );
    expect(new DeviceBoards().removal(board.invite_code)).not.toBeNull();
  });

  it('shares explicit invitation links and accepts them in the Join form', async () => {
    await mount();
    await click('Invite people');
    expect(field('Invitation link').value).toBe(
      `http://localhost/#join/${board.invite_code}`,
    );
    await click('Close dialog');
    await click('Workspace');
    await click('Join with a code');
    await fill(
      'Invitation code or link',
      `http://localhost/#/join/${board.invite_code.toUpperCase()}`,
    );
    cloud.joinBoard.mockResolvedValueOnce(board);
    await click('Join board');
    expect(cloud.joinBoard).toHaveBeenCalledWith(board.invite_code);
    expect(document.querySelector('h1')?.textContent).toBe(board.title);
  });

  it('opens a new invitation route as a prefilled form without joining automatically', async () => {
    await mount([], '');
    await act(async () => {
      window.history.replaceState(null, '', `/#join/${board.invite_code}`);
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(field('Invitation code or link').value).toBe(board.invite_code);
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    cloud.joinBoard.mockResolvedValueOnce(board);
    await click('Join board');
    expect(document.querySelector('h1')?.textContent).toBe(board.title);
  });

  it('prefills the new code when navigating between invitation routes with a dialog already open', async () => {
    const nextCode = 'b'.repeat(32);
    await mount([], '', false, `#join/${board.invite_code}`);
    await fill('Invitation code or link', 'Unsubmitted draft');
    await navigateHash(`#join/${nextCode}`);
    expect(field('Invitation code or link').value).toBe(nextCode);
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it('leaves a removed-board route when cancelling and opens confirmation again on Back', async () => {
    const device = new DeviceBoards();
    device.remove(board.invite_code);
    await mount();
    await click('Cancel');
    expect(window.location.hash).toBe('');
    expect(document.querySelector('dialog')).toBeNull();
    await navigateHash(`#board/${board.invite_code}`);
    expect(field('Invitation code or link').value).toBe(board.invite_code);
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    expect(device.removal(board.invite_code)).not.toBeNull();
  });

  it('retries a failed ordinary board link after leaving and returning through history', async () => {
    await mount([], board.invite_code);
    expect(cloud.joinBoard).toHaveBeenCalledTimes(1);
    await click('Cancel');
    cloud.joinBoard.mockResolvedValueOnce(board);
    await navigateHash(`#board/${board.invite_code}`);
    expect(cloud.joinBoard).toHaveBeenCalledTimes(2);
    expect(document.querySelector('h1')?.textContent).toBe(board.title);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('keeps the new invitation open when an older explicit join completes after navigation', async () => {
    const device = new DeviceBoards();
    device.remove(board.invite_code);
    await mount([], '', false, `#join/${board.invite_code}`);
    const pending = deferred<Board>();
    cloud.joinBoard.mockReturnValueOnce(pending.promise);
    await click('Join board');
    const nextCode = 'b'.repeat(32);
    await navigateHash(`#join/${nextCode}`);
    await act(async () => {
      pending.resolve(board);
    });
    expect(window.location.hash).toBe(`#join/${nextCode}`);
    expect(field('Invitation code or link').value).toBe(nextCode);
    expect(device.removal(board.invite_code)).not.toBeNull();
    expect(document.querySelector('.board-preview')).toBeNull();
  });

  it('does not close a new invitation when an older save completes after navigation', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Accepted on the server');
    const pending = deferred<Board>();
    cloud.mutateBoard.mockReturnValueOnce(pending.promise);
    await click('Save details');
    const nextCode = 'b'.repeat(32);
    await navigateHash(`#join/${nextCode}`);
    await act(async () => {
      pending.resolve({ ...board, title: 'Accepted on the server', revision: 2 });
    });
    expect(field('Invitation code or link').value).toBe(nextCode);
    expect(window.location.hash).toBe(`#join/${nextCode}`);
    expect(document.querySelector('dialog')).not.toBeNull();
  });

  it('updates another tab after a matching restoration acknowledgement', async () => {
    const device = new DeviceBoards();
    device.remove(board.invite_code);
    const marker = device.removal(board.invite_code);
    await mount([board], '');
    expect(document.querySelector('.board-preview')).toBeNull();
    await act(async () => {
      device.restore(board.invite_code, marker);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `${DEVICE_BOARDS_PREFIX}${board.invite_code}:restored:${marker}`,
          storageArea: window.localStorage,
        }),
      );
    });
    expect(document.querySelector('.board-preview')).not.toBeNull();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it('does not autojoin when removal preferences cannot be read and recovers on focus', async () => {
    new DeviceBoards().remove(board.invite_code);
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    await mount();
    expect(cloud.loadBoards).not.toHaveBeenCalled();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Could not read boards');
    read.mockRestore();
    await refresh();
    expect(field('Invitation code or link').value).toBe(board.invite_code);
    expect(document.querySelector('.board-preview')).toBeNull();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it('ignores unrelated and session-storage events and stops listening after unmount', async () => {
    const reads = vi.spyOn(DeviceBoards.prototype, 'removedCodes');
    await mount();
    const before = reads.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'iou-store' }));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DEVICE_BOARDS_PREFIX + board.invite_code,
          storageArea: window.sessionStorage,
        }),
      );
    });
    expect(reads).toHaveBeenCalledTimes(before);
    expect(cloud.loadBoards).toHaveBeenCalledTimes(1);
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(reads).toHaveBeenCalledTimes(before);
  });

  it('waits for the initial list in StrictMode before trying an existing invitation', async () => {
    const pending = deferred<Board[]>();
    cloud.loadBoards.mockReturnValueOnce(pending.promise);
    await mount([board], board.invite_code, true);
    expect(cloud.loadBoards).toHaveBeenCalledTimes(1);
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Finding your boards…');
    await act(async () => {
      pending.resolve([board]);
    });
    expect(document.querySelector('h1')?.textContent).toBe('Weekend plans');
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it('saves column order immediately while retaining board details and disabling boundary moves', async () => {
    await mount();
    await click('Settings');
    expect(button('Move To do earlier').disabled).toBe(true);
    expect(button('Move Done later').disabled).toBe(true);
    await fill('Board name', 'My draft name');
    const pending = deferred<Board>();
    cloud.mutateBoard.mockReturnValueOnce(pending.promise);
    await click('Move In progress earlier');
    expect(cloud.mutateBoard).toHaveBeenCalledWith(board.id, {
      type: 'reorder_columns',
      columnIds: ['doing', 'todo', 'done'],
    });
    expect(document.querySelector('.connection')?.textContent).toBe('Saving…');
    expect(button('Move Done earlier').matches(':disabled')).toBe(true);
    const saved = {
      ...board,
      revision: 2,
      columns: [board.columns[1]!, board.columns[0]!, board.columns[2]!],
    };
    await act(async () => {
      pending.resolve(saved);
    });
    expect(field('Board name').value).toBe('My draft name');
    expect(button('Move In progress earlier').disabled).toBe(true);
    cloud.mutateBoard.mockResolvedValueOnce({
      ...saved,
      title: 'My draft name',
      revision: 3,
    });
    await click('Save details');
    expect(cloud.mutateBoard).toHaveBeenLastCalledWith(board.id, {
      type: 'update_board',
      patch: { title: 'My draft name' },
    });
    expect(document.querySelector('dialog')).toBeNull();
    expect(columnTitles()).toEqual(['In progress', 'To do', 'Done']);
  });

  it('keeps a failed ordering save and its details available to retry', async () => {
    await mount();
    await click('Settings');
    await fill('Description optional', 'Keep this draft');
    cloud.mutateBoard.mockRejectedValueOnce(new Error('Connection lost'));
    await click('Move Done earlier');
    expect(field('Description optional').value).toBe('Keep this draft');
    expect(columnTitles()).toEqual(['To do', 'In progress', 'Done']);
    expect(document.querySelector('dialog')?.textContent).toContain(
      'Connection lost',
    );
    expect(button('Move Done earlier').disabled).toBe(false);
  });

  it('keeps newer saved revisions when an older refresh arrives afterwards', async () => {
    await mount();
    const pending = deferred<Board[]>();
    cloud.loadBoards.mockReturnValueOnce(pending.promise);
    await refresh();
    await click('Settings');
    await fill('Board name', 'Newer saved title');
    cloud.mutateBoard.mockResolvedValueOnce({
      ...board,
      title: 'Newer saved title',
      revision: 2,
    });
    await click('Save details');
    await act(async () => {
      pending.resolve([board]);
    });
    expect(document.querySelector('h1')?.textContent).toBe('Newer saved title');
  });

  it('updates live column order without replacing an unsaved details draft', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Still editing');
    cloud.loadBoards.mockResolvedValueOnce([
      { ...board, revision: 2, columns: [...board.columns].reverse() },
    ]);
    await refresh();
    expect(field('Board name').value).toBe('Still editing');
    expect(button('Move Done earlier').disabled).toBe(true);
    expect(button('Move To do later').disabled).toBe(true);
  });

  it('filters a person named all independently of Everyone and Unassigned', async () => {
    await mount([
      {
        ...board,
        cards: [
          { ...card, assignee: 'all' },
          {
            ...card,
            id: '11111111-1111-4111-8111-111111111112',
            title: 'Unassigned task',
            assignee: '',
          },
          {
            ...card,
            id: '11111111-1111-4111-8111-111111111113',
            title: 'Alex task',
          },
        ],
      },
    ]);
    const options = [
      ...document.querySelector<HTMLSelectElement>(
        'select[aria-label="Filter assignee"]',
      )!.options,
    ];
    await select(
      'Filter assignee',
      options.find((item) => item.text === 'all')!.value,
    );
    expect(document.querySelectorAll('article').length).toBe(1);
    expect(document.querySelector('article h3')?.textContent).toBe(
      'Buy coffee',
    );
    await select(
      'Filter assignee',
      options.find((item) => item.text === 'Unassigned')!.value,
    );
    expect(document.querySelector('article h3')?.textContent).toBe(
      'Unassigned task',
    );
    await click('Clear filters');
    expect(document.querySelectorAll('article').length).toBe(3);
  });

  it('sends only edited card fields after another member moves the card', async () => {
    await mount([{ ...board, cards: [card] }]);
    await click('Edit Buy coffee');
    await fill('Card title', 'Buy tea');
    const moved = {
      ...board,
      revision: 2,
      cards: [{ ...card, columnId: 'done', assignee: 'Sam' }],
    };
    cloud.loadBoards.mockResolvedValueOnce([moved]);
    await refresh();
    cloud.mutateBoard.mockResolvedValueOnce({
      ...moved,
      revision: 3,
      cards: [{ ...moved.cards[0]!, title: 'Buy tea' }],
    });
    await click('Save');
    expect(cloud.mutateBoard).toHaveBeenCalledWith(board.id, {
      type: 'update_card',
      id: card.id,
      patch: { title: 'Buy tea' },
    });
    expect(
      document.querySelector('section[aria-label="Done"] h3')?.textContent,
    ).toBe('Buy tea');
  });

  it('retains a new card draft and stable ID across a lost response and retry', async () => {
    await mount();
    await click(
      'Add a card',
      document.querySelector('section[aria-label="To do"]')!,
    );
    await fill('Card title', 'Buy coffee');
    cloud.mutateBoard.mockRejectedValueOnce(new Error('Response lost'));
    await click('Save');
    const first = cloud.mutateBoard.mock.calls[0]![1];
    expect(field('Card title').value).toBe('Buy coffee');
    cloud.mutateBoard.mockResolvedValueOnce({
      ...board,
      revision: 2,
      cards: [first.card],
    });
    await click('Save');
    expect(cloud.mutateBoard.mock.calls[1]![1]).toEqual(first);
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelectorAll('article').length).toBe(1);
  });

  it('drops boards absent from a complete refresh, retaining the list on failure', async () => {
    await mount([board], '');
    cloud.loadBoards.mockRejectedValueOnce(new Error('Connection lost'));
    await refresh();
    expect(document.querySelector('.board-preview')?.textContent).toContain(
      'Weekend plans',
    );
    cloud.loadBoards.mockResolvedValueOnce([]);
    await refresh();
    expect(document.querySelector('.board-preview')).toBeNull();
  });

  it('reuses a new board ID when its creation response is lost', async () => {
    await mount([], '');
    await click('Create a board');
    await fill('Board name', 'Weekend plans');
    cloud.createBoard.mockRejectedValueOnce(new Error('Response lost'));
    await click('Create board', document.querySelector('dialog')!);
    const first = cloud.createBoard.mock.calls[0]!;
    expect(field('Board name').value).toBe('Weekend plans');
    cloud.createBoard.mockResolvedValueOnce({ ...board, id: first[0] });
    await click('Create board', document.querySelector('dialog')!);
    expect(cloud.createBoard.mock.calls[1]).toEqual(first);
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('Weekend plans');
  });

  it('uses current column membership when offering removal and its destination', async () => {
    const single = { ...board, columns: [board.columns[0]!] };
    await mount([single]);
    await click('Settings for To do');
    expect(
      [...document.querySelectorAll('dialog button')].some(
        (item) => item.textContent?.trim() === 'Remove',
      ),
    ).toBe(false);
    cloud.loadBoards.mockResolvedValueOnce([{ ...board, revision: 2 }]);
    await refresh();
    await click('Remove');
    expect(button('Confirm removal').disabled).toBe(false);
    cloud.loadBoards.mockResolvedValueOnce([{ ...single, revision: 3 }]);
    await refresh();
    expect(button('Confirm removal').disabled).toBe(true);
    expect(cloud.mutateBoard).not.toHaveBeenCalled();
    expect(field('Column name').value).toBe('To do');
  });

  it('retains a board created while an older empty list is in flight', async () => {
    await mount([], '');
    const pending = deferred<Board[]>();
    cloud.loadBoards.mockReturnValueOnce(pending.promise);
    await refresh();
    await click('Create a board');
    await fill('Board name', 'Weekend plans');
    cloud.createBoard.mockResolvedValueOnce(board);
    await click('Create board', document.querySelector('dialog')!);
    await act(async () => {
      pending.resolve([]);
    });
    expect(document.querySelector('h1')?.textContent).toBe('Weekend plans');
    expect(cloud.joinBoard).not.toHaveBeenCalled();
  });

  it('retries an invitation automatically after reconnecting', async () => {
    cloud.joinBoard.mockRejectedValueOnce(new Error('Connection lost'));
    await mount([], board.invite_code);
    expect(cloud.joinBoard).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    cloud.joinBoard.mockResolvedValueOnce(board);
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(cloud.joinBoard).toHaveBeenCalledTimes(2);
    expect(document.querySelector('h1')?.textContent).toBe('Weekend plans');
  });

  it('keeps an offline editor draft and allows saving after reconnecting', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Keep this title');
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(button('Save details').disabled).toBe(true);
    expect(field('Board name').value).toBe('Keep this title');
    expect(cloud.mutateBoard).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    cloud.mutateBoard.mockResolvedValueOnce({
      ...board,
      revision: 2,
      title: 'Keep this title',
    });
    await click('Save details');
    expect(document.querySelector('h1')?.textContent).toBe('Keep this title');
  });

  it('keeps clicks inside dialog padding from discarding an unsaved draft', async () => {
    await mount();
    await click('Settings');
    await fill('Board name', 'Still editing');
    const dialog = document.querySelector('dialog')!;
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 10,
      right: 410,
      bottom: 410,
    } as DOMRect);
    await act(async () => {
      dialog.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });
    expect(field('Board name').value).toBe('Still editing');
    await act(async () => {
      dialog.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 20 }),
      );
    });
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('does not attempt invitation access when sharing has no configuration', async () => {
    cloud.configured = false;
    await mount([], board.invite_code);
    expect(cloud.loadBoards).not.toHaveBeenCalled();
    expect(cloud.joinBoard).not.toHaveBeenCalled();
    expect(document.querySelector('.connection')?.textContent).toBe(
      'Setup needed',
    );
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('stops polling and focus refreshes after unmounting', async () => {
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(cloud.loadBoards).toHaveBeenCalledTimes(2);
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await refresh();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(cloud.loadBoards).toHaveBeenCalledTimes(2);
  });
});
