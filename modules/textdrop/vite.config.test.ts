import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserConfigFnObject } from 'vite';

const settings = vi.hoisted(() => ({
  shared: {} as Record<string, string>,
  local: {} as Record<string, string>,
  real: false,
}));

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>();
  return {
    ...actual,
    loadEnv: (mode: string, path: string, prefixes: string) => settings.real
      ? actual.loadEnv(mode, path, prefixes)
      : path.endsWith('/publishing') ? settings.shared : settings.local,
  };
});

import viteConfig from './vite.config';

const configure = viteConfig as UserConfigFnObject;
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

beforeEach(() => {
  settings.real = false;
  vi.stubEnv('VITE_SUPABASE_URL', undefined);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', undefined);
  settings.shared = {
    VITE_SUPABASE_URL: 'https://shared.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'sb_publishable_shared',
  };
  settings.local = {};
});

afterEach(() => vi.unstubAllEnvs());

describe('TextDrop static configuration', () => {
  it('uses publishing public settings and the app version with relative assets and loopback servers', () => {
    const config = configure({ mode: 'production', command: 'build' });
    expect(config.define).toEqual({
      'import.meta.env.VITE_SUPABASE_URL': '"https://shared.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
      __APP_VERSION__: JSON.stringify(version),
    });
    expect(config.base).toBe('./');
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 5175 });
    expect(config.preview).toMatchObject({ host: '127.0.0.1', port: 4175 });
  });

  it('trims app overrides and falls back to publishing for blank settings', () => {
    settings.local = {
      VITE_SUPABASE_URL: ' https://local.supabase.co ',
      VITE_SUPABASE_ANON_KEY: '   ',
    };
    expect(configure({ mode: 'production', command: 'build' }).define).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://local.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    });
    settings.local.VITE_SUPABASE_ANON_KEY = ' sb_publishable_local ';
    expect(configure({ mode: 'production', command: 'build' }).define).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_local"',
    });
  });

  it('requires both public settings when building', () => {
    for (const missing of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
      const previous = settings.shared[missing];
      delete settings.shared[missing];
      expect(() => configure({ mode: 'production', command: 'build' })).toThrow(/Set VITE_SUPABASE/);
      settings.shared[missing] = previous;
    }
  });

  it('rejects private keys before serving development or building static files', () => {
    for (const key of ['sb_secret_private', `header.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`]) {
      settings.local.VITE_SUPABASE_ANON_KEY = key;
      for (const command of ['build', 'serve'] as const) {
        expect(() => configure({ mode: 'development', command })).toThrow(/public Supabase/);
      }
    }
  });

  it('allows the unconfigured development setup screen and isolates unit-test settings', () => {
    settings.shared = {};
    expect(configure({ mode: 'development', command: 'serve' }).define).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '""',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '""',
    });
    settings.shared.VITE_SUPABASE_ANON_KEY = 'sb_secret_not_for_tests';
    expect(configure({ mode: 'test', command: 'serve' }).define).toBeUndefined();
  });

  it('validates and embeds public settings and version when a build selects test mode', () => {
    expect(configure({ mode: 'test', command: 'build' }).define).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
      __APP_VERSION__: JSON.stringify(version),
    });
    settings.shared.VITE_SUPABASE_ANON_KEY = 'sb_secret_private';
    expect(() => configure({ mode: 'test', command: 'build' })).toThrow(/public Supabase/);
  });

  it('does not mistake a manually served test mode for isolated unit tests', () => {
    vi.stubEnv('VITEST', undefined);
    settings.local.VITE_SUPABASE_ANON_KEY = 'sb_secret_private';
    expect(() => configure({ mode: 'test', command: 'serve' })).toThrow(/public Supabase/);
    settings.local.VITE_SUPABASE_ANON_KEY = 'sb_publishable_local';
    expect(configure({ mode: 'test', command: 'serve' }).define).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_local"',
      __APP_VERSION__: JSON.stringify(version),
    });
  });
});

describe('textdrop publishing settings from real env files', () => {
  let temporary: string;
  let appDirectory: string;
  let publishingDirectory: string;
  const sharedValues = 'VITE_SUPABASE_URL=https://shared.supabase.co\nVITE_SUPABASE_ANON_KEY=sb_publishable_shared\n';
  const definitions = () => configure({ mode: 'production', command: 'build' }).define;
  const write = (directory: string, filename: string, values: string) => writeFileSync(join(directory, filename), values);

  beforeEach(() => {
    settings.real = true;
    temporary = mkdtempSync(join(tmpdir(), 'textdrop-env-'));
    appDirectory = join(temporary, 'apps', 'textdrop');
    publishingDirectory = join(temporary, 'publishing');
    mkdirSync(appDirectory, { recursive: true });
    mkdirSync(publishingDirectory);
    vi.spyOn(process, 'cwd').mockReturnValue(appDirectory);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('uses publishing settings without taking settings from sibling IOU', () => {
    write(publishingDirectory, '.env.local', sharedValues);
    const iou = join(temporary, 'apps', 'iou');
    mkdirSync(iou);
    write(iou, '.env.local', 'VITE_SUPABASE_URL=https://other.supabase.co\nVITE_SUPABASE_ANON_KEY=sb_publishable_other\n');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://shared.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    });
  });

  it('overrides each setting locally, falling back for blank app values', () => {
    write(publishingDirectory, '.env.local', sharedValues);
    write(appDirectory, '.env.local', 'VITE_SUPABASE_URL= https://local.supabase.co \nVITE_SUPABASE_ANON_KEY=   \n');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://local.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    });
    write(appDirectory, '.env.local', 'VITE_SUPABASE_URL=https://local.supabase.co\nVITE_SUPABASE_ANON_KEY=sb_publishable_local\n');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://local.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_local"',
    });
  });

  it('keeps process settings highest priority, including explicitly blank settings', () => {
    write(publishingDirectory, '.env.local', sharedValues);
    write(appDirectory, '.env.local', 'VITE_SUPABASE_ANON_KEY=sb_publishable_local\n');
    vi.stubEnv('VITE_SUPABASE_URL', ' https://environment.supabase.co ');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://environment.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_local"',
    });
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_environment');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_environment"',
    });
    for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const) {
      const value = process.env[key];
      vi.stubEnv(key, '   ');
      expect(definitions).toThrow(/Set VITE_SUPABASE/);
      vi.stubEnv(key, value);
    }
  });

  it('honors production file precedence while preferring app values over shared values', () => {
    write(publishingDirectory, '.env', sharedValues);
    write(publishingDirectory, '.env.local', 'VITE_SUPABASE_ANON_KEY=sb_publishable_shared_local\n');
    write(publishingDirectory, '.env.production', 'VITE_SUPABASE_ANON_KEY=sb_publishable_shared_production\n');
    write(publishingDirectory, '.env.production.local', 'VITE_SUPABASE_ANON_KEY=sb_publishable_shared_production_local\n');
    write(appDirectory, '.env', 'VITE_SUPABASE_URL=https://app.supabase.co\n');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://app.supabase.co"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared_production_local"',
    });
    write(appDirectory, '.env.local', 'VITE_SUPABASE_URL=https://app-local.supabase.co\n');
    write(appDirectory, '.env.production', 'VITE_SUPABASE_URL=https://app-production.supabase.co\n');
    write(appDirectory, '.env.production.local', 'VITE_SUPABASE_URL=https://app-production-local.supabase.co\n');
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_URL': '"https://app-production-local.supabase.co"',
    });
  });

  it('works standalone with app settings and still rejects an unconfigured build', () => {
    rmSync(publishingDirectory, { recursive: true });
    expect(definitions).toThrow(/Set VITE_SUPABASE/);
    write(appDirectory, '.env.local', sharedValues);
    expect(definitions()).toMatchObject({
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"sb_publishable_shared"',
    });
  });
});
