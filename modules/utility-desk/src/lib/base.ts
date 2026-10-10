/** Resolve the Vite `base` for GitHub Pages. Relative base works for any subpath; hash routing needs no server rewrites. */
export function resolveBase(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v || v === './' || v === '.') return './';
  const withLead = v.startsWith('/') ? v : `/${v}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}
