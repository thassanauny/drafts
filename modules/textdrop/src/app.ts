import type { Cloud } from './lib/cloud';
import { DEVICE_SNIPPETS_KEY, MAX_SNIPPET_NAME_LENGTH, DeviceSnippets, type DeviceSnippet } from './lib/deviceSnippets';
import { MAX_TEXT_BYTES } from './lib/model';
import { PageSession } from './lib/session';
import { invitationLink, joinCode, pageHash, readRoute } from './lib/routes';

const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  document: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h5"/>',
  remove: '<path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6m4-6v6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  rename: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5"/>',
};
function icon(name: keyof typeof icons): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

export function mountTextDrop(root: HTMLElement, cloud: Cloud, options: { configured: boolean; version: string }): () => void {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  root.innerHTML = `
    <div class="shell">
      <header class="site-header">
        <a class="brand" href="#/" aria-label="TextDrop home"><img src="./logo.svg" alt="" width="36" height="36" /><span>textdrop<span class="brand-dot">.</span></span></a>
        <span class="header-note">Shared text, one code away</span>
        <span class="online-indicator" id="connection"><span class="dot"></span><span id="connection-label">Online</span></span>
      </header>
      <main>
        <section id="home" class="home">
          <div class="intro">
            <span class="eyebrow"><span class="tiny-line"></span> TEXT · NOTES · SNIPPETS</span>
            <h1>Copy here.<br />Open <em>anywhere.</em></h1>
            <p class="lead">Share text with others or open it on another device. One page, one code.</p>
            <div class="hero-actions">
              <button class="button primary" id="create">${icon('plus')}Create a snippet</button>
              <button class="button secondary" id="join">${icon('link')}Open a snippet</button>
            </div>
            <p class="quiet small">No account to create. Just text to pass along.</p>
          </div>
          <div class="hero-visual">
            <div class="paper-illustration" aria-hidden="true"><div class="paper back-paper"></div><div class="paper front-paper"><span class="paper-mark">{ }</span><span class="paper-line long"></span><span class="paper-line"></span><span class="paper-line medium"></span><div class="paper-sticker">${icon('link')}</div></div><span class="illustration-spark">✳</span></div>
            <p>One code. Shared text.</p>
          </div>
          <section class="device-snippets" aria-labelledby="device-heading">
            <div class="device-heading"><h2 id="device-heading" tabindex="-1">Snippets on this device</h2><span id="device-count" class="device-count"></span></div>
            <p class="device-guidance">Give snippets a name to find them easily. Names stay on this device; share the code to share the text.</p>
            <ul class="device-list" id="device-list"></ul>
            <p class="device-empty" id="device-empty">Snippets you create or open will appear here.</p>
          </section>
          <div class="home-notes"><span>${icon('check')} Saves as you type</span><span>${icon('link')} Share one code</span><span>${icon('check')} Latest save wins</span></div>
        </section>
        <section id="workspace" class="workspace" hidden aria-label="Shared snippet">
          <div class="workspace-heading"><a class="back-link" href="#/">${icon('back')}Home</a><span class="workspace-kind">SHARED SNIPPET</span></div>
          <div class="page-header">
            <div><h1><span id="page-name">Shared snippet</span><span class="brand-dot">.</span></h1><p>A shared space for your text. Everyone with the code can edit.</p></div>
            <div class="page-actions"><button class="button primary" id="share">${icon('link')}Invite</button><button class="icon-button" id="settings" aria-label="Snippet settings" title="Snippet settings">${icon('settings')}</button></div>
          </div>
          <div class="code-strip"><span class="code-label">SNIPPET CODE</span><code id="page-code"></code><button class="icon-button" id="copy-code" aria-label="Copy snippet code" title="Copy snippet code">${icon('copy')}</button><span class="code-hint">Keep this code to open your snippet again.</span></div>
          <div class="editor-card">
            <div class="editor-toolbar"><span class="document-label"><span class="document-dot"></span>Plain text</span><div class="editor-actions"><button class="text-button" id="copy-text">${icon('copy')}Copy text</button><button class="text-button" id="download">${icon('download')}Download</button></div></div>
            <label class="sr-only" for="editor">Shared snippet text</label>
            <textarea id="editor" spellcheck="false" placeholder="Write or paste your text here…" aria-describedby="save-status editor-guidance"></textarea>
            <div class="editor-footer"><span id="save-status" role="status" aria-live="polite"></span><span id="text-count"></span></div>
          </div>
          <div class="workspace-notes"><p id="editor-guidance">Changes save automatically. If two people edit, the latest saved text wins.</p><span id="updated-at"></span></div>
        </section>
        <div class="notice" id="notice" hidden><p id="notice-message" role="alert"></p><button class="button small-button" id="retry" hidden>Retry save</button></div>
      </main>
      <footer class="site-footer"><span>Your text, within reach.</span><span>textdrop <span id="version"></span></span></footer>
    </div>
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
    <dialog id="snippet-dialog" aria-labelledby="dialog-title">
      <div class="dialog-heading"><h2 id="dialog-title"></h2><button type="button" class="icon-button" id="dialog-close" aria-label="Close dialog">×</button></div>
      <form id="create-form" class="dialog-stack" hidden>
        <p>Start with a blank page, then add your text. Share its code or link with others, or open it on another device.</p>
        <div class="dialog-actions"><button type="button" class="button" id="create-cancel">Cancel</button><button type="submit" class="button primary" id="create-confirm">${icon('plus')}<span id="create-label">Create snippet</span></button></div>
      </form>
      <form id="join-form" class="dialog-stack" hidden>
        <p>Paste a snippet’s invitation code or link. No account needed.</p>
        <label for="join-code">Invitation code or link</label>
        <input id="join-code" name="code" type="text" placeholder="Paste your invitation here" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2048" required />
        <p class="dialog-note">Anyone with the code can read and edit the text. Share it with people you trust.</p>
        <div class="dialog-actions"><button type="button" class="button" id="join-cancel">Cancel</button><button type="submit" class="button primary" id="join-confirm">${icon('arrow')}<span id="join-label">Open snippet</span></button></div>
      </form>
      <section id="invite-panel" class="dialog-stack" hidden>
        <p>Invite someone to this snippet.</p>
        <label for="invite-code">Invitation code</label><input id="invite-code" readonly />
        <button type="button" class="button primary" id="invite-copy-code">${icon('copy')}Copy invitation code</button>
        <button type="button" class="button" id="invite-copy-link">${icon('link')}Copy invite link</button>
        <p class="dialog-note">Anyone with this code can join and edit this snippet. Share it with people you trust.</p>
      </section>
      <section id="settings-panel" class="dialog-stack" hidden>
        <button type="button" class="button" id="settings-rename">${icon('rename')}Name on this device</button>
        <p>Remove this snippet from your list on this device. Everyone else keeps access.</p>
        <button type="button" class="button" id="settings-remove">${icon('remove')}Remove from this device</button>
      </section>
      <form id="rename-form" class="dialog-stack" hidden>
        <p>A name makes this snippet easier to find. Only this device sees it.</p>
        <label for="snippet-name-input">Name on this device</label>
        <input id="snippet-name-input" name="name" type="text" placeholder="e.g. Travel notes" autocomplete="off" maxlength="${MAX_SNIPPET_NAME_LENGTH}" aria-describedby="rename-guidance" />
        <p id="rename-guidance" class="dialog-note">Leave blank to clear the name. The shared text and invitation code stay the same.</p>
        <div class="dialog-actions"><button type="button" class="button" id="rename-cancel">Cancel</button><button type="submit" class="button primary" id="rename-confirm">Save name</button></div>
      </form>
      <form id="remove-form" class="dialog-stack" hidden>
        <p>This removes the snippet from your list on this device. Shared text and everyone else’s access stay available.</p>
        <label for="remove-code">Invitation code</label><input id="remove-code" readonly />
        <p class="dialog-note">Keep this code to rejoin later.</p>
        <button type="button" class="button" id="remove-copy-code">${icon('copy')}Copy invitation code</button>
        <div id="remove-unsaved" class="dialog-warning" hidden>
          <p>Your unsaved text exists only in this open page. Copy it or save it before removing the snippet.</p>
          <button type="button" class="text-button" id="remove-copy-text">${icon('copy')}Copy unsaved text</button>
          <label class="discard-label"><input id="remove-discard" type="checkbox" />Discard my unsaved text</label>
        </div>
        <p id="remove-saving" class="dialog-note" hidden>Wait for the current save to finish before removing this snippet.</p>
        <div class="dialog-actions"><button type="button" class="button" id="remove-cancel">Keep on this device</button><button type="submit" class="button primary" id="remove-confirm">Remove from this device</button></div>
      </form>
      <p id="dialog-error" class="dialog-error" role="alert" hidden></p>
    </dialog>
  `;

  function element<T extends HTMLElement = HTMLElement>(id: string): T {
    return root.querySelector<T>(`#${id}`)!;
  }

  const editor = element<HTMLTextAreaElement>('editor');
  const codeInput = element<HTMLInputElement>('join-code');
  const { configured, version } = options;
  const session = new PageSession(cloud);
  const deviceSnippets = new DeviceSnippets();
  let rememberedSnippets: DeviceSnippet[] = [];
  let deviceReadError = '';
  let deviceWriteError = '';
  let uiError = '';
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let currentHash = location.hash;
  let loadingLink = false;
  let modal: 'create' | 'join' | 'invite' | 'settings' | 'remove' | 'rename' | null = null;
  let removingCode = '';
  let dialogError = '';
  let copyAttempt = 0;
  let returnFocus: HTMLElement | null = null;
  const dialog = element<HTMLDialogElement>('snippet-dialog');

  element('version').textContent = `v${version}`;

  function showToast(message: string): void {
    clearTimeout(toastTimer);
    element('toast').textContent = message;
    element('toast').hidden = false;
    toastTimer = setTimeout(() => { element('toast').hidden = true; }, 2400);
  }

  function renderDeviceSnippets(): void {
    const list = element('device-list');
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
    const focusedAction = focused?.classList.contains('snippet-open') ? 'snippet-open' : focused?.classList.contains('snippet-rename') ? 'snippet-rename' : 'snippet-remove';
    const focusedIndex = focused ? [...list.children].findIndex(row => row.contains(focused)) : -1;
    list.replaceChildren();
    element('device-empty').hidden = rememberedSnippets.length > 0;
    element('device-count').textContent = rememberedSnippets.length ? String(rememberedSnippets.length) : '';
    for (const snippet of rememberedSnippets) {
      const row = document.createElement('li');
      row.className = 'device-row';
      const mark = document.createElement('span');
      mark.className = 'snippet-mark';
      mark.innerHTML = icon('document');
      const details = document.createElement('div');
      details.className = 'snippet-details';
      const name = document.createElement('span');
      name.className = 'snippet-name';
      name.textContent = snippet.name || 'Untitled snippet';
      name.title = name.textContent;
      const code = document.createElement('code');
      code.textContent = `${snippet.code.slice(0, 6)}…${snippet.code.slice(-6)}`;
      code.title = snippet.code;
      const opened = document.createElement('time');
      opened.dateTime = snippet.openedAt;
      opened.textContent = `Last opened ${new Date(snippet.openedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      const metadata = document.createElement('span');
      metadata.className = 'snippet-metadata';
      metadata.append(code, opened);
      details.append(name, metadata);
      const open = document.createElement('a');
      open.className = 'snippet-open';
      open.href = pageHash(snippet.code);
      open.dataset.code = snippet.code;
      open.title = `Open snippet ${snippet.code}`;
      open.setAttribute('aria-label', snippet.name ? `Open ${snippet.name}, snippet ${snippet.code}` : `Open snippet ${snippet.code}`);
      const action = document.createElement('span');
      action.className = 'snippet-cta';
      action.innerHTML = `Open ${icon('arrow')}`;
      open.append(mark, details, action);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'icon-button snippet-rename';
      rename.dataset.code = snippet.code;
      rename.innerHTML = icon('rename');
      rename.title = 'Name on this device';
      rename.setAttribute('aria-label', `Rename ${snippet.name || 'snippet'}, code ${snippet.code}`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button snippet-remove';
      remove.dataset.code = snippet.code;
      remove.innerHTML = icon('remove');
      remove.title = 'Remove from this device';
      remove.setAttribute('aria-label', `Remove snippet ${snippet.code} from this device`);
      const actions = document.createElement('div');
      actions.className = 'snippet-actions';
      actions.append(rename, remove);
      row.append(open, actions);
      list.append(row);
    }
    if (focused) {
      const actions = [...list.querySelectorAll<HTMLElement>(`.${focusedAction}`)];
      const matching = actions.find(action => action.dataset.code === focused.dataset.code);
      (matching ?? actions[Math.min(focusedIndex, actions.length - 1)] ?? element('device-heading')).focus();
    }
  }

  function updateDeviceSnippets(action: () => DeviceSnippet[], writing = false): boolean {
    try {
      const next = action();
      deviceReadError = '';
      if (writing) deviceWriteError = '';
      if (JSON.stringify(next) !== JSON.stringify(rememberedSnippets)) {
        rememberedSnippets = next;
        renderDeviceSnippets();
      }
      render();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This browser could not update your snippet list.';
      if (writing) deviceWriteError = `${message} Keep the snippet code to open it again.`;
      else deviceReadError = message;
      render();
      return false;
    }
  }

  function rememberCurrentSnippet(expected?: string | null): boolean {
    const page = session.state.page;
    return page ? updateDeviceSnippets(() => deviceSnippets.remember(page.code, expected), true) : false;
  }

  function closeDialog(force = false, restoreFocus = true): void {
    const openingDialog = modal === 'create' || modal === 'join';
    if (!force && openingDialog && session.state.phase === 'opening') return;
    if (!force && modal === 'join' && readRoute(location.hash).kind === 'join') {
      currentHash = '#/';
      history.replaceState(null, '', currentHash);
    }
    ++copyAttempt;
    modal = null;
    dialogError = '';
    dialog.close();
    if (!force && openingDialog && !session.state.page) session.home();
    if (!restoreFocus) return;
    if (returnFocus?.isConnected) returnFocus.focus();
    else {
      const action = returnFocus?.classList.contains('snippet-open') ? '.snippet-open' : returnFocus?.classList.contains('snippet-rename') ? '.snippet-rename' : '.snippet-remove';
      const replacement = [...root.querySelectorAll<HTMLElement>(action)].find(item => item.dataset.code === returnFocus?.dataset.code);
      const fallback = element('home').hidden ? element('settings') : element('device-heading');
      (replacement ?? fallback).focus();
    }
  }

  function showDialog(kind: NonNullable<typeof modal>, code = session.state.page?.code ?? ''): void {
    if (kind !== 'create' && kind !== 'join' && !code) return;
    ++copyAttempt;
    if (!dialog.open) returnFocus = kind === 'create' ? element('create') : kind === 'join' ? element('join') : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal = kind;
    removingCode = code;
    dialogError = '';
    uiError = '';
    element<HTMLInputElement>('remove-discard').checked = false;
    if (kind === 'rename') element<HTMLInputElement>('snippet-name-input').value = rememberedSnippets.find(snippet => snippet.code === code)?.name ?? '';
    render();
    if (!dialog.open) dialog.showModal();
    (kind === 'create' ? element('create-confirm') : kind === 'join' ? codeInput : kind === 'invite' ? element('invite-code') : kind === 'remove' ? element('remove-code') : kind === 'rename' ? element('snippet-name-input') : element('settings-rename')).focus();
  }

  function render(): void {
    const { page, draft, phase, dirty, error, online } = session.state;
    const opening = phase === 'opening';
    element('home').hidden = Boolean(page);
    element('workspace').hidden = !page;
    element('connection').classList.toggle('disconnected', !online);
    element('connection-label').textContent = online ? 'Online' : 'Offline';
    element<HTMLButtonElement>('create').disabled = opening || !online || !configured;
    element<HTMLButtonElement>('join').disabled = opening || !online || !configured;
    const openingDialog = modal === 'create' || modal === 'join';
    codeInput.disabled = opening;
    for (const id of ['create-confirm', 'join-confirm']) element<HTMLButtonElement>(id).disabled = opening || !online || !configured;
    for (const id of ['create-cancel', 'join-cancel', 'dialog-close']) element<HTMLButtonElement>(id).disabled = openingDialog && opening;
    element('create-label').textContent = opening && !loadingLink ? 'Creating…' : 'Create snippet';
    element('join-label').textContent = opening && loadingLink ? 'Opening…' : 'Open snippet';
    for (const open of root.querySelectorAll<HTMLAnchorElement>('.snippet-open')) {
      const disabled = opening || !online || !configured;
      open.setAttribute('aria-disabled', String(disabled));
      open.tabIndex = disabled ? -1 : 0;
    }
    for (const action of root.querySelectorAll<HTMLButtonElement>('.snippet-remove, .snippet-rename')) action.disabled = opening;

    if (page) {
      const name = rememberedSnippets.find(snippet => snippet.code === page.code)?.name || 'Shared snippet';
      element('page-name').textContent = name;
      document.title = `${name} — TextDrop`;
      element('page-code').textContent = page.code;
      if (editor.value !== draft) editor.value = draft;
      editor.disabled = !online;
      const bytes = new TextEncoder().encode(draft).byteLength;
      const tooLarge = bytes > MAX_TEXT_BYTES;
      element('text-count').textContent = `${draft.length.toLocaleString()} characters · ${draft.split('\n').length.toLocaleString()} lines${tooLarge ? ' · over 1 MiB limit' : ''}`;
      element('text-count').classList.toggle('over-limit', tooLarge);
      const status = !online ? 'Offline · editing paused' : phase === 'saving' ? 'Saving…' : dirty ? error ? 'Not saved' : 'Unsaved changes…' : error ? 'Sync unavailable' : 'All changes saved';
      element('save-status').textContent = status;
      element('save-status').classList.toggle('unsaved', dirty || Boolean(error) || !online);
      element('updated-at').textContent = `Last saved ${new Date(page.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      document.title = 'TextDrop — share text';
    }
    const notice = uiError || (!openingDialog ? error : '') || deviceWriteError || deviceReadError || (!configured ? 'Sharing needs Supabase settings. Add the public project settings, then restart this app.' : '') || (!online ? 'Reconnect to create, open, or edit a page. Text is not stored on this device.' : '');
    element('notice').hidden = !notice;
    element('notice-message').textContent = notice;
    element('retry').hidden = !page || !dirty || !online || phase === 'saving' || new TextEncoder().encode(draft).byteLength > MAX_TEXT_BYTES;
    if (modal) {
      element('dialog-title').textContent = modal === 'create' ? 'Create a snippet' : modal === 'join' ? 'Open a snippet' : modal === 'invite' ? 'Invite to snippet' : modal === 'settings' ? 'Snippet settings' : modal === 'rename' ? 'Name this snippet' : 'Remove from this device?';
      element('create-form').hidden = modal !== 'create';
      element('join-form').hidden = modal !== 'join';
      element('invite-panel').hidden = modal !== 'invite';
      element('settings-panel').hidden = modal !== 'settings';
      element('rename-form').hidden = modal !== 'rename';
      element('remove-form').hidden = modal !== 'remove';
      element<HTMLInputElement>('invite-code').value = removingCode;
      element<HTMLInputElement>('remove-code').value = removingCode;
      const removingCurrent = page?.code === removingCode;
      element('remove-unsaved').hidden = !removingCurrent || !dirty;
      const saving = removingCurrent && phase === 'saving';
      element('remove-saving').hidden = !saving;
      element<HTMLButtonElement>('remove-confirm').disabled = saving || (removingCurrent && dirty && !element<HTMLInputElement>('remove-discard').checked);
      const message = dialogError || (openingDialog ? error || (!configured ? 'Sharing is unavailable. Please try again later.' : !online ? 'Reconnect to create or open a snippet.' : '') : '');
      element('dialog-error').textContent = message;
      element('dialog-error').hidden = !message;
    }
  }

  renderDeviceSnippets();
  updateDeviceSnippets(() => deviceSnippets.list());
  session.subscribe(render);
  session.setOnline(navigator.onLine);

  function navigateToPage(expected?: string | null): void {
    if (!session.state.page) return;
    if (modal === 'create' || modal === 'join') closeDialog(true, false);
    const remembered = rememberCurrentSnippet(expected);
    try {
      if (deviceSnippets.isRemoved(session.state.page.code)) {
        codeInput.value = session.state.page.code;
        session.home();
        currentHash = '#/';
        history.replaceState(null, '', currentHash);
        uiError = remembered
          ? 'This snippet was removed from this device while opening. Choose Open a snippet to open it again.'
          : deviceWriteError || deviceReadError;
        render();
        element('join').focus();
        return;
      }
    } catch (error) {
      deviceReadError = error instanceof Error ? error.message : 'Could not read snippets saved on this device.';
      render();
    }
    currentHash = pageHash(session.state.page.code);
    history.replaceState(null, '', currentHash);
    editor.focus();
  }

  element('create').addEventListener('click', () => { showDialog('create'); }, { signal });
  element('join').addEventListener('click', () => { showDialog('join'); }, { signal });
  element('create-form').addEventListener('submit', event => {
    event.preventDefault();
    if (modal !== 'create' || session.state.phase === 'opening' || !session.state.online || !configured) return;
    uiError = '';
    dialogError = '';
    loadingLink = false;
    void session.create().then(opened => { if (opened) navigateToPage(); });
  }, { signal });

  element('join-form').addEventListener('submit', event => {
    event.preventDefault();
    if (modal !== 'join' || session.state.phase === 'opening' || !session.state.online || !configured) return;
    uiError = '';
    dialogError = '';
    try {
      const code = joinCode(codeInput.value);
      const expected = deviceSnippets.snapshot(code);
      loadingLink = true;
      void session.join(code).then(opened => { if (opened) navigateToPage(expected); });
    } catch (error) {
      dialogError = error instanceof Error ? error.message : 'Check the invitation code and try again.';
      render();
      codeInput.focus();
    }
  }, { signal });

  element('device-list').addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rename = target.closest<HTMLButtonElement>('.snippet-rename');
    if (rename?.dataset.code && !rename.disabled) {
      showDialog('rename', rename.dataset.code);
      return;
    }
    const open = target.closest<HTMLAnchorElement>('.snippet-open');
    if (open && (session.state.phase === 'opening' || !session.state.online || !configured)) {
      event.preventDefault();
      return;
    }
    if (open && new URL(open.href).hash === location.hash && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void route();
      return;
    }
    const remove = target.closest<HTMLButtonElement>('.snippet-remove');
    const code = remove?.dataset.code;
    if (!code) return;
    showDialog('remove', code);
  }, { signal });

  editor.addEventListener('input', () => { uiError = ''; session.edit(editor.value); }, { signal });
  editor.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void session.save();
    }
  }, { signal });
  element('retry').addEventListener('click', () => { uiError = ''; void session.save(); }, { signal });

  async function copy(value: string, message: string): Promise<void> {
    const attempt = ++copyAttempt;
    const pageId = session.state.page?.id;
    const current = () => !signal.aborted && attempt === copyAttempt && pageId === session.state.page?.id;
    uiError = '';
    dialogError = '';
    render();
    try {
      await navigator.clipboard.writeText(value);
      if (current()) showToast(message);
    } catch {
      if (!current()) return;
      uiError = 'Your browser could not copy automatically. Select the text or snippet code and copy it manually.';
      if (modal) dialogError = uiError;
      render();
    }
  }
  element('share').addEventListener('click', () => { showDialog('invite'); }, { signal });
  element('settings').addEventListener('click', () => { showDialog('settings'); }, { signal });
  element('settings-rename').addEventListener('click', () => { showDialog('rename'); }, { signal });
  element('settings-remove').addEventListener('click', () => { showDialog('remove'); }, { signal });
  element('rename-form').addEventListener('submit', event => {
    event.preventDefault();
    if (modal !== 'rename') return;
    if (!updateDeviceSnippets(() => deviceSnippets.rename(removingCode, element<HTMLInputElement>('snippet-name-input').value), true)) {
      dialogError = deviceWriteError;
      render();
      return;
    }
    closeDialog();
    showToast('Name saved on this device');
  }, { signal });
  for (const id of ['dialog-close', 'create-cancel', 'join-cancel', 'remove-cancel', 'rename-cancel']) element(id).addEventListener('click', () => { closeDialog(); }, { signal });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); }, { signal });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
  }, { signal });
  for (const id of ['invite-code', 'remove-code']) element<HTMLInputElement>(id).addEventListener('focus', event => { (event.currentTarget as HTMLInputElement).select(); }, { signal });
  for (const id of ['invite-copy-code', 'remove-copy-code']) element(id).addEventListener('click', () => { void copy(removingCode, 'Invitation code copied'); }, { signal });
  element('invite-copy-link').addEventListener('click', () => { void copy(invitationLink(removingCode, location.href), 'Invite link copied'); }, { signal });
  element('remove-copy-text').addEventListener('click', () => { void copy(session.state.draft, 'Text copied'); }, { signal });
  element('remove-discard').addEventListener('change', render, { signal });
  element('remove-form').addEventListener('submit', event => {
    event.preventDefault();
    if (modal !== 'remove' || element<HTMLButtonElement>('remove-confirm').disabled) return;
    const index = rememberedSnippets.findIndex(snippet => snippet.code === removingCode);
    if (!updateDeviceSnippets(() => deviceSnippets.remove(removingCode), true)) {
      dialogError = deviceWriteError;
      render();
      return;
    }
    const removingCurrent = session.state.page?.code === removingCode;
    closeDialog();
    if (removingCurrent) {
      currentHash = '#/';
      history.replaceState(null, '', currentHash);
      session.home();
    }
    const remaining = element('device-list').querySelectorAll<HTMLButtonElement>('.snippet-remove');
    (remaining[Math.min(index, remaining.length - 1)] ?? element('device-heading')).focus();
    showToast('Snippet removed from this device');
  }, { signal });
  element('copy-code').addEventListener('click', () => {
    if (session.state.page) void copy(session.state.page.code, 'Snippet code copied');
  }, { signal });
  element('copy-text').addEventListener('click', () => { void copy(session.state.draft, 'Text copied'); }, { signal });
  element('download').addEventListener('click', () => {
    const page = session.state.page;
    if (!page) return;
    const url = URL.createObjectURL(new Blob([session.state.draft], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `textdrop-${page.code.slice(0, 8)}.txt`;
    anchor.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
  }, { signal });

  async function route(): Promise<void> {
    const nextHash = location.hash;
    if (session.state.dirty) {
      if (!window.confirm('This page has unsaved changes. Leave and discard them?')) {
        history.replaceState(null, '', currentHash || '#/');
        return;
      }
    }
    currentHash = nextHash;
    uiError = '';
    if (modal) closeDialog(true, false);
    const next = readRoute(nextHash);
    if (next.kind === 'home') {
      updateDeviceSnippets(() => deviceSnippets.list());
      session.home();
      element('create').focus();
    } else if (next.kind === 'page') {
      let expected: string | null;
      try {
        expected = deviceSnippets.snapshot(next.code);
        if (deviceSnippets.isRemoved(next.code)) {
          session.home();
          codeInput.value = next.code;
          uiError = 'This snippet was removed from this device. Choose Open a snippet to open it again with its code.';
          render();
          element('join').focus();
          return;
        }
      } catch (error) {
        session.home();
        uiError = error instanceof Error ? error.message : 'Could not read snippets saved on this device.';
        render();
        return;
      }
      loadingLink = true;
      codeInput.value = next.code;
      if (await session.join(next.code)) {
        navigateToPage(expected);
      }
    } else if (next.kind === 'join') {
      session.home();
      codeInput.value = next.code;
      showDialog('join');
    } else {
      session.home();
      uiError = 'That invitation link is invalid. Paste a complete snippet code to open it.';
      render();
    }
  }

  window.addEventListener('hashchange', () => { void route(); }, { signal });
  window.addEventListener('offline', () => { session.setOnline(false); }, { signal });
  window.addEventListener('online', () => { session.setOnline(true); void session.refresh(); }, { signal });
  function refreshDeviceSnippets(): void {
    if (!updateDeviceSnippets(() => deviceSnippets.list())) return;
    const page = session.state.page;
    if (!page) return;
    try {
      if (!deviceSnippets.isRemoved(page.code)) return;
      if (session.state.dirty) {
        uiError = 'This snippet was removed from this device in another tab. Your unsaved text stays in this open page; copy or save it before leaving.';
        render();
      } else {
        if (modal) closeDialog();
        session.home();
        currentHash = '#/';
        history.replaceState(null, '', currentHash);
        element('join').focus();
      }
    } catch (error) {
      deviceReadError = error instanceof Error ? error.message : 'Could not read snippets saved on this device.';
      render();
    }
  }
  window.addEventListener('focus', () => { refreshDeviceSnippets(); void session.refresh(); }, { signal });
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(`${DEVICE_SNIPPETS_KEY}:`) || event.key === null) refreshDeviceSnippets();
  }, { signal });
  window.addEventListener('beforeunload', event => {
    if (session.state.dirty) { event.preventDefault(); event.returnValue = ''; }
  }, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshDeviceSnippets();
      void session.refresh();
    }
  }, { signal });
  const pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void session.refresh(); }, 3000);
  void route();

  return () => {
    lifecycle.abort();
    clearInterval(pollTimer);
    clearTimeout(toastTimer);
    session.dispose();
    if (dialog.open) dialog.close();
    root.replaceChildren();
  };
}
