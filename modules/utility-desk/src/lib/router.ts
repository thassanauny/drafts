export const ROUTES = ['dashboard', 'date-time', 'folder-sync', 'media-downloader', 'secure-copy', 'media-converter', 'document-converter', 'pdf-to-images', 'images-to-pdf', 'merge-pdfs', 'split-pdf', 'compress-pdf', 'unlock-pdf', 'qr-generator', 'image-workshop', 'crop-image', 'compress-image'] as const;
export type RouteId = (typeof ROUTES)[number];

/** Hash routing: "#/merge-pdfs" -> "merge-pdfs". Unknown -> "notfound". Empty -> dashboard. */
export function parseHash(hash: string): RouteId | 'notfound' {
  const id = hash.replace(/^#\/?/, '').split(/[?/]/)[0].trim();
  if (!id) return 'dashboard';
  return (ROUTES as readonly string[]).includes(id) ? (id as RouteId) : 'notfound';
}
export const hrefFor = (id: RouteId) => (id === 'dashboard' ? '#/' : `#/${id}`);
