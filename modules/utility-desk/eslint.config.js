import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', URL: 'readonly', Blob: 'readonly', File: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly', process: 'readonly', location: 'readonly', HTMLElement: 'readonly', Worker: 'readonly', indexedDB: 'readonly', WebAssembly: 'readonly', Intl: 'readonly', crypto: 'readonly', DOMParser: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', DOMException: 'readonly', Image: 'readonly', requestAnimationFrame: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', FileReader: 'readonly', XMLSerializer: 'readonly', HTMLInputElement: 'readonly', Event: 'readonly', MouseEvent: 'readonly', DragEvent: 'readonly', ImageBitmap: 'readonly', HTMLCanvasElement: 'readonly', Node: 'readonly', Element: 'readonly', createImageBitmap: 'readonly', fetch: 'readonly', globalThis: 'readonly', HTMLTextAreaElement: 'readonly', HTMLSelectElement: 'readonly', OffscreenCanvas: 'readonly', ImageData: 'readonly' } },
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error' },
  },
);
