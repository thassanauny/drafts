import { defineConfig, type Plugin } from 'vite';
import { resolveBase } from './src/lib/base';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfAssets = (): Plugin => ({
  name: 'utility-desk-pdf-assets',
  generateBundle() {
    for (const dir of ['cmaps', 'standard_fonts']) for (const file of readdirSync(join(pdfRoot, dir))) {
      this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${file}`, source: readFileSync(join(pdfRoot, dir, file)) });
    }
  },
});

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'";

/** Production-only CSP so the dev server's HMR socket keeps working. */
const csp = (): Plugin => ({
  name: 'utility-desk-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  base: resolveBase((globalThis as any).process?.env?.BASE_PATH),
  // Keep active dev-server modules intact when Make refreshes node_modules.
  cacheDir: '.vite',
  plugins: [csp(), pdfAssets()],
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
} as import('vite').UserConfig & { test: unknown });
