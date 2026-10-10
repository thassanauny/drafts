import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserConfigFnObject } from 'vite'
import viteConfig from '../vite.config'

const configure = viteConfig as UserConfigFnObject

describe('iou shared publishing configuration', () => {
  let temporary: string
  let appDirectory: string
  let publishingDirectory: string
  const sharedValues = 'VITE_SUPABASE_URL=https://shared.supabase.co\nVITE_SUPABASE_ANON_KEY=sb_publishable_shared\n'
  const definitions = () => configure({ mode: 'production', command: 'build' }).define
  const write = (directory: string, filename: string, values: string) => writeFileSync(join(directory, filename), values)

  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', undefined)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', undefined)
    vi.stubEnv('VITE_BASE_PATH', undefined)
    temporary = mkdtempSync(join(tmpdir(), 'iou-env-'))
    appDirectory = join(temporary, 'apps', 'iou')
    publishingDirectory = join(temporary, 'publishing')
    mkdirSync(appDirectory, { recursive: true })
    mkdirSync(publishingDirectory)
    vi.spyOn(process, 'cwd').mockReturnValue(appDirectory)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(temporary, { recursive: true, force: true })
  })

  it('embeds shared publishing settings for the frontend without an app env file', () => {
    write(publishingDirectory, '.env.local', sharedValues)
    expect(definitions()).toEqual({
      'import.meta.env.VITE_SUPABASE_URL': '"https://shared.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    })
  })

  it('prefers app values per key and falls back for blank app values', () => {
    write(publishingDirectory, '.env.local', sharedValues)
    write(appDirectory, '.env.local', 'VITE_SUPABASE_URL= https://local.supabase.co \nVITE_SUPABASE_ANON_KEY=   \n')
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://local.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    })
    write(appDirectory, '.env.local', 'VITE_SUPABASE_URL=https://local.supabase.co\nVITE_SUPABASE_ANON_KEY=sb_publishable_local\n')
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_local"',
    })
  })

  it('preserves process environment priority, including authoritative empty values', () => {
    write(publishingDirectory, '.env.local', sharedValues)
    write(appDirectory, '.env.local', 'VITE_SUPABASE_ANON_KEY=sb_publishable_local\n')
    vi.stubEnv('VITE_SUPABASE_URL', ' https://environment.supabase.co ')
    expect(definitions()).toEqual({
      'import.meta.env.VITE_SUPABASE_URL': '"https://environment.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_local"',
    })
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_environment')
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_environment"',
    })
    for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const) {
      const value = process.env[key]
      vi.stubEnv(key, '   ')
      expect(definitions).toThrow(/iou production builds require/)
      vi.stubEnv(key, value)
    }
  })

  it('honors production file precedence in both shared and app settings', () => {
    write(publishingDirectory, '.env', sharedValues)
    write(publishingDirectory, '.env.local', 'VITE_SUPABASE_ANON_KEY=sb_publishable_shared_local\n')
    write(publishingDirectory, '.env.production', 'VITE_SUPABASE_ANON_KEY=sb_publishable_shared_production\n')
    write(publishingDirectory, '.env.production.local', 'VITE_SUPABASE_ANON_KEY=sb_publishable_shared_production_local\n')
    write(appDirectory, '.env', 'VITE_SUPABASE_URL=https://app.supabase.co\n')
    expect(definitions()).toEqual({
      'import.meta.env.VITE_SUPABASE_URL': '"https://app.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared_production_local"',
    })
    write(appDirectory, '.env.local', 'VITE_SUPABASE_URL=https://app-local.supabase.co\n')
    write(appDirectory, '.env.production', 'VITE_SUPABASE_URL=https://app-production.supabase.co\n')
    write(appDirectory, '.env.production.local', 'VITE_SUPABASE_URL=https://app-production-local.supabase.co\n')
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://app-production-local.supabase.co"',
    })
  })

  it('works standalone with local or environment settings and no publishing folder', () => {
    rmSync(publishingDirectory, { recursive: true })
    write(appDirectory, '.env.local', sharedValues)
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    })
    rmSync(join(appDirectory, '.env.local'))
    vi.stubEnv('VITE_SUPABASE_URL', 'https://environment.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_environment')
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_environment"',
    })
  })

  it('retains unconfigured development and mandatory production settings', () => {
    expect(configure({ mode: 'development', command: 'serve' }).define).toEqual({
      'import.meta.env.VITE_SUPABASE_URL': '""',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '""',
    })
    expect(definitions).toThrow(/iou production builds require/)
    for (const settings of [
      'VITE_SUPABASE_URL=https://shared.supabase.co\n',
      'VITE_SUPABASE_ANON_KEY=sb_publishable_shared\n',
    ]) {
      write(publishingDirectory, '.env.local', settings)
      expect(definitions).toThrow(/iou production builds require/)
    }
  })

  it('leaves isolated unit-test env stubbing available while configuring test-mode builds', () => {
    write(publishingDirectory, '.env.local', sharedValues)
    vi.stubEnv('VITEST', 'true')
    expect(configure({ mode: 'test', command: 'serve' }).define).toBeUndefined()
    expect(configure({ mode: 'test', command: 'build' }).define).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    })
  })

  it('keeps base path settings app-owned and preserves validation', () => {
    write(publishingDirectory, '.env.local', sharedValues + 'VITE_BASE_PATH=/shared/\n')
    expect(configure({ mode: 'production', command: 'build' }).base).toBe('./')
    write(appDirectory, '.env.local', 'VITE_BASE_PATH=/iou\n')
    expect(configure({ mode: 'production', command: 'build' }).base).toBe('/iou/')
    write(appDirectory, '.env.local', 'VITE_BASE_PATH=../outside\n')
    expect(definitions).toThrow(/VITE_BASE_PATH/)
  })
})
