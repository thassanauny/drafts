import type { Cloud, TextDropPage } from './cloud';
import { validateText } from './model';

export interface SessionState {
  page: TextDropPage | null;
  draft: string;
  phase: 'home' | 'opening' | 'ready' | 'saving';
  dirty: boolean;
  online: boolean;
  error: string;
}

function newPageId(): string {
  const randomness = globalThis.crypto;
  if (typeof randomness?.randomUUID === 'function') return randomness.randomUUID();
  if (typeof randomness?.getRandomValues !== 'function') throw new Error('Secure randomness is unavailable.');
  const bytes = randomness.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Text and failed drafts stay in memory; this controller has no durable edit queue. */
export class PageSession {
  state: SessionState = {
    page: null, draft: '', phase: 'home', dirty: false, online: true, error: '',
  };
  private generation = 0;
  private edits = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveInFlight: Promise<void> | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private createId: string | undefined;
  private listeners = new Set<(state: SessionState) => void>();
  private cloud: Cloud;
  private delay: number;

  constructor(cloud: Cloud, delay = 650) {
    this.cloud = cloud;
    this.delay = delay;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener(this.state));
  }

  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.state.online && this.state.dirty && !this.state.error) {
      this.timer = setTimeout(() => { void this.save(); }, this.delay);
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Could not connect. Please try again.';
  }

  private async open(fetchPage: () => Promise<TextDropPage>): Promise<boolean> {
    const generation = ++this.generation;
    this.cancelTimer();
    this.saveInFlight = undefined;
    this.refreshInFlight = undefined;
    this.update({ page: null, draft: '', dirty: false, phase: 'opening', error: '' });
    try {
      const page = await fetchPage();
      if (generation !== this.generation) return false;
      this.update({ page, draft: page.text, phase: 'ready' });
      return true;
    } catch (error) {
      if (generation === this.generation) this.update({ phase: 'home', error: this.message(error) });
      return false;
    }
  }

  async create(): Promise<boolean> {
    try {
      this.createId ??= newPageId();
    } catch {
      this.update({ error: 'Could not create a snippet in this browser. Open the app over HTTPS or try another browser.' });
      return false;
    }
    const id = this.createId;
    const opened = await this.open(() => this.cloud.createPage(id));
    if (opened) this.createId = undefined;
    return opened;
  }

  join(code: string): Promise<boolean> {
    return this.open(() => this.cloud.joinPage(code));
  }

  home(): void {
    ++this.generation;
    this.cancelTimer();
    this.saveInFlight = undefined;
    this.refreshInFlight = undefined;
    this.update({ page: null, draft: '', dirty: false, phase: 'home', error: '' });
  }

  setOnline(online: boolean): void {
    this.update({ online, ...(!online && this.state.dirty ? {
      error: 'Your unsaved text is only in this open page. Reconnect and choose Retry save.',
    } : {}) });
    if (!online) this.cancelTimer();
    // Reconnection doesn't silently publish a failed draft. The user can retry.
  }

  edit(text: string): void {
    if (!this.state.page || !this.state.online || this.state.phase === 'opening') return;
    ++this.edits;
    let error = '';
    try { validateText(text); } catch (reason) { error = this.message(reason); }
    this.update({ draft: text, dirty: true, error });
    this.schedule();
  }

  private remember(page: TextDropPage): void {
    const current = this.state.page;
    if (!current || current.id !== page.id || page.version <= current.version) return;
    this.update({ page, ...(!this.state.dirty ? { draft: page.text } : {}) });
  }

  refresh(): Promise<void> {
    const page = this.state.page;
    const generation = this.generation;
    if (!page || !this.state.online) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const request = Promise.resolve().then(async () => {
      try {
        if (generation !== this.generation || !this.state.online) return;
        const remote = await this.cloud.loadPage(page.id);
        if (generation !== this.generation) return;
        this.remember(remote);
        if (!this.state.dirty && this.state.phase === 'ready') this.update({ error: '' });
      } catch (error) {
        // A save completed after this poll began already confirmed a newer
        // server version. An older failed read must not replace that status.
        if (generation === this.generation && !this.state.dirty && this.state.page?.version === page.version) {
          this.update({ error: this.message(error) });
        }
      } finally {
        if (this.refreshInFlight === request) this.refreshInFlight = undefined;
      }
    });
    this.refreshInFlight = request;
    return request;
  }

  save(): Promise<void> {
    this.cancelTimer();
    if (this.saveInFlight) return this.saveInFlight;
    if (!this.state.page || !this.state.dirty || !this.state.online) return Promise.resolve();
    try { validateText(this.state.draft); } catch (error) {
      this.update({ error: this.message(error) });
      return Promise.resolve();
    }
    const generation = this.generation;
    const edit = this.edits;
    const page = this.state.page;
    const text = this.state.draft;
    this.update({ phase: 'saving', error: '' });
    const request = Promise.resolve().then(async () => {
      try {
        if (generation !== this.generation) return;
        if (!this.state.online) {
          this.update({ phase: 'ready' });
          return;
        }
        const saved = await this.cloud.savePage(page.id, text);
        if (generation !== this.generation) return;
        this.remember(saved);
        if (edit === this.edits) {
          // A newer poll may have arrived before this response. Keep that version.
          this.update({ dirty: false, draft: this.state.page!.text, phase: 'ready', error: '' });
        } else {
          this.update({ phase: 'ready' });
        }
      } catch (error) {
        if (generation === this.generation) {
          this.update({ phase: 'ready', error: this.message(error) });
        }
      } finally {
        if (generation === this.generation) {
          this.saveInFlight = undefined;
          this.schedule();
        }
      }
    });
    this.saveInFlight = request;
    return request;
  }

  dispose(): void {
    ++this.generation;
    this.cancelTimer();
    this.saveInFlight = undefined;
    this.refreshInFlight = undefined;
    this.listeners.clear();
  }
}
