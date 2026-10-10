import type { UnlockResult } from './pdfUnlock';
import { throwIfAborted } from './util';

export function unlockPdfInWorker(bytes: Uint8Array, password: string, signal: AbortSignal): Promise<UnlockResult> {
  throwIfAborted(signal);
  if (typeof Worker === 'undefined') throw new Error('PDF unlocking needs a browser with Web Workers.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdfUnlock.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ result?: UnlockResult; error?: string }>) => {
      finish();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || 'Could not unlock this PDF.'));
    };
    worker.onerror = () => { finish(); reject(new Error('The PDF worker could not run. Reload the page and try again.')); };
    try { worker.postMessage({ bytes, password }, [bytes.buffer]); }
    catch { finish(); reject(new Error('Could not start PDF unlocking.')); }
  });
}
