import { describe, expect, it } from 'vitest';
import { validatePublicConfig } from './build-config';

function jwt(role: string): string {
  return `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
}

describe('public static build settings', () => {
  it('accepts public publishable and legacy anon keys', () => {
    for (const key of ['sb_publishable_public', jwt('anon')]) {
      expect(() => validatePublicConfig('https://example.supabase.co', key)).not.toThrow();
    }
  });

  it('rejects private, privileged, and malformed keys without exposing their contents', () => {
    for (const key of ['sb_secret_private', jwt('service_role'), jwt('authenticated'), '', 'invalid', 'header.invalid.signature']) {
      expect(() => validatePublicConfig('https://example.supabase.co', key)).toThrow(/public Supabase/);
    }
  });

  it('rejects invalid project URLs and embedded URL credentials', () => {
    for (const url of ['', 'not a URL', 'file:///tmp/project', 'https://user:password@example.test']) {
      expect(() => validatePublicConfig(url, 'sb_publishable_public')).toThrow(/project URL/);
    }
  });
});
