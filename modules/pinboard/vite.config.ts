import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { validatePublicConfig } from './build-config.ts';

export default defineConfig(({ mode, command }) => {
  const testing = process.env.VITEST === 'true' && mode === 'test' && command !== 'build';
  // Reuse publishing's shared public settings; this app can override either value.
  const shared = loadEnv(mode, resolve(process.cwd(), '../../publishing'), 'VITE_');
  const local = loadEnv(mode, process.cwd(), 'VITE_');
  const url =
    process.env.VITE_SUPABASE_URL !== undefined
      ? process.env.VITE_SUPABASE_URL.trim()
      : local.VITE_SUPABASE_URL?.trim() || shared.VITE_SUPABASE_URL?.trim() || '';
  const key =
    process.env.VITE_SUPABASE_ANON_KEY !== undefined
      ? process.env.VITE_SUPABASE_ANON_KEY.trim()
      : local.VITE_SUPABASE_ANON_KEY?.trim() || shared.VITE_SUPABASE_ANON_KEY?.trim() || '';
  if (command === 'build' && (!url || !key)) {
    throw new Error(
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in this app or the shared publishing settings before building Pinboard.',
    );
  }
  if (!testing && (url || key)) validatePublicConfig(url, key);
  return {
    base: './',
    plugins: [react()],
    define:
      testing
        ? undefined
        : {
            'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url),
            'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(key),
          },
    server: { host: '127.0.0.1', port: 5174 },
    preview: { host: '127.0.0.1', port: 4174 },
    test: { include: ['src/**/*.test.{ts,tsx}', '*.test.ts'] },
  };
});
