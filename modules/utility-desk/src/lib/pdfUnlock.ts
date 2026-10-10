import { PDFDocument } from '@cantoo/pdf-lib';
import { MAX_FILE_BYTES, throwIfAborted } from './util';

export interface UnlockResult { bytes: Uint8Array; pages: number; alreadyUnlocked: boolean }

export async function unlockPdf(bytes: Uint8Array, password: string, signal?: AbortSignal): Promise<UnlockResult> {
  throwIfAborted(signal);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('PDF unlocking accepts files up to 200 MB.');
  let doc: PDFDocument;
  let alreadyUnlocked: boolean;
  try {
    // The initial parser must tolerate encrypted object streams before decryption.
    const options = { updateMetadata: false, preserveXFA: true };
    const original = await PDFDocument.load(bytes, { ...options, ignoreEncryption: true });
    doc = original;
    alreadyUnlocked = !doc.isEncrypted;
    throwIfAborted(signal);
    if (!alreadyUnlocked) {
      doc = await PDFDocument.load(bytes, { ...options, password });
      // Keep original trailer references: decryption can lose /Info on xref-stream PDFs.
      doc.context.trailerInfo.Info = original.context.trailerInfo.Info;
      doc.context.trailerInfo.ID = original.context.trailerInfo.ID?.clone(doc.context);
    }
  }
  catch (error) {
    throwIfAborted(signal);
    const message = (error as Error).message;
    throw new Error(/password/i.test(message) ? 'The password is incorrect or missing. Check it and try again.'
      : /unsupported|encrypt|security handler/i.test(message) ? 'This PDF uses encryption that this browser tool cannot unlock.' : 'Could not read this PDF. Choose a valid PDF file.');
  }
  const pages = doc.getPageCount();
  if (!pages || pages > 1000) throw new Error('Choose a PDF with between 1 and 1,000 pages.');
  throwIfAborted(signal);
  // Decryption removes /Encrypt. An existing unencrypted source needs no rewrite.
  const result = alreadyUnlocked ? bytes : await doc.save({ updateFieldAppearances: false, addDefaultPage: false });
  throwIfAborted(signal);
  return { bytes: result, pages, alreadyUnlocked };
}
