import { describe, expect, it } from 'vitest';
import { invitationLink, joinCode, pageHash, readRoute } from './routes';

const code = '0123456789abcdef0123456789abcdef';
describe('snippet invitations on any static hosting path', () => {
  it('uses hash routing and preserves the host path', () => {
    expect(pageHash(code)).toBe(`#/p/${code}`);
    expect(invitationLink(code, 'https://example.test/apps/textdrop/?query=old#/')).toBe(`https://example.test/apps/textdrop/#/join/${code}`);
    expect(readRoute(`#/p/${code}`)).toEqual({ kind: 'page', code });
    expect(readRoute(`#/join/${code}`)).toEqual({ kind: 'join', code });
    expect(readRoute('')).toEqual({ kind: 'home' });
    expect(readRoute('#/')).toEqual({ kind: 'home' });
  });
  it('accepts formatted codes and invitation links', () => {
    expect(joinCode('01234567-89AB-CDEF-0123-456789ABCDEF\n')).toBe(code);
    expect(joinCode(`https://example.test/textdrop/#/p/${code}`)).toBe(code);
    expect(joinCode(`https://example.test/textdrop/#/join/${code}`)).toBe(code);
    expect(readRoute(`#/p/%20${code.toUpperCase()}%20`)).toEqual({ kind: 'page', code });
  });
  it('rejects partial codes, malformed encoding and unrelated links', () => {
    expect(readRoute('#/p/short')).toEqual({ kind: 'invalid' });
    expect(readRoute('#/p/%zz')).toEqual({ kind: 'invalid' });
    expect(readRoute('#/join/%zz')).toEqual({ kind: 'invalid' });
    expect(readRoute(`#/p/${code}/extra`)).toEqual({ kind: 'invalid' });
    expect(() => joinCode('https://example.test/#/')).toThrow(/does not contain/);
    expect(() => joinCode('javascript:alert(1)')).toThrow();
  });
});
