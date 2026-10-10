import { normalizeCode } from './model';

export type Route = { kind: 'home' } | { kind: 'page' | 'join'; code: string } | { kind: 'invalid' };

export function readRoute(hash: string): Route {
  if (!hash || hash === '#' || hash === '#/') return { kind: 'home' };
  const kind = hash.startsWith('#/p/') ? 'page' : hash.startsWith('#/join/') ? 'join' : null;
  if (!kind) return { kind: 'invalid' };
  try {
    return { kind, code: normalizeCode(decodeURIComponent(hash.slice(kind === 'join' ? 7 : 4))) };
  } catch { return { kind: 'invalid' }; }
}

export function joinCode(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const route = readRoute(new URL(trimmed).hash);
    if (route.kind === 'page' || route.kind === 'join') return route.code;
    throw new Error('That link does not contain a snippet code. Copy the invitation link again.');
  }
  return normalizeCode(trimmed);
}

export function pageHash(code: string): string { return `#/p/${normalizeCode(code)}`; }

export function invitationLink(code: string, currentUrl: string): string {
  const url = new URL(currentUrl);
  url.search = '';
  url.hash = `#/join/${normalizeCode(code)}`;
  return url.href;
}
