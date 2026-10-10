import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { throwIfAborted } from './util';

// pdf-lib's delimiter fallback can consume a stream's final CR/LF when /Length
// is a forward reference. Recover only bytes verified against the original PDF.
export async function restoreStreamLengths(doc: PDFDocument, original: Uint8Array, signal?: AbortSignal) {
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    throwIfAborted(signal);
    if (!(object instanceof PDFRawStream)) continue;
    const length = object.dict.lookup(PDFName.of('Length'));
    const contents = object.getContents();
    if (!(length instanceof PDFNumber) || length.asNumber() === contents.length) continue;
    const expected = length.asNumber(), missing = expected - contents.length;
    const failure = () => new Error('Could not read a complete PDF stream. Its declared length does not match the source data.');
    if (!contents.length || !Number.isInteger(expected) || missing < 1 || missing > 2) throw failure();
    let recovered: Uint8Array | undefined;
    let checkpoint = 0;
    let comparisons = 0;
    for (let start = original.indexOf(contents[0]); start >= 0; start = original.indexOf(contents[0], start + 1)) {
      if (start - checkpoint >= 1024 * 1024) {
        checkpoint = start;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        throwIfAborted(signal);
      }
      if (start + expected > original.length) break;
      const end = start + expected;
      let matches = true;
      for (let i = start + contents.length; i < end; i++) if (original[i] !== 10 && original[i] !== 13) matches = false;
      let marker = end;
      while (original[marker] === 10 || original[marker] === 13) marker++;
      if (!matches || ![101, 110, 100, 115, 116, 114, 101, 97, 109].every((byte, i) => original[marker + i] === byte)) continue;
      for (let i = 0; i < contents.length; i++) {
        if (++comparisons > original.length * 4) throw failure();
        if (original[start + i] !== contents[i]) { matches = false; break; }
      }
      if (!matches) continue;
      const candidate = original.slice(start, end);
      if (recovered && candidate.some((byte, i) => byte !== recovered![i])) throw failure();
      recovered = candidate;
    }
    if (!recovered) throw failure();
    doc.context.assign(ref, PDFRawStream.of(object.dict.clone(doc.context), recovered));
  }
}
