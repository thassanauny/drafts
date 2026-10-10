import { store, type Activity } from './lib/storage';
import { formatBytes } from './lib/util';

export type Child = Node | string | number | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') (el as any).htmlFor = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let uid = 0;
export const nextId = (p = 'f') => `${p}-${++uid}`;

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';
export const badge = (text: string, tone: Tone = 'neutral') => h('span', { class: `badge badge-${tone}` }, text);
export const notice = (tone: Tone, ...content: Child[]) => h('div', { class: `notice notice-${tone}`, role: tone === 'danger' ? 'alert' : 'note' }, ...content);

export function button(label: string, onClick: (e: Event) => void, opts: { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; type?: string } = {}) {
  return h('button', { type: opts.type ?? 'button', class: `btn btn-${opts.variant ?? 'secondary'}`, disabled: opts.disabled, onclick: onClick }, label);
}

export function panel(title: string, desc: string | null, ...body: Child[]) {
  const id = nextId('panel');
  return h('section', { class: 'panel', 'aria-labelledby': id }, h('h2', { id, class: 'panel-title' }, title), desc ? h('p', { class: 'muted' }, desc) : null, ...body);
}

export function field<T extends HTMLElement>(label: string, control: T, hint?: string): HTMLElement {
  const id = control.id || nextId('in');
  control.id = id;
  const hintId = hint ? `${id}-hint` : '';
  if (hint) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control, hint ? h('p', { id: hintId, class: 'field-hint' }, hint) : null);
}
export const input = (type: string, name: string, value = '', extra: Record<string, any> = {}) => h('input', { type, name, value, ...extra });
export function select(name: string, options: [string, string][], value?: string) {
  const s = h('select', { name }, options.map(([v, l]) => h('option', { value: v }, l)));
  if (value) s.value = value;
  return s;
}

export function option(title: string, detail: string, control: HTMLInputElement) {
  return h('label', { class: 'option' }, control, h('span', {}, h('strong', {}, title), h('small', {}, detail)));
}

export function emptyState(title: string, text: string) {
  return h('div', { class: 'empty' }, h('strong', {}, title), h('p', { class: 'muted' }, text));
}

export function progress() {
  const bar = h('progress', { max: 100, value: 0, 'aria-label': 'Progress' });
  const label = h('span', { class: 'muted', 'aria-live': 'polite' }, '');
  const el = h('div', { class: 'progress', hidden: true }, bar, label);
  return { el, set(pct: number | null, text = '') { el.hidden = false; if (pct === null) bar.removeAttribute('value'); else bar.value = Math.round(pct); label.textContent = text || (pct === null ? 'Working…' : `${Math.round(pct)}%`); }, hide() { el.hidden = true; } };
}

// ---- toasts ----
let region: HTMLElement | null = null;
export function toast(message: string, tone: Tone = 'info') {
  region ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast toast-${tone}` }, message);
  region.append(t);
  setTimeout(() => t.remove(), tone === 'danger' ? 7000 : 4000);
}

// ---- file picking ----
export function filePicker(opts: { label: string; accept?: string; multiple?: boolean; directory?: boolean; hint?: string; onFiles: (f: File[]) => void }) {
  const inp = h('input', { type: 'file', accept: opts.accept, multiple: !!opts.multiple, class: 'file-input' });
  const message = h('div');
  const acceptedTypes = opts.accept?.toLowerCase().split(',').map((type) => type.trim()).filter(Boolean) ?? [];
  const selectFiles = (files: File[]) => {
    if (inp.matches(':disabled')) return;
    const accepted = files.filter((file) => !acceptedTypes.length || acceptedTypes.some((type) => {
      if (type.startsWith('.')) return file.name.toLowerCase().endsWith(type);
      if (type.endsWith('/*')) return file.type.toLowerCase().startsWith(type.slice(0, -1));
      return file.type.toLowerCase() === type;
    }));
    message.replaceChildren();
    if (accepted.length !== files.length) message.append(notice('warn', 'Unsupported files were skipped. Choose a file type listed by this picker.'));
    if (accepted.length) opts.onFiles(opts.multiple || opts.directory ? accepted : accepted.slice(0, 1));
  };
  if (opts.directory) { inp.setAttribute('webkitdirectory', ''); inp.multiple = true; }
  inp.addEventListener('change', () => { selectFiles([...(inp.files ?? [])]); inp.value = ''; });
  const wrap = field(opts.label, inp, opts.hint ?? 'Files stay on your device and are never uploaded.');
  wrap.append(message);
  if (!opts.directory) {
    wrap.classList.add('dropzone');
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); if (!inp.matches(':disabled')) wrap.classList.add('drag'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
    wrap.addEventListener('drop', (e) => {
      e.preventDefault(); wrap.classList.remove('drag');
      selectFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }
  return wrap;
}

/** Reorderable file list. Keyboard accessible via Up/Down buttons. */
export function fileList<T extends { name: string; size?: number }>(items: T[], onChange: () => void, extra?: (item: T) => Child) {
  const ul = h('ul', { class: 'file-list' });
  const render = () => {
    ul.replaceChildren();
    if (!items.length) { ul.append(h('li', {}, emptyState('No files yet', 'Add files above to get started.'))); return; }
    items.forEach((it, i) => {
      const move = (d: number) => { const j = i + d; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; render(); onChange(); };
      ul.append(h('li', { class: 'file-row' },
        h('span', { class: 'file-name' }, `${i + 1}. ${it.name}`, it.size !== undefined ? h('small', { class: 'muted' }, ` ${formatBytes(it.size)}`) : null),
        extra?.(it),
        h('button', { class: 'btn btn-ghost', type: 'button', disabled: i === 0, 'aria-label': `Move ${it.name} up`, onclick: () => move(-1) }, '↑'),
        h('button', { class: 'btn btn-ghost', type: 'button', disabled: i === items.length - 1, 'aria-label': `Move ${it.name} down`, onclick: () => move(1) }, '↓'),
        h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': `Remove ${it.name}`, onclick: () => { items.splice(i, 1); render(); onChange(); } }, '✕')));
    });
  };
  render();
  return { el: ul, refresh: render };
}

// ---- task runner: running / done / failed / cancelled / retry ----
export interface TaskCtx { signal: AbortSignal; progress: (pct: number, label?: string) => void }
let activeTask: AbortController | null = null;
export function taskControls(toolId: string, label: string, run: (ctx: TaskCtx) => Promise<string | void>, opts: { validate?: () => string | null } = {}) {
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' }, 'Ready.');
  const prog = progress();
  const fileTask = ['media-converter', 'document-converter', 'images-to-pdf', 'merge-pdfs', 'split-pdf', 'pdf-to-images', 'compress-pdf', 'unlock-pdf', 'crop-image', 'compress-image', 'image-workshop'].includes(toolId);
  let ac: AbortController | null = null;
  const go = button(`${label} →`, () => start(), { variant: 'primary' });
  const cancel = button('Cancel', () => ac?.abort(), { variant: 'danger' });
  cancel.hidden = true;
  const retry = button('Retry', () => start());
  retry.hidden = true;
  const log = (statusV: Activity['status'], message: string) => { store.addActivity({ tool: toolId, status: statusV, message }); };
  async function start() {
    if (activeTask) { toast('An operation is already running. Cancel it before starting another.', 'warn'); return; }
    const err = opts.validate?.();
    if (err) { status.textContent = err; status.className = 'status status-danger'; prog.hide(); return; }
    ac = new AbortController();
    const controller = ac;
    activeTask = controller;
    const root = go.closest('main');
    const abort = () => controller.abort();
    root?.addEventListener('utility-desk:leave', abort, { once: true });
    const controls = [...(root?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, textarea, button') ?? [])].filter((el) => el !== cancel && !el.disabled);
    controls.forEach((el) => { el.disabled = true; });
    go.disabled = true; cancel.hidden = false; retry.hidden = true;
    status.className = 'status'; status.textContent = 'Working…'; prog.set(null, 'Starting…');
    try {
      const msg = await run({ signal: ac.signal, progress: (p, l) => prog.set(p * 100, l) });
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      status.textContent = `Done. ${msg ?? ''}`.trim(); status.className = 'status status-success';
      if (fileTask) prog.set(100, 'Completed.');
      toast(status.textContent, 'success'); log('done', msg || label);
    } catch (e) {
      if ((e as Error).name === 'AbortError') { status.textContent = 'Cancelled.'; status.className = 'status status-warn'; log('cancelled', `${label} cancelled`); }
      else { const m = (e as Error).message || 'Unknown error'; status.textContent = `Failed: ${m}`; status.className = 'status status-danger'; log('failed', m); }
      retry.hidden = false;
    } finally { controls.forEach((el) => { el.disabled = false; }); root?.removeEventListener('utility-desk:leave', abort); go.disabled = false; cancel.hidden = true; if (!fileTask || status.className !== 'status status-success') prog.hide(); ac = null; activeTask = null; }
  }
  const reset = () => { if (ac) return; status.textContent = 'Ready.'; status.className = 'status'; prog.hide(); retry.hidden = true; };
  return { el: h('div', { class: 'task' }, h('div', { class: 'action-buttons' }, go, cancel, retry), prog.el, status), run: start, reset };
}

/** Persist preferences, excluding files, passwords, and source-dependent fields. */
export function persistForm(toolId: string, root: HTMLElement, sourceFields: string[] = []) {
  const draft = store.getDraft(toolId);
  const excluded = new Set(['outputName', 'outName', ...sourceFields]);
  const controls = [...root.querySelectorAll<HTMLInputElement>('[name]')].filter((e) => e.type !== 'file' && e.type !== 'password' && !excluded.has(e.name));
  controls.forEach((e) => { const v = draft[e.name]; if (v !== undefined) { if (e.type === 'checkbox') e.checked = v === '1'; else if (e.tagName !== 'SELECT' || [...(e as unknown as HTMLSelectElement).options].some((o) => o.value === v)) e.value = v; e.dispatchEvent(new Event('change')); } });
  let t: ReturnType<typeof setTimeout>;
  const flush = () => { clearTimeout(t); store.setDraft(toolId, Object.fromEntries(controls.map((e) => [e.name, e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.value]))); };
  const save = () => { clearTimeout(t); t = setTimeout(flush, 300); };
  const leave = () => { flush(); root.removeEventListener('input', save); root.removeEventListener('change', save); };
  root.addEventListener('input', save); root.addEventListener('change', save);
  root.addEventListener('utility-desk:leave', leave, { once: true });
}

export function pageHeader(title: string, desc: string, ...badges: Child[]) {
  return h('header', { class: 'page-header' }, h('h1', { tabindex: -1, id: 'page-title' }, title), h('p', { class: 'muted' }, desc), badges.length ? h('div', { class: 'row' }, ...badges) : null);
}

export const privacyNote = () => notice('info', 'Everything runs in your browser. Files are never uploaded; only drafts, preferences and activity labels are stored locally.');
