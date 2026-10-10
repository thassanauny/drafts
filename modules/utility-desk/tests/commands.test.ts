import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rsyncCommands, ytdlpCommand, type DownloadOptions } from '../src/lib/commands';
import { scpCommand } from '../src/tools/secureCopy';
import { mount as mountSync } from '../src/tools/folderSync';
import { mount as mountDownload } from '../src/tools/mediaDownloader';
import { mount as mountCopy } from '../src/tools/secureCopy';

// Replace each executable with a shell function to inspect arguments, without
// invoking rsync, SSH, downloads, or any filesystem operations.
function argv(command: string) {
  const capture = command.replace(/^(rsync|yt-dlp|scp) /, 'capture ');
  return execFileSync('/bin/sh', ['-c', `capture() { printf '%s\\0' "$@"; }; ${capture}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
}

const download: DownloadOptions = { url: 'https://example.com/video?x=1&y=2', output: '/tmp/downloads', scope: 'single', items: '', media: 'video', videoFormat: 'mp4', height: '720', audioFormat: 'mp3', bitrate: '192', partial: false, start: '', end: '', accurate: true };

describe('local command arguments', () => {
  it('quotes paths, excludes and shell metacharacters as literal rsync arguments', () => {
    const source = "/tmp/a'b $(printf injected) `printf injected`", destination = '/tmp/dest with spaces';
    const plan = rsyncCommands({ source, destination, checksum: true, mirror: true, excludes: "*.tmp\n.git/\n'$(printf injected)\r\n--delete-excluded" });
    const preview = argv(plan.preview), sync = argv(plan.sync);
    expect(preview).toEqual(['-av', '--itemize-changes', '--checksum', '--delete', '--exclude', '*.tmp', '--exclude', '.git/', '--exclude', "'$(printf injected)", '--exclude', '--delete-excluded', '--dry-run', '--', source + '/', destination + '/']);
    expect(sync).toEqual(preview.map(arg => arg === '--dry-run' ? '--progress' : arg));
  });
  it('rejects equal, nested, root, invalid and newline paths before generating a command', () => {
    for (const [source, destination] of [['relative', '/backup'], ['/data', '/data/'], ['/data', '/data/child'], ['/data/child', '/data'], ['/data', '/data/child/..'], ['/data', '/'], ['/data\nnext', '/backup']]) {
      expect(() => rsyncCommands({ source, destination, checksum: false, mirror: false, excludes: '' })).toThrow();
    }
    expect(() => rsyncCommands({ source: '/data', destination: '/backup', checksum: false, mirror: false, excludes: 'a\n'.repeat(101) })).toThrow(/100/);
    const args = argv(rsyncCommands({ source: '/data', destination: '/database', checksum: false, mirror: false, excludes: '' }).sync);
    expect(args).not.toContain('--delete'); expect(args).not.toContain('--checksum');
  });
  it('plans video formats, height, filenames and a literal URL with shell syntax', () => {
    const url = "https://example.com/video?x='$(printf injected)&y=`printf injected`";
    const args = argv(ytdlpCommand({ ...download, url, output: "/tmp/a'b $(printf injected)" }));
    expect(args).toEqual(expect.arrayContaining(['--no-playlist', '--no-overwrites', '--paths', "/tmp/a'b $(printf injected)", '--format', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4', '--remux-video', 'mp4']));
    expect(args.slice(-2)).toEqual(['--', url]);
    expect(args[args.indexOf('--output') + 1]).toBe('%(title).60B [%(id)s] - video-720-mp4.%(ext)s');
  });
  it('plans audio playlists and bounded clips, with inactive options omitted', () => {
    const playlist = argv(ytdlpCommand({ ...download, scope: 'playlist', items: '1, 3, 5-8', media: 'audio', audioFormat: 'opus' }));
    expect(playlist).toEqual(expect.arrayContaining(['--yes-playlist', '--playlist-items', '1,3,5-8', '--extract-audio', '--audio-format', 'opus', '--audio-quality', '192K']));
    expect(playlist).not.toContain('--format'); expect(playlist).not.toContain('--no-playlist');
    const clip = argv(ytdlpCommand({ ...download, partial: true, start: '1:02.5', end: '2:00' }));
    expect(clip).toEqual(expect.arrayContaining(['--download-sections', '*62.5-120', '--force-keyframes-at-cuts']));
    const wav = argv(ytdlpCommand({ ...download, partial: true, media: 'audio', audioFormat: 'wav', end: '' }));
    expect(wav).toContain('*0-inf'); expect(wav).not.toContain('--audio-quality'); expect(wav).not.toContain('--force-keyframes-at-cuts');
  });
  it('rejects unsupported URLs, option injection, playlist ranges and clip times', () => {
    for (const change of [{ url: 'file:///etc/passwd' }, { url: 'https://user:password@example.com' }, { url: 'https://example.com\nnext' }, { output: 'relative' }, { videoFormat: 'mp4; printf bad' }, { height: '999' }, { scope: 'playlist', items: '0' }, { scope: 'playlist', items: '8-2' }, { scope: 'playlist', items: '1-1001' }, { scope: 'playlist', items: '1;printf bad' }, { scope: 'playlist', partial: true }, { partial: true, start: '1:99' }, { partial: true, start: '10', end: '5' }]) expect(() => ytdlpCommand({ ...download, ...change })).toThrow();
  });
  it('keeps both SCP directions, paths and transfer options intact', () => {
    const config = { direction: 'download', folder: true, preserve: true, host: 'example.org', user: 'user', port: '2222', local: "/tmp/a'b", remote: '/data' };
    expect(argv(scpCommand(config))).toEqual(['-B', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-r', '-p', '-P', '2222', 'user@example.org:/data', "/tmp/a'b"]);
    expect(argv(scpCommand({ ...config, direction: 'upload' })).slice(-2)).toEqual(["/tmp/a'b", 'user@example.org:/data']);
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(mount: (root: HTMLElement) => void) {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!; mount(root);
  const fill = (name: string, value: string) => {
    const control = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    control.value = value; control.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const click = (label: string) => Array.from(root.querySelectorAll('button')).find(b => b.textContent === label)!.click();
  return { root, fill, click };
}

describe('command planner pages', () => {
  it('does not persist folder paths or exclusion patterns after editing, previewing and leaving', async () => {
    vi.useFakeTimers();
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const { root, fill, click } = setup(mountSync);
    fill('source', '/private/source'); fill('destination', '/private/backup'); fill('excludes', 'personal-folder/');
    click('Preview changes');
    expect(root.querySelectorAll('pre')).toHaveLength(2);
    root.dispatchEvent(new Event('utility-desk:leave'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });
  it('previews and copies rsync commands without folder access, network or writes', async () => {
    const picker = vi.fn(), fetch = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('showDirectoryPicker', picker); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { root, fill, click } = setup(mountSync);
    fill('source', '/data/source'); fill('destination', '/data/backup'); click('Preview changes');
    const commands = root.querySelectorAll('pre');
    expect(commands.length).toBe(2); expect(commands[0].textContent).toContain('--dry-run');
    expect(root.querySelector('input[type=file]')).toBeNull(); expect(root.textContent).not.toContain('Run sync');
    click('Copy command'); await Promise.resolve(); expect(writeText).toHaveBeenCalledWith(commands[0].textContent);
    fill('source', '/data/changed'); expect(root.querySelector('pre')).toBeNull();
    expect(picker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('switches download options and clears stale command output', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { root, fill, click } = setup(mountDownload);
    fill('url', download.url); fill('output', download.output); click('Preview command');
    expect(root.querySelector('pre')!.textContent).toContain('yt-dlp');
    const partial = root.querySelector<HTMLInputElement>('[name=partial]')!; partial.checked = true; partial.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('pre')).toBeNull();
    const scope = root.querySelector<HTMLSelectElement>('[name=scope]')!; scope.value = 'playlist'; scope.dispatchEvent(new Event('change', { bubbles: true }));
    expect(partial.disabled).toBe(true); expect(partial.checked).toBe(false);
    fill('items', '3-5'); click('Preview command'); expect(root.querySelector('pre')!.textContent).toContain("--playlist-items '3-5'");
    fill('url', 'invalid'); click('Preview command'); expect(root.querySelector('pre')).toBeNull(); expect(root.querySelector('[role=alert]')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('previews scp and clears the command after a path edit', () => {
    const { root, fill, click } = setup(mountCopy);
    fill('host', 'example.org'); fill('local', '/tmp/source'); fill('remote', '/data'); click('Preview transfer');
    expect(root.querySelector('pre')!.textContent).toContain('scp');
    fill('local', '/tmp/changed'); expect(root.querySelector('pre')).toBeNull();
  });
});
