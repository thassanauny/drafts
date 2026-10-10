import { describe, it, expect } from 'vitest';

describe('tool pages mount', () => {
  for (const id of ['dateTime', 'folderSync', 'documentConverter', 'imagesToPdf', 'mergePdfs', 'splitPdf', 'compressPdf', 'unlockPdf', 'qrGenerator', 'imageWorkshop', 'cropImage', 'compressImage']) {
    it(`renders ${id} with shared layout`, async () => {
      document.body.innerHTML = '<main id="m"></main>';
      const root = document.getElementById('m')!;
      const mod = await import(`../src/tools/${id}.ts`);
      const cleanup = mod.mount(root);
      expect(root.querySelector('h1')).toBeTruthy();
      expect(root.querySelector('.page-heading .tool-mark')).toBeTruthy();
      expect(root.querySelectorAll('.side-panels .panel').length).toBeGreaterThan(0);
      if (typeof cleanup === 'function') cleanup();
    });
  }
});
