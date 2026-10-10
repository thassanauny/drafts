import { createClient, navigatorLock, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeCode, readPage, validateText, validateUuid, type TextDropPage } from './model';
import { migrateLegacyAuthStorage, TEXTDROP_AUTH_KEY } from './authStorage';

export type { TextDropPage } from './model';

export interface Cloud {
  createPage(id: string): Promise<TextDropPage>;
  joinPage(code: string): Promise<TextDropPage>;
  loadPage(id: string): Promise<TextDropPage>;
  savePage(id: string, text: string): Promise<TextDropPage>;
}

interface ServiceError {
  code?: string;
  message?: string;
}

function ensureOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('You are offline. Reconnect before opening or saving a snippet.');
  }
}

function serviceError(error: ServiceError, action: string): Error {
  if (error.message === 'TEXTDROP_INVALID_CODE') return new Error('That snippet code was not found. Check the code and try again.');
  if (error.message === 'TEXTDROP_ACCESS_DENIED') return new Error('You no longer have access to this snippet. Join again using its code.');
  if (error.message === 'TEXTDROP_PAGE_LIMIT') return new Error('This browser session has reached the supported number of shared snippets.');
  if (error.message === 'TEXTDROP_VERSION_LIMIT') return new Error('This snippet has reached its supported number of saves. Create a new snippet.');
  if (error.message === 'TEXTDROP_INVALID_TEXT') return new Error('A snippet supports up to 1 MiB of UTF-8 text.');
  if (error.message === 'TEXTDROP_INVALID_PAGE') return new Error('The snippet ID is invalid. Create a new snippet and try again.');
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01' || error.code === '42883') {
    return new Error('TextDrop needs database setup. Use supabase/upgrade-to-textdrop.sql for an earlier installation or supabase/schema.sql for a new project; see webapps/everydayapps/apps/textdrop/supabase/README.md.');
  }
  if (/anonymous.*(?:disabled|not allowed)|anonymous_provider_disabled/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
    return new Error('Enable anonymous sign-ins in Supabase Authentication to share text snippets.');
  }
  if (error.message === 'TEXTDROP_AUTH_REQUIRED' || error.code === 'PGRST301' || error.code === 'PGRST303') {
    return new Error('Your TextDrop session could not be verified. Reload the app and try again.');
  }
  if (/fetch|network|connection|failed to send|load failed/i.test(error.message ?? '')) {
    return new Error('Could not connect to shared snippets. Check your connection and try again.');
  }
  return new Error(`Could not ${action}. ${error.message || 'Please try again.'}`);
}

async function call<T>(action: string, attempt: () => PromiseLike<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const details = error && typeof error === 'object' ? error as ServiceError : {};
    throw serviceError(details, action);
  }
}

function privateKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  try {
    const encoded = key.split('.')[1];
    return Boolean(encoded && JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role');
  } catch {
    return false;
  }
}

/** Persist only the anonymous session. Page content always comes from Supabase. */
export function createCloud(url: string, key: string): Cloud {
  const projectUrl = url.trim();
  const publicKey = key.trim();
  let client: SupabaseClient | undefined;
  let authentication: Promise<void> | undefined;

  function getClient(): SupabaseClient {
    if (!projectUrl || !publicKey) throw new Error('Text sharing is not configured. Add the public Supabase settings and rebuild the app.');
    if (privateKey(publicKey)) throw new Error('Use the Supabase public anon or publishable key for text sharing.');
    if (!client) {
      try {
        client = createClient(projectUrl, publicKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: TEXTDROP_AUTH_KEY,
            ...(globalThis.navigator?.locks ? { lock: navigatorLock } : {}) },
        });
      } catch {
        throw new Error('The Supabase settings are invalid. Check the project URL and public API key.');
      }
    }
    return client;
  }

  async function initialize(): Promise<void> {
    ensureOnline();
    if (!authentication) {
      authentication = (async () => {
        await migrateLegacyAuthStorage();
        const supabase = getClient();
        const { data, error } = await call('restore your TextDrop session', () => supabase.auth.getSession());
        if (error) throw serviceError(error, 'restore your TextDrop session');
        if (data.session) return;
        ensureOnline();
        const result = await call('start your TextDrop session', () => supabase.auth.signInAnonymously());
        if (result.error) throw serviceError(result.error, 'start your TextDrop session');
        if (!result.data.session) throw new Error('Supabase did not create a TextDrop session. Please try again.');
      })().finally(() => { authentication = undefined; });
    }
    await authentication;
    ensureOnline();
  }

  async function rpc(action: string, name: string, args: Record<string, string>): Promise<TextDropPage> {
    await initialize();
    const { data, error } = await call(action, () => getClient().rpc(name, args));
    if (error) throw serviceError(error, action);
    try {
      return readPage(data);
    } catch {
      throw new Error('The server returned invalid snippet data. Refresh the app or check the database setup.');
    }
  }

  async function byId(action: string, name: string, id: string, text?: string): Promise<TextDropPage> {
    const pageId = validateUuid(id);
    const args: Record<string, string> = { p_id: pageId };
    if (text !== undefined) args.p_text = text;
    const page = await rpc(action, name, args);
    if (page.id !== pageId) throw new Error('The server returned a different snippet. Refresh the app and try again.');
    return page;
  }

  return {
    createPage: (id) => byId('create the snippet', 'textdrop_create_page', id),
    joinPage: async (code) => {
      const normalized = normalizeCode(code);
      const page = await rpc('join the snippet', 'textdrop_join_page', { p_code: normalized });
      if (page.code !== normalized) throw new Error('The server returned a different code. Check the code and try again.');
      return page;
    },
    loadPage: (id) => byId('load the snippet', 'textdrop_load_page', id),
    savePage: async (id, text) => byId('save the snippet', 'textdrop_save_page', id, validateText(text)),
  };
}
