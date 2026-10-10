import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlockPdf } from '../src/lib/pdfUnlock';

async function sourcePdf() {
  const pdf = await PDFDocument.create(); pdf.setTitle('Original title');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([240, 320]).drawText('Original selectable text', { font, size: 12, x: 20, y: 290 });
  pdf.addPage([400, 500]);
  const field = pdf.getForm().createTextField('name'); field.setText('Preserved form value'); field.addToPage(pdf.getPage(1), { x: 20, y: 20, width: 200, height: 20 });
  return pdf.save();
}

describe('PDF unlocking validation', () => {
  it('preserves an already unlocked PDF byte for byte', async () => {
    const bytes = await sourcePdf(); const result = await unlockPdf(bytes, '');
    expect(result.alreadyUnlocked).toBe(true); expect(result.bytes).toBe(bytes); expect(result.pages).toBe(2);
  });
  it('rejects invalid and empty documents and honours cancellation', async () => {
    await expect(unlockPdf(new Uint8Array([1, 2]), '')).rejects.toThrow(/valid PDF/);
    const empty = await PDFDocument.create();
    await expect(unlockPdf(await empty.save({ addDefaultPage: false }), '')).rejects.toThrow(/1,000/);
    const controller = new AbortController(); controller.abort();
    await expect(unlockPdf(await sourcePdf(), '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

const qpdfAvailable = spawnSync('qpdf', ['--version']).status === 0;
describe.skipIf(!qpdfAvailable)('qpdf encrypted PDF interoperability', () => {
  for (const encryption of [ ['128', '--use-aes=y'], ['256'], ['256', '--force-R5'], ['128', '--use-aes=n', '--allow-weak-crypto'] ]) {
    it(`unlocks ${encryption.join(' ')} without losing forms, metadata or pages`, async () => {
      const folder = mkdtempSync(join(tmpdir(), 'utility-unlock-'));
      try {
        const input = join(folder, 'original.pdf'), encrypted = join(folder, 'encrypted.pdf'), output = join(folder, 'unlocked.pdf');
        writeFileSync(input, await sourcePdf());
        const weak = encryption.includes('--allow-weak-crypto');
        execFileSync('qpdf', [...(weak ? ['--allow-weak-crypto'] : []), '--encrypt', 'correct password', 'owner password', ...encryption.filter((arg) => arg !== '--allow-weak-crypto'), '--', input, encrypted]);
        const original = readFileSync(encrypted);
        await expect(unlockPdf(original, 'wrong secret')).rejects.toThrow(/password/i);
        for (const password of ['correct password', 'owner password']) {
          const result = await unlockPdf(original, password);
          expect(result.alreadyUnlocked).toBe(false); expect(result.pages).toBe(2);
          const doc = await PDFDocument.load(result.bytes);
          expect(doc.isEncrypted).toBe(false); expect(doc.getTitle()).toBe('Original title');
          expect(doc.getPages().map((page) => page.getSize())).toEqual([{ width: 240, height: 320 }, { width: 400, height: 500 }]);
          expect(doc.getForm().getTextField('name').getText()).toBe('Preserved form value');
          writeFileSync(output, result.bytes); execFileSync('qpdf', ['--check', output]);
          expect(readFileSync(encrypted)).toEqual(original);
        }
      } finally { rmSync(folder, { recursive: true, force: true }); }
    });
  }
  it('unlocks empty opening-password PDFs using an empty password', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'utility-unlock-empty-'));
    try {
      const input = join(folder, 'original.pdf'), encrypted = join(folder, 'encrypted.pdf'); writeFileSync(input, await sourcePdf());
      execFileSync('qpdf', ['--encrypt', '', 'owner', '256', '--', input, encrypted]);
      const result = await unlockPdf(readFileSync(encrypted), '');
      expect(result.alreadyUnlocked).toBe(false); expect((await PDFDocument.load(result.bytes)).isEncrypted).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
