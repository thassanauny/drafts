/** Parse "1-3, 5, 8-" into sorted unique 1-based page numbers. Throws on invalid input. */
export function parsePageRanges(input: string, total: number, ordered = false): number[] {
  const text = input.trim();
  if (!text) return Array.from({ length: total }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of text.split(',')) {
    const p = part.trim();
    if (!p) throw new Error('Empty page selection');
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(p);
    if (!m || (!m[1] && !m[3])) throw new Error(`Invalid page range "${p}"`);
    let start: number, end: number;
    if (!m[2]) { start = end = Number(m[1]); }
    else { start = m[1] ? Number(m[1]) : 1; end = m[3] ? Number(m[3]) : total; }
    if (start < 1 || end < 1 || start > total || end > total) throw new Error(`Range "${p}" is outside 1-${total}`);
    if (start > end) throw new Error(`Range "${p}" is reversed`);
    for (let i = start; i <= end; i++) {
      if (out.length >= 1000) throw new Error('Select at most 1,000 pages.');
      out.push(i);
    }
  }
  if (!out.length) throw new Error('No pages selected');
  return ordered ? out : [...new Set(out)].sort((a, b) => a - b);
}
