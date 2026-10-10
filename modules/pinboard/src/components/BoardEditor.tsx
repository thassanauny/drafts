import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, Copy, Link, LogOut, LoaderCircle, Trash2 } from 'lucide-react';
import type { Board, Card, ColumnColor, Operation } from '../types';
import { cardPatch, nextPosition, readInviteCode } from '../lib/board';
import { colors, message, type ModalState } from '../workspace';
import { Dialog } from './Dialog';
export function BoardEditor({
  modal,
  busy,
  offline,
  removed,
  serverError,
  currentBoard,
  onClose: closeModal,
  onSave,
  onCreate,
  onJoin,
  onRecover,
  onRemove,
  onNotice,
}: {
  modal: ModalState;
  busy: boolean;
  offline: boolean;
  removed: boolean;
  serverError: string;
  currentBoard?: Board;
  onClose: () => void;
  onSave: (boardId: string, operation: Operation) => Promise<boolean>;
  onCreate: (
    id: string,
    title: string,
    description: string,
  ) => Promise<boolean>;
  onJoin: (code: string) => Promise<boolean>;
  onRecover: (code: string) => Promise<boolean>;
  onRemove: (board: Board) => void;
  onNotice: (text: string) => void;
}) {
  const [title, setTitle] = useState(
    'board' in modal
      ? modal.type === 'card'
        ? modal.card.title
        : modal.type === 'column'
          ? modal.column.title
          : modal.board.title
      : '',
  );
  const [description, setDescription] = useState(
    'board' in modal
      ? modal.type === 'card'
        ? modal.card.description
        : modal.board.description
      : '',
  );
  const [code, setCode] = useState(
    modal.type === 'join' ? (modal.code ?? '') : '',
  );
  const [card, setCard] = useState<Card | undefined>(
    modal.type === 'card' ? modal.card : undefined,
  );
  const [color, setColor] = useState<ColumnColor>(
    modal.type === 'column' ? modal.column.color : 'blue',
  );
  const [target, setTarget] = useState(
    modal.type === 'column'
      ? (modal.board.columns.find((column) => column.id !== modal.column.id)
          ?.id ?? '')
      : '',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [localError, setLocalError] = useState('');
  const [copied, setCopied] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const columnOrderTitleId = useId();
  const [createId] = useState(() => crypto.randomUUID());
  const locked = busy || offline || removed;
  const hasDraft =
    modal.type === 'board' || modal.type === 'card' || modal.type === 'column';
  const onClose = () => {
    if (removed && hasDraft) setConfirmDiscard(true);
    else closeModal();
  };
  const liveBoard =
    currentBoard ?? ('board' in modal ? modal.board : undefined);
  const currentColumns = liveBoard?.columns ?? [];
  useEffect(() => {
    if (
      modal.type === 'column' &&
      !currentColumns.some(
        (column) => column.id === target && column.id !== modal.column.id,
      )
    ) {
      setTarget(
        currentColumns.find((column) => column.id !== modal.column.id)?.id ??
          '',
      );
    }
  }, [modal, currentColumns, target]);
  async function reorderColumn(id: string, direction: -1 | 1) {
    if (locked || modal.type !== 'board' || !liveBoard) return;
    const index = currentColumns.findIndex((column) => column.id === id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= currentColumns.length)
      return;
    const columnIds = currentColumns.map((column) => column.id);
    [columnIds[index], columnIds[destination]] = [
      columnIds[destination]!,
      columnIds[index]!,
    ];
    setLocalError('');
    try {
      await onSave(liveBoard.id, { type: 'reorder_columns', columnIds });
    } catch (error) {
      setLocalError(message(error));
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError('');
    if (locked) return;
    try {
      let saved = false;
      if (modal.type === 'create')
        saved = await onCreate(createId, title.trim(), description.trim());
      if (modal.type === 'join') {
        saved = await onJoin(readInviteCode(code));
      }
      if (modal.type === 'board') {
        const patch: { title?: string; description?: string } = {};
        if (title.trim() !== modal.board.title) patch.title = title.trim();
        if (description.trim() !== modal.board.description)
          patch.description = description.trim();
        saved =
          Object.keys(patch).length === 0 ||
          (await onSave(modal.board.id, { type: 'update_board', patch }));
      }
      if (modal.type === 'column') {
        const column = { ...modal.column, title: title.trim(), color };
        const patch: { title?: string; color?: ColumnColor } = {};
        if (column.title !== modal.column.title) patch.title = column.title;
        if (column.color !== modal.column.color) patch.color = column.color;
        saved = modal.isNew
          ? await onSave(modal.board.id, { type: 'add_column', column })
          : Object.keys(patch).length === 0 ||
            (await onSave(modal.board.id, {
              type: 'update_column',
              id: column.id,
              patch,
            }));
      }
      if (modal.type === 'card' && card) {
        const edited = {
          ...card,
          title: title.trim(),
          description: description.trim(),
          assignee: card.assignee.trim(),
          labels: [
            ...new Set(
              card.labels.map((label) => label.trim()).filter(Boolean),
            ),
          ],
        };
        const patch = cardPatch(modal.card, edited);
        saved = modal.isNew
          ? await onSave(modal.board.id, { type: 'create_card', card: edited })
          : Object.keys(patch).length === 0 ||
            (await onSave(modal.board.id, {
              type: 'update_card',
              id: card.id,
              patch,
            }));
      }
      if (saved) onClose();
    } catch (error) {
      setLocalError(message(error));
    }
  }
  async function remove() {
    if (locked) return;
    if (
      modal.type === 'card' &&
      (await onSave(modal.board.id, { type: 'delete_card', id: modal.card.id }))
    )
      onClose();
    if (
      modal.type === 'column' &&
      (await onSave(modal.board.id, {
        type: 'delete_column',
        id: modal.column.id,
        targetColumnId: target,
      }))
    )
      onClose();
  }
  async function copy(value: string, kind: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      onNotice(`${kind} copied`);
    } catch {
      setLocalError(
        'Could not copy automatically. Select the text below and copy it.',
      );
    }
  }
  const draftText = [
    title,
    ...(modal.type === 'column' ? [`Color: ${color}`] : [description]),
    ...(modal.type === 'card' && card
      ? [
          `Column: ${currentColumns.find((column) => column.id === card.columnId)?.title ?? card.columnId}`,
          `Priority: ${card.priority}`,
          `Assignee: ${card.assignee}`,
          `Due date: ${card.dueDate}`,
          `Labels: ${card.labels.join(', ')}`,
        ]
      : []),
  ].join('\n');
  if (confirmDiscard)
    return (
      <Dialog
        title="Discard this draft?"
        busy={busy}
        onClose={() => setConfirmDiscard(false)}
      >
        <p className="dialog-intro">
          This draft is kept only in this open page. Copy it or join the board
          again before discarding it.
        </p>
        <div className="dialog-actions">
          <button
            className="button quiet"
            disabled={busy}
            onClick={() => setConfirmDiscard(false)}
          >
            Keep draft
          </button>
          <button className="button danger" disabled={busy} onClick={closeModal}>
            Discard draft
          </button>
        </div>
      </Dialog>
    );
  if (modal.type === 'help')
    return (
      <Dialog title="A place for your projects." busy={busy} onClose={onClose}>
        <div className="help-content">
          <p>
            Create a board for your project. Work on your own, or use
            <strong> Invite people</strong> to share its code. Anyone with the
            code can join and edit.
          </p>
          <p>
            Add cards and drag them between columns. On a phone or with a
            keyboard, use the menu at the bottom of a card to move it. Change
            column order in Board settings; the arrows save each move.
          </p>
          <p>
            Boards sync every five seconds. When two people edit the same field,
            the last change accepted by the server wins. Separate changes are
            kept.
          </p>
          <p>
            You need a connection to save. Keep your invite codes: you can
            rejoin if you clear browser data or switch devices.
          </p>
          <p>
            Use Board settings to remove a board from this device. Everyone else
            keeps access. Join again with its code whenever you need it.
          </p>
        </div>
        <div className="dialog-actions">
          <button className="button primary" onClick={onClose}>
            Got it <Check size={16} />
          </button>
        </div>
      </Dialog>
    );
  if (modal.type === 'share') {
    const url = `${window.location.href.split('#')[0]}#join/${modal.board.invite_code}`;
    return (
      <Dialog title="Invite a few people." busy={busy} onClose={onClose}>
        <p className="dialog-intro">
          Invite people to <strong>{modal.board.title}</strong>. Anyone with
          this code can view and edit the board.
        </p>
        <label className="field">
          Invitation code
          <div className="copy-field">
            <input
              readOnly
              value={modal.board.invite_code}
              onFocus={(event) => event.target.select()}
            />
            <button
              className="icon-button"
              onClick={() => void copy(modal.board.invite_code, 'Code')}
              aria-label="Copy invitation code"
            >
              {copied === 'Code' ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
        </label>
        <label className="field">
          Invitation link
          <input
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
        </label>
        {localError && (
          <p className="form-error" role="alert">
            {localError}
          </p>
        )}
        <div className="invite-note">
          <Link size={16} />
          <span>Save the code to find your board again on any device.</span>
        </div>
        <div className="dialog-actions">
          <button
            className="button primary"
            onClick={() => void copy(url, 'Link')}
          >
            <Copy size={16} />
            Copy invite link
          </button>
        </div>
      </Dialog>
    );
  }
  if (modal.type === 'board' && confirmRemove) {
    return (
      <Dialog title="Remove from this device?" busy={busy} onClose={onClose}>
        <p className="dialog-intro">
          Remove <strong>{modal.board.title}</strong> from your lists on this
          device. Everyone else keeps access, and the shared board stays intact.
        </p>
        <p className="dialog-intro">
          Keep the invitation code to join again. Unsaved details in this dialog
          will be discarded.
        </p>
        <label className="field">
          Invitation code
          <div className="copy-field">
            <input
              readOnly
              value={modal.board.invite_code}
              onFocus={(event) => event.target.select()}
            />
            <button
              className="icon-button"
              onClick={() => void copy(modal.board.invite_code, 'Code')}
              aria-label="Copy invitation code"
            >
              {copied === 'Code' ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
        </label>
        {localError && (
          <p className="form-error" role="alert">
            {localError}
          </p>
        )}
        <div className="dialog-actions">
          <button
            autoFocus
            className="button quiet"
            disabled={busy}
            onClick={() => {
              setConfirmRemove(false);
              setLocalError('');
            }}
          >
            Keep on this device
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              try {
                onRemove(modal.board);
              } catch (failure) {
                setLocalError(message(failure));
              }
            }}
          >
            <LogOut size={16} />
            Remove from this device
          </button>
        </div>
      </Dialog>
    );
  }
  const heading =
    modal.type === 'create'
      ? 'Start a project.'
      : modal.type === 'join'
        ? 'Join a board.'
        : modal.type === 'board'
          ? 'Board settings'
          : modal.type === 'card'
            ? modal.isNew
              ? 'A new thing to do.'
              : 'Card details'
            : modal.isNew
              ? 'Make a little more room.'
              : 'Column settings';
  return (
    <Dialog
      title={heading}
      busy={busy}
      onClose={onClose}
      wide={modal.type === 'card'}
    >
      <form onSubmit={(event) => void submit(event)}>
        {removed && hasDraft && 'board' in modal && (
          <section className="draft-recovery" aria-label="Draft recovery">
            <p role="alert">
              This board was removed from this device in another tab. Your draft
              stays here. Join again to save it, copy it, or discard it.
            </p>
            <div className="recovery-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy || offline}
                onClick={() => {
                  setLocalError('');
                  void onRecover(modal.board.invite_code).catch((failure) =>
                    setLocalError(message(failure)),
                  );
                }}
              >
                Join again and keep draft
              </button>
              <button
                className="button quiet"
                type="button"
                onClick={() => void copy(draftText, 'Draft')}
              >
                <Copy size={16} />
                Copy draft
              </button>
              <button
                className="button quiet"
                type="button"
                disabled={busy}
                onClick={() => setConfirmDiscard(true)}
              >
                Discard draft
              </button>
            </div>
            <details>
              <summary>View and copy draft</summary>
              <textarea
                aria-label="Draft for recovery"
                readOnly
                rows={6}
                value={draftText}
                onFocus={(event) => event.target.select()}
              />
            </details>
          </section>
        )}
        <fieldset className="editor-fields" disabled={busy}>
          {modal.type === 'join' ? (
            <>
              <p className="dialog-intro">
                Paste the invitation code or link you received. No account
                needed.
              </p>
              <label className="field">
                Invitation code or link
                <input
                  autoFocus
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Paste your invitation here"
                  autoComplete="off"
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                {modal.type === 'card'
                  ? 'Card title'
                  : modal.type === 'column'
                    ? 'Column name'
                    : 'Board name'}
                <input
                  autoFocus
                  required
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={
                    modal.type === 'create'
                      ? 'e.g. A very good week'
                      : modal.type === 'card'
                        ? 'What needs doing?'
                        : 'Give it a name'
                  }
                />
              </label>
              {modal.type !== 'column' && (
                <label className="field">
                  Description <span className="optional">optional</span>
                  <textarea
                    maxLength={10000}
                    rows={modal.type === 'card' ? 4 : 3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="A few details go a long way…"
                  />
                </label>
              )}
            </>
          )}
          {modal.type === 'create' && (
            <p className="soft-note">
              Your board starts with To do, In progress, and Done. Make it your
              own.
            </p>
          )}
          {modal.type === 'board' && (
            <section
              className="column-order-settings"
              aria-labelledby={columnOrderTitleId}
            >
              <h3 id={columnOrderTitleId}>Column order</h3>
              <p>Left to right on your board. Changes save immediately.</p>
              <ol className="column-order-list">
                {currentColumns.map((column, index) => (
                  <li key={column.id} className={`color-${column.color}`}>
                    <span className="column-order-number">{index + 1}</span>
                    <span className="column-dot" />
                    <span className="column-order-name">{column.title}</span>
                    <div className="column-order-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Move ${column.title} earlier`}
                        title="Move earlier"
                        disabled={locked || index === 0}
                        onClick={() => void reorderColumn(column.id, -1)}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Move ${column.title} later`}
                        title="Move later"
                        disabled={locked || index === currentColumns.length - 1}
                        onClick={() => void reorderColumn(column.id, 1)}
                      >
                        <ArrowDown size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {modal.type === 'board' && (
            <section className="device-board-actions">
              <h3>On this device</h3>
              <p>
                Remove this board from your lists on this device. Everyone else
                keeps access.
              </p>
              <button
                className="button secondary"
                type="button"
                disabled={busy || removed}
                onClick={() => {
                  setLocalError('');
                  setConfirmRemove(true);
                }}
              >
                <LogOut size={16} />
                Remove from this device
              </button>
            </section>
          )}
          {modal.type === 'column' && (
            <>
              <label className="field">Column color</label>
              <div className="color-picker">
                {colors.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`color-choice color-${value} ${color === value ? 'selected' : ''}`}
                    aria-label={value}
                    aria-pressed={color === value}
                    onClick={() => setColor(value)}
                  >
                    {color === value && <Check size={17} />}
                  </button>
                ))}
              </div>
            </>
          )}
          {modal.type === 'card' && card && (
            <>
              <div className="form-grid">
                <label className="field">
                  Column
                  <select
                    value={card.columnId}
                    onChange={(event) =>
                      setCard({
                        ...card,
                        columnId: event.target.value,
                        position: nextPosition(
                          liveBoard ?? modal.board,
                          event.target.value,
                        ),
                      })
                    }
                  >
                    {!currentColumns.some(
                      (column) => column.id === card.columnId,
                    ) && (
                      <option value={card.columnId} disabled>
                        Column removed — choose another
                      </option>
                    )}
                    {currentColumns.map((column) => (
                      <option value={column.id} key={column.id}>
                        {column.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Priority
                  <select
                    value={card.priority}
                    onChange={(event) =>
                      setCard({
                        ...card,
                        priority: event.target.value as Card['priority'],
                      })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label className="field">
                  Assignee <span className="optional">optional</span>
                  <input
                    value={card.assignee}
                    maxLength={80}
                    placeholder="A name"
                    onChange={(event) =>
                      setCard({ ...card, assignee: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Due date <span className="optional">optional</span>
                  <input
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={card.dueDate}
                    onInput={(event) =>
                      setCard({ ...card, dueDate: event.currentTarget.value })
                    }
                    onChange={(event) =>
                      setCard({ ...card, dueDate: event.target.value })
                    }
                  />
                </label>
              </div>
              <label className="field">
                Labels{' '}
                <span className="optional">optional · separated by commas</span>
                <input
                  value={card.labels.join(',')}
                  onChange={(event) =>
                    setCard({ ...card, labels: event.target.value.split(',') })
                  }
                  placeholder="Design, personal, this week"
                />
              </label>
            </>
          )}
          {confirmDelete && (
            <div className="delete-confirm">
              <p>
                {modal.type === 'column'
                  ? 'Remove this column? Its cards will move to the column below.'
                  : 'Delete this card? This cannot be undone.'}
              </p>
              {modal.type === 'column' && (
                <label className="field">
                  Move cards to
                  <select
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    {currentColumns
                      .filter((column) => column.id !== modal.column.id)
                      .map((column) => (
                        <option key={column.id} value={column.id}>
                          {column.title}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <button
                className="button danger"
                type="button"
                disabled={locked || (modal.type === 'column' && !target)}
                onClick={() => void remove()}
              >
                Confirm {modal.type === 'column' ? 'removal' : 'delete'}
              </button>
              <button
                className="button quiet"
                type="button"
                onClick={() => setConfirmDelete(false)}
              >
                Keep it
              </button>
            </div>
          )}
        </fieldset>
        {localError && (
          <p className="form-error" role="alert">
            {localError}
          </p>
        )}
        {serverError && (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        )}
        {offline && (
          <p className="form-error" role="alert">
            Reconnect to save. Your draft stays here while this page is open.
          </p>
        )}
        <div className="dialog-actions">
          {((modal.type === 'card' && !modal.isNew) ||
            (modal.type === 'column' &&
              !modal.isNew &&
              currentColumns.length > 1)) && (
            <button
              className="button delete-button"
              type="button"
              disabled={locked}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} />
              {modal.type === 'column' ? 'Remove' : 'Delete'}
            </button>
          )}
          <button
            className="button quiet"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            {modal.type === 'board' ? 'Close' : 'Cancel'}
          </button>
          <button className="button primary" type="submit" disabled={locked}>
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : modal.type === 'join' ? (
              <ArrowRight size={17} />
            ) : (
              <Check size={17} />
            )}
            {busy
              ? 'Saving…'
              : modal.type === 'create'
                ? 'Create board'
                : modal.type === 'join'
                  ? 'Join board'
                  : modal.type === 'board'
                    ? 'Save details'
                    : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
