import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

function isPublicSupabaseKey(key: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true
  try {
    const pieces = key.split('.')
    return pieces.length === 3 && JSON.parse(Buffer.from(pieces[1], 'base64url').toString()).role === 'anon'
  } catch {
    return false
  }
}

export default defineConfig(({ mode, command }) => {
  const testing = process.env.VITEST === 'true' && mode === 'test' && command !== 'build'
  const shared = loadEnv(mode, resolve(process.cwd(), '../../publishing'), 'VITE_')
  const env = loadEnv(mode, process.cwd(), '')
  const supabaseUrl = process.env.VITE_SUPABASE_URL !== undefined
    ? process.env.VITE_SUPABASE_URL.trim()
    : env.VITE_SUPABASE_URL?.trim() || shared.VITE_SUPABASE_URL?.trim() || ''
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY !== undefined
    ? process.env.VITE_SUPABASE_ANON_KEY.trim()
    : env.VITE_SUPABASE_ANON_KEY?.trim() || shared.VITE_SUPABASE_ANON_KEY?.trim() || ''
  if (command === 'build' && (!supabaseUrl || !supabaseKey)) {
    throw new Error("iou production builds require VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Set both in the app's .env.local, shared ../../publishing/.env.local, or build environment before publishing.")
  }
  if (!testing && supabaseKey && !isPublicSupabaseKey(supabaseKey)) {
    throw new Error('iou requires a public Supabase publishable or anon key. Secret and service_role keys cannot be exposed by this app.')
  }
  const cloudBuild: Plugin = {
    name: 'iou-cloud-build',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      if (!options.dir) this.error('iou cloud verification requires a build output directory.')
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk')
        .map((chunk) => ({ fileName: chunk.fileName, code: readFileSync(join(options.dir!, chunk.fileName), 'utf8') }))
      if (!chunks.some((chunk) => chunk.code.includes(supabaseUrl) && chunk.code.includes(supabaseKey))) {
        this.error('The built iou app does not contain its Supabase connection settings.')
      }
      writeFileSync(join(options.dir, 'cloud-build.json'), JSON.stringify({
          format: 1,
          app: 'iou',
          cloudConfigured: true,
          scripts: Object.fromEntries(chunks.map((chunk) => [chunk.fileName, createHash('sha256').update(chunk.code).digest('hex')])),
        }, null, 2) + '\n')
    },
  }
  const configuredBase = env.VITE_BASE_PATH?.trim() || './'
  if (configuredBase !== './' && (!configuredBase.startsWith('/') || configuredBase.includes('//') || configuredBase.split('/').some((part) => part === '.' || part === '..' || !/^[\w.~%-]*$/.test(part)))) {
    throw new Error('VITE_BASE_PATH must be ./ or an absolute site path such as /iou/.')
  }
  const base = configuredBase === './' ? './' : `${configuredBase.replace(/\/+$/g, '')}/`

  return {
    base,
    define: testing ? undefined : {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseKey),
    },
    plugins: [
      react(),
      cloudBuild,
      VitePWA({
        registerType: 'prompt',
        injectRegister: null,
        includeAssets: ['logo.svg', 'icons/*.png'],
        manifest: {
          id: '.',
          name: 'iou',
          short_name: 'iou',
          description: 'Split the bill. Keep the good company.',
          lang: 'en',
          theme_color: '#0b6b57',
          background_color: '#f7f6f2',
          display: 'standalone',
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html}'],
          navigateFallback: `${base}index.html`,
          cleanupOutdatedCaches: true,
        },
        devOptions: { enabled: false },
      }),
    ],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
