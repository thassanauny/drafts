import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board, Card, Column, Operation } from './types';
import { acceptBoard, nextPosition } from './lib/board';
import { cloudConfigured, joinBoard, loadBoards, mutateBoard } from './lib/cloud';
import { DeviceBoards, DEVICE_BOARDS_PREFIX } from './lib/deviceBoards';
import { message, routeCode, routeInvitation, type ModalState } from './workspace';
export function useWorkspace() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedCode, setSelectedCode] = useState(routeCode);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastSync, setLastSync] = useState<Date>();
  const [modal, setModal] = useState<ModalState | undefined>(() => {
    const code = routeInvitation();
    return code ? { type: 'join', code } : undefined;
  });
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [deviceBoards] = useState(() => new DeviceBoards());
  const [removedCodes, setRemovedCodes] = useState(new Set<string>());
  const [removalsReady, setRemovalsReady] = useState(false);
  const removalsRef = useRef(removedCodes);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [assignee, setAssignee] = useState('');
  const [dragColumn, setDragColumn] = useState('');
  const [joinRetry, setJoinRetry] = useState(0);
  const refreshingRef = useRef(false);
  const busyRef = useRef(false);
  const failedLink = useRef('');
  const navigationVersion = useRef(0);
  const writeVersion = useRef(0);
  const boardWrites = useRef(new Map<string, number>());
  const visibleBoards = boards.filter(
    (item) => !removedCodes.has(item.invite_code),
  );
  const board = visibleBoards.find((item) => item.invite_code === selectedCode);
  const syncRemovals = useCallback(() => {
    let latest: Set<string>;
    try {
      latest = deviceBoards.removedCodes();
      setRemovalsReady(true);
    } catch (failure) {
      setRemovalsReady(false);
      throw failure;
    }
    removalsRef.current = latest;
    setRemovedCodes((current) =>
      current.size === latest.size &&
      [...current].every((code) => latest.has(code))
        ? current
        : latest,
    );
    return latest;
  }, [deviceBoards]);
  const upsert = useCallback(
    (incoming: Board) => {
      if (deviceBoards.removal(incoming.invite_code) !== null) return false;
      boardWrites.current.set(incoming.id, ++writeVersion.current);
      setBoards((current) => {
        const found = current.find((item) => item.id === incoming.id);
        return found
          ? current.map((item) =>
              item.id === incoming.id ? acceptBoard(item, incoming) : item,
            )
          : [...current, incoming];
      });
      return true;
    },
    [deviceBoards],
  );
  const refresh = useCallback(
    async (manual = false) => {
      try {
        syncRemovals();
      } catch (failure) {
        setError(message(failure));
        setLoaded(true);
        return;
      }
      if (!cloudConfigured || !navigator.onLine) {
        setLoaded(true);
        return;
      }
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      const refreshVersion = writeVersion.current;
      setRefreshing(true);
      try {
        const incoming = await loadBoards();
        const removed = syncRemovals();
        setBoards((current) => {
          const existing = new Map(current.map((item) => [item.id, item]));
          const merged = new Map(
            incoming
              .filter((item) => !removed.has(item.invite_code))
              .map((item) => [
                item.id,
                acceptBoard(existing.get(item.id), item),
              ]),
          );
          // A complete list removes inaccessible boards, while overlapping saves/joins stay visible.
          current.forEach((item) => {
            if (
              !merged.has(item.id) &&
              !removed.has(item.invite_code) &&
              (boardWrites.current.get(item.id) ?? 0) > refreshVersion
            ) {
              merged.set(item.id, item);
            }
          });
          return [...merged.values()];
        });
        setLastSync(new Date());
        if (manual) {
          setError('');
          setNotice('Boards are up to date');
        }
      } catch (failure) {
        setError(message(failure));
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
        setLoaded(true);
      }
    },
    [syncRemovals],
  );
  useEffect(() => {
    void refresh();
    const tick = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    const focus = () => void refresh();
    const online = () => {
      setOffline(false);
      failedLink.current = '';
      setJoinRetry((value) => value + 1);
      void refresh(true);
    };
    const disconnected = () => setOffline(true);
    const hash = () => {
      navigationVersion.current += 1;
      failedLink.current = '';
      setSelectedCode(routeCode());
      const code = routeInvitation();
      setModal(code ? { type: 'join', code } : undefined);
      setQuery('');
      setPriority('all');
      setAssignee('');
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(DEVICE_BOARDS_PREFIX))
        return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage)
          return;
        const removed = syncRemovals();
        setBoards((current) =>
          current.filter((item) => !removed.has(item.invite_code)),
        );
        if (removed.has(routeCode())) {
          navigationVersion.current += 1;
          failedLink.current = '';
          window.history.replaceState(
            null,
            '',
            `${window.location.pathname}${window.location.search}#`,
          );
          setSelectedCode('');
          // Keep the editor mounted: its draft is memory-only and must survive
          // another tab hiding this board. It can be copied or explicitly rejoined.
          setNotice('Board removed from this device. Any open draft is kept.');
        }
        void refresh();
      } catch (failure) {
        setError(message(failure));
      }
    };
    window.addEventListener('focus', focus);
    window.addEventListener('online', online);
    window.addEventListener('offline', disconnected);
    window.addEventListener('hashchange', hash);
    window.addEventListener('storage', storage);
    return () => {
      clearInterval(tick);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', disconnected);
      window.removeEventListener('hashchange', hash);
      window.removeEventListener('storage', storage);
    };
  }, [refresh, syncRemovals]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (
      !cloudConfigured ||
      !loaded ||
      !removalsReady ||
      !selectedCode ||
      board ||
      offline ||
      failedLink.current === selectedCode
    )
      return;
    if (removalsRef.current.has(selectedCode)) {
      failedLink.current = selectedCode;
      setModal({ type: 'join', code: selectedCode });
      return;
    }
    let active = true;
    joinBoard(selectedCode)
      .then((incoming) => {
        if (active) {
          upsert(incoming);
          setError('');
        }
      })
      .catch((failure) => {
        if (active) {
          failedLink.current = selectedCode;
          setError(message(failure));
          setModal({ type: 'join', code: selectedCode });
        }
      });
    return () => {
      active = false;
    };
  }, [selectedCode, board, loaded, removalsReady, offline, upsert, joinRetry]);
  function navigate(incoming?: Board) {
    navigationVersion.current += 1;
    failedLink.current = '';
    window.location.hash = incoming ? `board/${incoming.invite_code}` : '';
    setSelectedCode(incoming?.invite_code ?? '');
    setQuery('');
    setPriority('all');
    setAssignee('');
  }
  function closeModal(expected: ModalState) {
    if (modalRef.current !== expected) return;
    setModal(undefined);
    if (expected.type === 'join' && (routeInvitation() || routeCode()))
      navigate();
  }
  async function action(
    work: () => Promise<Board>,
    success: string,
    open = false,
    restore?: { code: string; marker: string | null },
  ) {
    if (busyRef.current) return false;
    if (!navigator.onLine) {
      setError('Reconnect to save changes.');
      return false;
    }
    busyRef.current = true;
    const startedNavigation = navigationVersion.current;
    setBusy(true);
    setError('');
    try {
      const saved = await work();
      if (restore) {
        if (startedNavigation !== navigationVersion.current) return false;
        if (!deviceBoards.restore(restore.code, restore.marker)) {
          syncRemovals();
          throw new Error(
            'This board was removed from this device while joining. Join again to restore it.',
          );
        }
        syncRemovals();
      }
      if (!upsert(saved)) return false;
      if (startedNavigation !== navigationVersion.current) return false;
      setLastSync(new Date());
      setNotice(success);
      if (open) {
        modalRef.current = undefined;
        setModal(undefined);
        navigate(saved);
      }
      return true;
    } catch (failure) {
      if (startedNavigation === navigationVersion.current)
        setError(message(failure));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function join(code: string) {
    const marker = deviceBoards.removal(code);
    return action(() => joinBoard(code), 'Welcome to the board', true, {
      code,
      marker,
    });
  }
  async function recoverDraft(code: string) {
    const marker = deviceBoards.removal(code);
    const restored = await action(() => joinBoard(code), 'Board rejoined. Your draft is kept.', false, { code, marker });
    if (restored) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#board/${code}`);
      setSelectedCode(code);
    }
    return restored;
  }
  function removeDeviceBoard(item: Board) {
    if (busyRef.current) return;
    deviceBoards.remove(item.invite_code);
    removalsRef.current = new Set([...removalsRef.current, item.invite_code]);
    setRemovedCodes(removalsRef.current);
    setBoards((current) => current.filter((value) => value.id !== item.id));
    setModal(undefined);
    setError('');
    navigate();
    setNotice('Board removed from this device');
  }
  const save = (id: string, operation: Operation) =>
    action(() => mutateBoard(id, operation), 'Saved to your board');
  const disabled = busy || offline || !cloudConfigured;
  const refreshDisabled = disabled || refreshing || !loaded;
  function addCard(column: Column) {
    if (!board) return;
    setModal({
      type: 'card',
      board,
      isNew: true,
      card: {
        id: crypto.randomUUID(),
        title: '',
        description: '',
        columnId: column.id,
        position: nextPosition(board, column.id),
        priority: 'medium',
        assignee: '',
        dueDate: '',
        labels: [],
      },
    });
  }
  function moveCard(card: Card, columnId: string) {
    if (!board || card.columnId === columnId || disabled) return;
    void save(board.id, {
      type: 'move_card',
      id: card.id,
      columnId,
      position: nextPosition(board, columnId),
    });
  }
  const matches = (card: Card) =>
    (priority === 'all' || card.priority === priority) &&
    (!assignee || card.assignee === assignee.slice('name:'.length)) &&
    `${card.title} ${card.description} ${card.assignee} ${card.labels.join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const filteredCount = board?.cards.filter(matches).length ?? 0;
  const boardList = [...visibleBoards].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  const workspaceCardCount = boardList.reduce(
    (total, item) => total + item.cards.length,
    0,
  );
  return {
    boards,
    selectedCode,
    loaded,
    refreshing,
    busy,
    offline,
    error,
    notice,
    lastSync,
    modal,
    setModal,
    removedCodes,
    removalsReady,
    query,
    setQuery,
    priority,
    setPriority,
    assignee,
    setAssignee,
    dragColumn,
    setDragColumn,
    failedLink,
    setJoinRetry,
    visibleBoards,
    board,
    refresh,
    navigate,
    closeModal,
    action,
    join,
    recoverDraft,
    removeDeviceBoard,
    save,
    disabled,
    refreshDisabled,
    addCard,
    moveCard,
    matches,
    filteredCount,
    boardList,
    workspaceCardCount,
    setError,
    setNotice,
  };
}
