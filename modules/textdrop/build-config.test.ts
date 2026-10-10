import { describe, expect, it } from 'vitest';
import { validatePublicConfig } from './build-config';

function jwt(role: string): string {
  return `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
}

describe('public static build configuration', () => {
  it('accepts public publishable and legacy anon keys', () => {
    expect(() => validatePublicConfig('https://example.supabase.co', 'sb_publishable_public')).not.toThrow();
    expect(() => validatePublicConfig('https://example.supabase.co', jwt('anon'))).not.toThrow();
  });
  it('rejects secrets before they can be embedded in a static bundle', () => {
    for (const key of ['sb_secret_private', jwt('service_role'), jwt('authenticated'), '', 'invalid']) {
      expect(() => validatePublicConfig('https://example.supabase.co', key)).toThrow(/public Supabase/);
    }
  });
  it('rejects invalid and credential-bearing project URLs', () => {
    for (const url of ['', 'not a URL', 'file:///tmp/project', 'https://user:password@example.test']) {
      expect(() => validatePublicConfig(url, 'sb_publishable_public')).toThrow(/project URL/);
    }
  });
});
