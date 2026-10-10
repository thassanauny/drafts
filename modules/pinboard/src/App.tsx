import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Columns3,
  LayoutDashboard,
  Link,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { sortedCards } from './lib/board';
import { cloudConfigured, createBoard } from './lib/cloud';
import { CardTile } from './components/CardTile';
import { BoardEditor } from './components/BoardEditor';
import { useWorkspace } from './useWorkspace';
import { version } from '../package.json';
export default function App() {
  const {
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
  } = useWorkspace();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate()}>
          <span className="brand-mark">
            <Columns3 size={23} strokeWidth={2.5} />
          </span>
          <span>
            pinboard<span className="brand-dot">.</span>
          </span>
        </button>
        <p className="brand-subtitle">A place for your projects.</p>
        <button
          className={`nav-home ${!selectedCode ? 'active' : ''}`}
          aria-current={!selectedCode ? 'page' : undefined}
          onClick={() => navigate()}
        >
          <LayoutDashboard size={18} />
          Workspace
        </button>
        <div className="sidebar-section">
          <span>YOUR BOARDS</span>
          <button
            className="icon-button"
            title="Create board"
            aria-label="Create board"
            onClick={() => setModal({ type: 'create' })}
            disabled={disabled}
          >
            <Plus size={17} />
          </button>
        </div>
        <nav className="board-nav" aria-label="Boards">
          {boardList.map((item) => (
            <button
              key={item.id}
              className={`board-nav-item ${item.id === board?.id ? 'active' : ''}`}
              onClick={() => navigate(item)}
            >
              <span className="board-nav-dot" />
              <span>{item.title}</span>
              <span className="board-nav-count">{item.cards.length}</span>
            </button>
          ))}
          {loaded && visibleBoards.length === 0 && (
            <p className="sidebar-empty">
              Your next project
              <br />
              starts with a board.
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="together-note">
            <Users size={21} />
            <strong>Made for small projects.</strong>
            <p>
              Keep track on your own,
              <br />
              with a partner, or with a few people.
            </p>
          </div>
          <button
            className="button join-button"
            onClick={() => setModal({ type: 'join' })}
            disabled={disabled}
          >
            <Link size={16} />
            Join with a code
          </button>
          <div className="sidebar-footer">
            <span title={lastSync ? `Last synced ${lastSync.toLocaleString()}` : undefined}>
              {!cloudConfigured
                ? 'Setup needed'
                : offline || error
                  ? 'Sync paused'
                  : lastSync
                    ? `Synced ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : 'Connecting…'}
            </span>
            <span>v{version}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            {board ? (
              <>
                <span>Workspace</span>
                <ChevronRight size={14} />
                <strong>{board.title}</strong>
              </>
            ) : (
              <strong>Workspace</strong>
            )}
          </div>
          <div className="topbar-actions">
            <span className={`connection ${offline || error ? 'offline' : ''}`}>
              <span />
              {offline
                ? 'Offline'
                : !cloudConfigured
                  ? 'Setup needed'
                  : busy
                    ? 'Saving…'
                    : refreshing
                      ? 'Syncing'
                      : error
                        ? 'Sync unavailable'
                        : lastSync
                          ? 'All changes saved'
                          : 'Connecting'}
            </span>
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setModal({ type: 'help' })}
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        {!cloudConfigured && (
          <div className="banner warning">
            <Settings2 size={18} />
            <span>
              Add the public Supabase settings to enable shared boards. See the
              app’s setup guide.
            </span>
          </div>
        )}
        {offline && (
          <div className="banner warning">
            <WifiOff size={18} />
            <span>
              You’re offline. Reconnect to save changes or open another board.
            </span>
          </div>
        )}
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button
              className="text-button"
              onClick={() => {
                failedLink.current = '';
                setJoinRetry((value) => value + 1);
                void refresh(true);
              }}
            >
              Retry
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError('')}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {board ? (
          <>
            <section className="board-heading">
              <div>
                <p className="eyebrow">ROOM FOR GOOD IDEAS</p>
                <h1>{board.title}</h1>
                {board.description && (
                  <p className="board-description">{board.description}</p>
                )}
                <div className="board-stats">
                  <span>
                    <Columns3 size={14} />
                    {board.columns.length} columns
                  </span>
                  <span>
                    {board.cards.length}{' '}
                    {board.cards.length === 1 ? 'card' : 'cards'}
                  </span>
                  <span className="shared-label">
                    <Users size={14} />
                    Shared board
                  </span>
                </div>
              </div>
              <div className="board-actions">
                <button
                  className="button secondary"
                  onClick={() => setModal({ type: 'board', board })}
                  disabled={busy}
                >
                  <Settings2 size={16} />
                  <span>Settings</span>
                </button>
                <button
                  className="button primary"
                  onClick={() => setModal({ type: 'share', board })}
                >
                  <Users size={16} />
                  Invite people
                </button>
              </div>
            </section>
            <section className="board-toolbar" aria-label="Card filters">
              <div className="board-view">
                <Columns3 size={17} />
                Board
                <span />
              </div>
              <div className="filters">
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Search cards"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find a card…"
                  />
                </label>
                <select
                  aria-label="Filter priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                >
                  <option value="all">All priorities</option>
                  <option value="high">High priority</option>
                  <option value="medium">Medium priority</option>
                  <option value="low">Low priority</option>
                </select>
                <select
                  aria-label="Filter assignee"
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                >
                  <option value="">Everyone</option>
                  {[
                    ...new Set(
                      board.cards.map((card) => card.assignee).filter(Boolean),
                    ),
                  ]
                    .sort()
                    .map((name) => (
                      <option key={name} value={`name:${name}`}>
                        {name}
                      </option>
                    ))}
                  <option value="name:">Unassigned</option>
                </select>
                <button
                  className="icon-button"
                  aria-label="Refresh boards"
                  disabled={refreshDisabled}
                  onClick={() => void refresh(true)}
                >
                  <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
                </button>
              </div>
            </section>
            {(query || priority !== 'all' || assignee !== '') && (
              <div className="filter-summary">
                Showing {filteredCount} of {board.cards.length} cards
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery('');
                    setPriority('all');
                    setAssignee('');
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
            <div className="pinboard-scroll">
              <div className="pinboard-columns">
                {board.columns.map((column) => {
                  const cards = sortedCards(board, column.id).filter(matches);
                  return (
                    <section
                      key={column.id}
                      className={`pinboard-column color-${column.color} ${dragColumn === column.id ? 'drop-active' : ''}`}
                      aria-label={column.title}
                      onDragOver={(event) => {
                        if (
                          !disabled &&
                          event.dataTransfer.types.includes(
                            'application/pinboard-card',
                          )
                        ) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          setDragColumn(column.id);
                        }
                      }}
                      onDragLeave={(event) => {
                        if (
                          !event.currentTarget.contains(
                            event.relatedTarget as Node | null,
                          )
                        )
                          setDragColumn('');
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragColumn('');
                        const card = board.cards.find(
                          (item) =>
                            item.id ===
                            event.dataTransfer.getData(
                              'application/pinboard-card',
                            ),
                        );
                        if (card) moveCard(card, column.id);
                      }}
                    >
                      <div className="column-heading">
                        <span className="column-dot" />
                        <h2>{column.title}</h2>
                        <span className="column-count">{cards.length}</span>
                        <button
                          className="icon-button"
                          aria-label={`Settings for ${column.title}`}
                          disabled={disabled}
                          onClick={() =>
                            setModal({
                              type: 'column',
                              board,
                              column,
                              isNew: false,
                            })
                          }
                        >
                          <MoreHorizontal size={19} />
                        </button>
                      </div>
                      <div className="column-cards">
                        {cards.map((card) => (
                          <CardTile
                            key={card.id}
                            card={card}
                            columns={board.columns}
                            disabled={disabled}
                            onEdit={() =>
                              setModal({
                                type: 'card',
                                board,
                                card,
                                isNew: false,
                              })
                            }
                            onMove={(columnId) => moveCard(card, columnId)}
                          />
                        ))}
                        {cards.length === 0 && (
                          <div className="column-empty">
                            <span className="empty-dashes" />
                            <p>
                              {board.cards.some(
                                (card) => card.columnId === column.id,
                              )
                                ? 'No matching cards'
                                : 'A little breathing room.'}
                            </p>
                          </div>
                        )}
                      </div>
                      <button
                        className="add-card"
                        disabled={disabled || board.cards.length >= 2000}
                        onClick={() => addCard(column)}
                      >
                        <Plus size={16} />
                        Add a card
                      </button>
                    </section>
                  );
                })}
                <button
                  className="add-column"
                  disabled={disabled || board.columns.length >= 20}
                  onClick={() =>
                    setModal({
                      type: 'column',
                      board,
                      isNew: true,
                      column: {
                        id: crypto.randomUUID(),
                        title: '',
                        color: 'blue',
                      },
                    })
                  }
                >
                  <Plus size={17} />
                  Add column
                </button>
              </div>
            </div>
            <footer className="board-footer">
              <span>Small steps. Good progress.</span>
            </footer>
          </>
        ) : (
          <section className="home">
            <div className="home-heading">
              <div>
                <p className="eyebrow">
                  SIMPLE KANBAN FOR YOUR EVERYDAY PROJECTS
                </p>
                <h1>
                  Your projects,
                  <br />
                  <em>in view.</em>
                </h1>
                <p>
                  Keep track of what’s next and what’s done.
                  <br />
                  Work on your own, with a partner, or with a few people.
                </p>
              </div>
              <div className="home-actions">
                <button
                  className="button primary"
                  disabled={disabled}
                  onClick={() => setModal({ type: 'create' })}
                >
                  <Plus size={18} />
                  Create a board
                </button>
                <button
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => setModal({ type: 'join' })}
                >
                  <Link size={17} />
                  Join with a code
                </button>
              </div>
            </div>
            {!loaded ? (
              <div className="loading">
                <LoaderCircle size={24} className="spin" />
                Finding your boards…
              </div>
            ) : boardList.length > 0 ? (
              <>
                <div className="section-heading">
                  <h2>
                    Your boards <span>{visibleBoards.length}</span>
                  </h2>
                  <span>Pick up where you left off</span>
                </div>
                <div className="board-grid">
                  {boardList.map((item) => (
                    <button
                      key={item.id}
                      className="board-preview"
                      onClick={() => navigate(item)}
                    >
                      <div className="preview-art">
                        {item.columns.slice(0, 4).map((column) => (
                          <div
                            className={`preview-column color-${column.color}`}
                            key={column.id}
                          >
                            <span />
                            <i />
                            <i className="short" />
                          </div>
                        ))}
                      </div>
                      <div className="preview-info">
                        <h3>
                          {item.title}
                          <ArrowRight size={18} />
                        </h3>
                        <p>
                          {item.description || 'A fresh space for good ideas.'}
                        </p>
                        <div>
                          <span>
                            {item.cards.length} cards · {item.columns.length}{' '}
                            columns
                          </span>
                          <Users size={15} />
                        </div>
                      </div>
                    </button>
                  ))}
                  <button
                    className="new-board-tile"
                    disabled={disabled}
                    onClick={() => setModal({ type: 'create' })}
                  >
                    <span>
                      <Plus size={23} />
                    </span>
                    Create a new board
                  </button>
                </div>
              </>
            ) : (
              <div className="welcome-panel">
                <div className="welcome-copy">
                  <span className="little-label">
                    LESS SCATTER. MORE CLARITY.
                  </span>
                  <h2>
                    From “someday”
                    <br />
                    to “look at that.”
                  </h2>
                  <p>
                    Give your tasks a place to land.
                    <br />A board, a few cards, and you’re on your way.
                  </p>
                  <div className="welcome-check">
                    <Check size={16} />
                    Simple boards. Shared progress.
                  </div>
                </div>
                <div className="illustration" aria-hidden="true">
                  <div className="mini-column">
                    <div className="mini-title">
                      <i />
                      To do<span>2</span>
                    </div>
                    <div className="mini-card">
                      <b className="mini-tag">IDEAS</b>
                      <strong>The next good thing</strong>
                      <span className="mini-line" />
                      <span className="mini-avatar">A</span>
                    </div>
                    <div className="mini-card small">
                      <strong>Make a little space</strong>
                      <span className="mini-line" />
                    </div>
                  </div>
                  <div className="mini-column">
                    <div className="mini-title">
                      <i className="amber" />
                      In progress<span>1</span>
                    </div>
                    <div className="mini-card raised">
                      <b className="mini-tag peach">THIS WEEK</b>
                      <strong>Bring it to life</strong>
                      <span className="mini-line" />
                      <span className="mini-line short" />
                      <div className="mini-bottom">
                        <span className="mini-avatar pink">J</span>
                        <CalendarDays size={14} />
                      </div>
                    </div>
                    <span className="mini-add">
                      <Plus size={14} />
                      Add a card
                    </span>
                  </div>
                  <div className="mini-column">
                    <div className="mini-title">
                      <i className="green" />
                      Done<span>1</span>
                    </div>
                    <div className="mini-card">
                      <span className="done-icon">
                        <Check size={17} />
                      </span>
                      <strong>A little victory</strong>
                      <span className="mini-line" />
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="home-bottom">
              <span>
                <span className="connection-dot" />
                Small projects, one step at a time.
              </span>
              {lastSync && removalsReady && (
                <span>
                  {workspaceCardCount} {workspaceCardCount === 1 ? 'card' : 'cards'}
                  {' across your boards'}
                </span>
              )}
            </div>
          </section>
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {busy && !modal && (
        <div className="saving-pill" role="status">
          <LoaderCircle size={16} className="spin" />
          Saving…
        </div>
      )}
      {modal && (
        <BoardEditor
          key={
            modal.type === 'join'
              ? `join:${modal.code ?? ''}`
              : modal.type === 'card'
                ? `card:${modal.card.id}`
                : modal.type === 'column'
                  ? `column:${modal.column.id}`
                  : 'board' in modal
                    ? `${modal.type}:${modal.board.id}`
                    : modal.type
          }
          modal={modal}
          busy={busy}
          offline={offline}
          removed={'board' in modal && removedCodes.has(modal.board.invite_code)}
          serverError={error}
          currentBoard={
            'board' in modal
              ? boards.find((item) => item.id === modal.board.id)
              : undefined
          }
          onClose={() => closeModal(modal)}
          onSave={save}
          onCreate={(id, title, description) =>
            action(
              () => createBoard(id, title, description),
              'Your board is ready',
              true,
            )
          }
          onJoin={join}
          onRecover={recoverDraft}
          onRemove={removeDeviceBoard}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}
