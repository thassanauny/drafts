export const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function localPath(value: string, label: string) {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value)) throw new Error(`Enter an absolute ${label} path.`);
  return value;
}

function normalizedPath(value: string) {
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return '/' + parts.join('/');
}

export function rsyncCommands(o: { source: string; destination: string; checksum: boolean; mirror: boolean; excludes: string }) {
  const source = normalizedPath(localPath(o.source, 'source folder'));
  const destination = normalizedPath(localPath(o.destination, 'destination folder'));
  if (source === '/' || destination === '/' || source === destination || source.startsWith(destination + '/') || destination.startsWith(source + '/')) throw new Error('Choose different folders that are not the filesystem root or nested inside one another.');
  if (o.excludes.includes('\0') || /\r(?!\n)/.test(o.excludes)) throw new Error('Use one exclude pattern per line.');
  const excludes = o.excludes.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  if (excludes.length > 100) throw new Error('Use at most 100 exclude patterns.');
  const args = ['rsync', '-av', '--itemize-changes', ...(o.checksum ? ['--checksum'] : []), ...(o.mirror ? ['--delete'] : []), ...excludes.flatMap(p => ['--exclude', shellQuote(p)])];
  const paths = ['--', shellQuote(o.source.replace(/\/+$/, '') + '/'), shellQuote(o.destination.replace(/\/+$/, '') + '/')];
  return { preview: [...args, '--dry-run', ...paths].join(' '), sync: [...args, '--progress', ...paths].join(' ') };
}

export interface DownloadOptions {
  url: string; output: string; scope: string; items: string; media: string;
  videoFormat: string; height: string; audioFormat: string; bitrate: string;
  partial: boolean; start: string; end: string; accurate: boolean;
}

function choice(value: string, allowed: string[], label: string) {
  if (!allowed.includes(value)) throw new Error(`Choose a supported ${label}.`);
}

function seconds(value: string) {
  if (!value.trim()) return 0;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(value.trim())) throw new Error('Use seconds, M:SS, or H:MM:SS for clip times.');
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(n => n >= 60)) throw new Error('Minutes and seconds after a colon must be below 60.');
  const total = parts.reduce((n, p) => n * 60 + p, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new Error('Clip time is too large.');
  return total;
}

export function ytdlpCommand(o: DownloadOptions) {
  let url: URL;
  try { url = new URL(o.url.trim()); } catch { throw new Error('Enter a valid HTTP/HTTPS media link.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\r\n\0]/.test(o.url)) throw new Error('Enter an HTTP/HTTPS media link without embedded credentials.');
  localPath(o.output, 'download folder');
  choice(o.scope, ['single', 'playlist'], 'download scope'); choice(o.media, ['video', 'audio'], 'media type');
  const args = ['yt-dlp', '--ignore-config', '--no-overwrites', '--paths', shellQuote(o.output)];
  let template = '%(title).60B [%(id)s]';
  if (o.scope === 'playlist') {
    if (o.partial) throw new Error('Time ranges apply to single items only.');
    args.push('--yes-playlist');
    const items = o.items.replace(/\s/g, '');
    if (items) {
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(items)) throw new Error('Use playlist positions such as 1, 3, 5-8.');
      let count = 0;
      for (const item of items.split(',')) {
        const [first, last = first] = item.split('-').map(Number);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) throw new Error('Playlist ranges must use positive positions in ascending order.');
        count += last - first + 1;
      }
      if (count > 1000) throw new Error('Select at most 1,000 playlist positions.');
      args.push('--playlist-items', shellQuote(items));
    }
    template = '%(playlist_title,playlist_id|Playlist).60B/%(playlist_index)05d - ' + template;
  } else args.push('--no-playlist');
  if (o.media === 'video') {
    choice(o.videoFormat, ['mp4', 'mkv'], 'video format'); choice(o.height, ['best', '2160', '1080', '720', '480'], 'video height');
    const limit = o.height === 'best' ? '' : `[height<=${o.height}]`;
    args.push('--format', shellQuote(`bv*${limit}+ba/b${limit}`), '--merge-output-format', o.videoFormat, '--remux-video', o.videoFormat);
    if (o.videoFormat === 'mp4') args.push('--format-sort', shellQuote('vcodec:h264,lang,quality,res,fps,hdr:12,acodec:aac'));
    template += ` - video-${o.height}-${o.videoFormat}`;
  } else {
    choice(o.audioFormat, ['mp3', 'm4a', 'wav', 'opus'], 'audio format');
    choice(o.bitrate, ['best', '128', '192', '320'], 'audio quality');
    args.push('--extract-audio', '--audio-format', o.audioFormat);
    if (o.audioFormat !== 'wav') args.push('--audio-quality', o.bitrate === 'best' ? '0' : o.bitrate + 'K');
    template += ` - audio-${o.audioFormat === 'wav' ? 'best' : o.bitrate}-${o.audioFormat}`;
  }
  if (o.partial) {
    const start = seconds(o.start), end = o.end.trim() ? seconds(o.end) : 'inf';
    if (typeof end === 'number' && end <= start) throw new Error('End time must be after start time.');
    args.push('--download-sections', shellQuote(`*${start}-${end}`));
    if (o.accurate && o.media === 'video') args.push('--force-keyframes-at-cuts');
    template += `-clip-${start}-${end}`;
  }
  args.push('--output', shellQuote(template + '.%(ext)s'), '--', shellQuote(o.url.trim()));
  return args.join(' ');
}
