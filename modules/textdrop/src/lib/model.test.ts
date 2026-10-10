import { describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES, normalizeCode, readPage, textBytes, validateText, validateUuid } from './model';

const page = {
  id: '22222222-2222-4222-8222-222222222222', code: 'a'.repeat(32),
  text: 'A shared note\nবাংলা 😀', version: 1, updatedAt: '2026-10-10T01:02:03.123456+00:00',
};

describe('snippet data and limits', () => {
  it('normalizes uppercase complete codes with ASCII whitespace and hyphens', () => {
    expect(normalizeCode(` \t${'A'.repeat(8)}-${'A'.repeat(8)}\n${'A'.repeat(16)}\r\f\v`)).toBe(page.code);
    expect(() => normalizeCode('abcd')).toThrow('32-character');
    expect(() => normalizeCode('g'.repeat(32))).toThrow('32-character');
    expect(() => normalizeCode(null)).toThrow('32-character');
    expect(() => normalizeCode(`${page.code}\u00a0`)).toThrow('32-character');
  });

  it('normalizes UUIDs and rejects ID-like arbitrary strings', () => {
    expect(validateUuid('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(() => validateUuid('not-a-snippet')).toThrow('ID');
  });

  it('preserves blank text, indentation, line endings, markup, and Unicode literally', () => {
    const text = '\t<script>alert(1)</script>\r\nবাংলা 😀  \n';
    expect(validateText(text)).toBe(text);
    expect(validateText('')).toBe('');
    expect(textBytes('😀')).toBe(4);
    expect(textBytes('é')).toBe(2);
  });

  it('uses the UTF-8 byte limit instead of character or UTF-16 count', () => {
    expect(validateText('x'.repeat(MAX_TEXT_BYTES))).toHaveLength(MAX_TEXT_BYTES);
    expect(validateText('😀'.repeat(MAX_TEXT_BYTES / 4))).toHaveLength(MAX_TEXT_BYTES / 2);
    expect(() => validateText(`${'😀'.repeat(MAX_TEXT_BYTES / 4)}x`)).toThrow('1 MiB');
    expect(() => validateText('é'.repeat(MAX_TEXT_BYTES / 2 + 1))).toThrow('1 MiB');
  });

  it('rejects characters PostgreSQL text cannot preserve', () => {
    for (const text of ['\u0000', 'start\ud800end', '\udc00']) {
      expect(() => validateText(text)).toThrow('cannot be saved');
    }
    expect(() => validateText(42)).toThrow('must contain text');
  });

  it('reads only bounded server records with safe monotonic versions and real timestamps', () => {
    expect(readPage(page)).toEqual(page);
    expect(readPage(page)).not.toBe(page);
    for (const invalid of [
      { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { version: '1' },
      { updatedAt: '2026-02-30T01:02:03Z' }, { updatedAt: '2026-10-10' },
      { updatedAt: '2026-10-10T24:00:00Z' }, { text: null }, { code: 'A'.repeat(32) },
      { extra: true },
    ]) {
      expect(() => readPage({ ...page, ...invalid })).toThrow();
    }
    expect(() => readPage([page])).toThrow('object');
    expect(() => readPage(Object.create(page))).toThrow('plain object');
    const getter = Object.defineProperty({ ...page }, 'text', { get: () => { throw new Error('getter ran'); } });
    expect(() => readPage(getter)).toThrow('unsupported field');
  });
});
