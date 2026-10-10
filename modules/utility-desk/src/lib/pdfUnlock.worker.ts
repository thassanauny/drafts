import { unlockPdf } from './pdfUnlock';

self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; password: string }>) => {
  try {
    const result = await unlockPdf(event.data.bytes, event.data.password);
    self.postMessage({ result }, { transfer: [result.bytes.buffer] });
  } catch (error) { self.postMessage({ error: (error as Error).message }); }
};
