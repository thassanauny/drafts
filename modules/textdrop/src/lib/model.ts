export interface TextDropPage {
  id: string;
  code: string;
  text: string;
  version: number;
  updatedAt: string;
}

export const MAX_TEXT_BYTES = 1_048_576;
const PAGE_KEYS = ['id', 'code', 'text', 'version', 'updatedAt'];
const encoder = new TextEncoder();

export function validateUuid(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(input)) {
    throw new Error('The snippet ID is invalid.');
  }
  return input.toLowerCase();
}

/** Accept spaces, tabs, line breaks, and hyphens when someone copies a code. */
export function normalizeCode(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Enter the complete 32-character snippet code.');
  const normalized = input.replace(/[\u0009-\u000d\u0020-]+/g, '').toLowerCase();
  if (!/^[a-f\d]{32}$/.test(normalized)) throw new Error('Enter the complete 32-character snippet code.');
  return normalized;
}

export function textBytes(input: string): number {
  return encoder.encode(input).byteLength;
}

/** Preserve exact text; PostgreSQL text cannot store NUL or malformed Unicode. */
export function validateText(input: unknown): string {
  if (typeof input !== 'string') throw new Error('The snippet must contain text.');
  if (input.includes('\u0000') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input)) {
    throw new Error('The text contains a character that cannot be saved.');
  }
  if (textBytes(input) > MAX_TEXT_BYTES) throw new Error('A snippet supports up to 1 MiB of UTF-8 text.');
  return input;
}

function timestamp(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(input)) {
    throw new Error('The snippet update time is invalid.');
  }
  const calendar = new Date(`${input.slice(0, 10)}T00:00:00Z`);
  if (input.startsWith('0000-') || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== input.slice(0, 10) || !Number.isFinite(Date.parse(input))) {
    throw new Error('The snippet update time is invalid.');
  }
  return input;
}

export function readPage(input: unknown): TextDropPage {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The snippet must be an object.');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('The snippet must be a plain object.');
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !PAGE_KEYS.includes(key) || !descriptor || !('value' in descriptor)) {
      throw new Error('The snippet contains an unsupported field.');
    }
  }
  const page = input as Record<string, unknown>;
  if (typeof page.code !== 'string' || !/^[a-f\d]{32}$/.test(page.code)) throw new Error('The snippet code is invalid.');
  if (typeof page.version !== 'number' || !Number.isSafeInteger(page.version) || page.version < 1) throw new Error('The snippet version is invalid.');
  return {
    id: validateUuid(page.id),
    code: page.code,
    text: validateText(page.text),
    version: page.version,
    updatedAt: timestamp(page.updatedAt),
  };
}
