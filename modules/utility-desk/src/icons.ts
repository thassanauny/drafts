// App-owned outline icons selected for these utilities.
const shapes: Record<string, string> = {
  'home': '<path d="M3 10 12 3l9 7 M5 9v12h5v-7h4v7h5V9"/>',
  'media-converter': '<rect x="2" y="3" width="13" height="11" rx="2"/><path d="m6 6 5 2.5-5 2.5Z M19 9v10m0-10 3-1v9"/><circle cx="17" cy="19" r="2"/><circle cx="20" cy="17" r="2"/>',
  'document-converter': '<path d="M6 2.5h9l4 4V21H6Z M15 2.5v4h4"/><path d="M9 11h7m-2-2 2 2-2 2 M16 17H9m2-2-2 2 2 2"/>',
  'image-workshop': '<rect x="3" y="6" width="15" height="15" rx="2"/><circle cx="7" cy="10" r="1"/><path d="m4 18 5-5 4 4 2-2 3 3 m0-16 1.4 3.6L23 7l-3.6 1.4L18 12l-1.4-3.6L13 7l3.6-1.4Z"/>',
  'crop-image': '<path d="M6 2v16h16 M2 6h16v16 M9 6h9v9 m-9-1 4-4 5 5"/><circle cx="11" cy="9" r="1"/>',
  'compress-image': '<rect x="2" y="3" width="12" height="14" rx="1"/><circle cx="6" cy="7" r="1"/><path d="m3 14 4-4 3 3 3-2 M17 7h5m-2-2 2 2-2 2"/><rect x="17" y="13" width="5" height="7" rx="1"/>',
  'pdf-to-images': '<path d="M3 3h7v11H3Z M5 6h3m-3 3h3 M11 8h7m-2-2 2 2-2 2"/><rect x="11" y="13" width="10" height="8" rx="1"/><circle cx="14" cy="15.5" r="0.6"/><path d="m12 20 3-3 2 2 2-2 2 3"/>',
  'images-to-pdf': '<rect x="3" y="3" width="10" height="8" rx="1"/><circle cx="6" cy="5.5" r="0.6"/><path d="m4 10 3-3 2 2 2-1 2 2 M5 16h7m-3-3 3 3-3 3 M14 12h5l2 2v7h-7Z M19 12v3h2"/>',
  'merge-pdfs': '<path d="M4 3H2v7h6V3H6 M18 3h-2v7h6V3h-2 M5 10v4h14v-4 M12 14v7m-3-3 3 3 3-3"/>',
  'split-pdf': '<path d="M12 22V12 M12 12 4 4m0 5V4h5 M12 12l8-8m-5 0h5v5"/>',
  'compress-pdf': '<path d="M3 3h9v17H3Z M14 8h7m-2-2 2 2-2 2"/><rect x="16" y="13" width="6" height="8" rx="0"/>',
  'unlock-pdf': '<path d="M4 3h8l3 3v11H4Z M12 3v3h3"/><rect x="12" y="13" width="10" height="9" rx="1"/><path d="M15 13v-3a3 3 0 0 1 6 0"/><circle cx="17" cy="17" r="1"/><path d="M17 18v1"/>',
  'date-time': '<rect x="3" y="5" width="15" height="15" rx="2"/><path d="M3 9h15 M7 3v4 M14 3v4"/><circle cx="17" cy="17" r="5"/><path d="M17 14v3l2 1"/>',
  'qr-generator': '<rect x="3" y="3" width="6" height="6" rx="0"/><rect x="15" y="3" width="6" height="6" rx="0"/><rect x="3" y="15" width="6" height="6" rx="0"/><path d="M5 5h2v2H5Z M17 5h2v2h-2Z M5 17h2v2H5Z M12 3v3m0 3v3H9m-6 0h3 M12 15v6m3-9h6m-6 3h3v3h3v3h-6m6-6v-3"/>',
};

export function icon(value: string): SVGSVGElement | string {
  const shape = shapes[value];
  if (!shape) return value;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'utility-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.65');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = shape;
  return svg;
}
