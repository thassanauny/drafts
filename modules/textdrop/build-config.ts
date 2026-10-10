/** Validate before Vite can embed settings into a public static bundle. */
export function validatePublicConfig(url: string, key: string): void {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch {
    throw new Error('TextDrop requires a valid Supabase project URL.');
  }
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return;
  try {
    const pieces = key.split('.');
    if (pieces.length === 3 && JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString()).role === 'anon') return;
  } catch { /* A malformed key is never included in the output. */ }
  throw new Error('TextDrop requires a public Supabase publishable or anon key. Secret and service_role keys cannot be exposed by this app.');
}
