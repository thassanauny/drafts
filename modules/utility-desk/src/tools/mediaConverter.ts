import { toolPage, group } from '../page';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import { h, field, input, select, pageHeader, filePicker, taskControls, notice, persistForm, badge, button } from '../ui';
import { detectCapabilities } from '../lib/caps';
import { downloadBlob, baseName, sanitizeFilename, formatBytes, bytesToBlob, suggestOutputName, fileSourceKey } from '../lib/util';

export const MEDIA_LIMIT = 256 * 1024 * 1024;
const MEDIA_ACCEPT = 'video/*,audio/*,.mp4,.m4v,.mkv,.mov,.avi,.webm,.mpg,.mpeg,.ogv,.3gp,.flv,.wmv,.mp3,.wav,.flac,.aac,.m4a,.aif,.aiff,.opus,.ogg,.wma,.gif';
export const FORMATS: Record<string, { label: string; ext: string; mime: string; args: string[] }> = {
  mp4: { label: 'MP4 (H.264/AAC)', ext: 'mp4', mime: 'video/mp4', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart'] },
  mkv: { label: 'MKV (H.264/AAC)', ext: 'mkv', mime: 'video/x-matroska', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac'] },
  webm: { label: 'WebM (VP9/Opus)', ext: 'webm', mime: 'video/webm', args: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus'] },
  mp3: { label: 'MP3 audio', ext: 'mp3', mime: 'audio/mpeg', args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '4'] },
  wav: { label: 'WAV audio', ext: 'wav', mime: 'audio/wav', args: ['-vn', '-c:a', 'pcm_s16le'] },
  m4a: { label: 'M4A (AAC)', ext: 'm4a', mime: 'audio/mp4', args: ['-vn', '-c:a', 'aac'] },
  opus: { label: 'Opus audio', ext: 'opus', mime: 'audio/ogg', args: ['-vn', '-c:a', 'libopus'] },
  ogg: { label: 'OGG audio', ext: 'ogg', mime: 'audio/ogg', args: ['-vn', '-c:a', 'libvorbis', '-q:a', '4'] },
  gif: { label: 'Animated GIF', ext: 'gif', mime: 'image/gif', args: ['-vf', 'fps=10,scale=480:-1:flags=lanczos', '-an'] },
};

export function mediaSeconds(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^(\d+(\.\d+)?|\d+:\d{2}(:\d{2})?(\.\d+)?)$/.test(value)) throw new Error('Use seconds, M:SS, or H:MM:SS for trim times.');
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some((n) => n >= 60)) throw new Error('Minutes and seconds after a colon must be below 60.');
  const seconds = parts.reduce((n, v) => n * 60 + v, 0);
  if (!Number.isFinite(seconds)) throw new Error('Enter a finite trim time.');
  return seconds;
}

export function mediaArgs(format: string, quality: string, height: string, bitrate: string, start: string, end: string): string[] {
  const spec = FORMATS[format];
  if (!spec) throw new Error('Choose an output format.');
  const from = mediaSeconds(start) ?? 0, to = mediaSeconds(end);
  if (to !== null && to <= from) throw new Error('The end time must be after the start.');
  const args = [...spec.args];
  if (['mp4', 'mkv', 'webm'].includes(format)) {
    const crf = format === 'webm' ? ({ high: '25', balanced: '32', small: '40' } as Record<string, string>)[quality] : ({ high: '18', balanced: '23', small: '28' } as Record<string, string>)[quality];
    const idx = args.indexOf('-crf'); if (idx >= 0) args[idx + 1] = crf;
    if (height) args.push('-vf', `scale=-2:trunc(min(ih\\,${height})/2)*2`);
    args.push('-b:a', `${bitrate}k`);
  } else if (format !== 'wav' && format !== 'gif') {
    const idx = args.indexOf('-q:a'); if (idx >= 0) args.splice(idx, 2);
    args.push('-b:a', `${bitrate}k`);
  }
  return [...(from ? ['-ss', String(from)] : []), '-i', 'INPUT', ...(to !== null ? ['-t', String(to - from)] : []), ...args, `output.${spec.ext}`];
}

export function mount(root: HTMLElement) {
  const cap = detectCapabilities().find((c) => c.id === 'ffmpeg')!;
  if (cap.state === 'Unavailable') {
    root.append(pageHeader('Media converter', 'FFmpeg WebAssembly runs locally.', badge('Unavailable', 'danger')), notice('danger', `This browser cannot run the converter: ${cap.detail} Try a current Chrome, Edge, Firefox or Safari.`));
    return;
  }
  let file: File | null = null;
  let ff: FFmpeg | null = null;
  const info = h('div'), preview = h('video', { controls: true, hidden: true, class: 'preview-img', 'aria-label': 'Source preview' });
  let previewUrl = '';
  const fmt = select('format', Object.entries(FORMATS).map(([k, v]) => [k, v.label] as [string, string]), 'mp4');
  const quality = select('quality', [['high', 'High quality'], ['balanced', 'Balanced'], ['small', 'Smaller file']], 'balanced');
  const height = select('height', [['', 'Original size'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']]);
  const bitrate = select('bitrate', [['128', '128 kbps'], ['192', '192 kbps'], ['320', '320 kbps']], '192');
  const outputName = input('text', 'outputName', '', { placeholder: 'Use the source filename' });
  const suggestName = suggestOutputName(outputName, 'converted');
  const start = input('text', 'start', '', { placeholder: '0 or 00:00:05' }), end = input('text', 'end', '', { placeholder: 'Full length or 00:00:15' });
  const plan = h('pre', { class: 'report', hidden: true });
  const sync = () => { const video = ['mp4', 'mkv', 'webm'].includes(fmt.value); quality.disabled = height.disabled = !video; bitrate.disabled = ['wav', 'gif'].includes(fmt.value); plan.hidden = true; };
  fmt.addEventListener('change', sync); sync();
  preview.addEventListener('loadedmetadata', () => { end.placeholder = Number.isFinite(preview.duration) ? `Full length (${Math.round(preview.duration * 1000) / 1000} s)` : 'Full length or 00:00:15'; });
  const picker = filePicker({ label: 'Audio or video file', accept: MEDIA_ACCEPT, onFiles: ([f]) => {
    const sameSource = fileSourceKey(file) === fileSourceKey(f);
    info.replaceChildren(); if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; preview.hidden = true; file = null;
    if (!sameSource) { suggestName(); task.reset(); }
    end.placeholder = 'Full length or 00:00:15';
    if (f.size > MEDIA_LIMIT) { info.append(notice('warn', `${f.name} is ${formatBytes(f.size)}. The browser limit is ${formatBytes(MEDIA_LIMIT)} (WebAssembly memory).`)); return; }
    file = f; if (!sameSource) suggestName(f.name); previewUrl = URL.createObjectURL(f); preview.src = previewUrl; preview.hidden = false;
    info.append(notice('info', `${f.name} · ${formatBytes(f.size)}. Conversion is single-threaded and can be slow for large files.`));
  } });
  const args = () => mediaArgs(fmt.value, quality.value, height.value, bitrate.value, start.value, end.value);
  const validation = () => { if (!file) return 'Choose a file first.'; try { args(); return null; } catch (e) { return (e as Error).message; } };

  const task = taskControls('media-converter', 'Convert media', async ({ signal, progress }) => {
    const source = file!;
    const spec = FORMATS[fmt.value];
    const command = args();
    const name = `${sanitizeFilename(outputName.value.trim() || baseName(source.name), 'media')}.${spec.ext}`;
    ff = new FFmpeg();
    const onAbort = () => { ff?.terminate(); };
    signal.addEventListener('abort', onAbort);
    try {
      ff.on('progress', ({ progress: p }) => progress(Math.min(0.99, Math.max(0, p)), `Converting ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`));
      progress(0, 'Loading FFmpeg (one-time, ~30 MB, local)…');
      await ff.load({ coreURL: new URL(coreUrl, location.href).href, wasmURL: new URL(wasmUrl, location.href).href });
      const inName = 'input.' + (source.name.split('.').pop()?.replace(/[^\w]/g, '') || 'bin');
      const outName = `output.${spec.ext}`;
      await ff.writeFile(inName, new Uint8Array(await source.arrayBuffer()));
      const code = await ff.exec(command.map((arg) => arg === 'INPUT' ? inName : arg));
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (code !== 0) throw new Error('FFmpeg could not convert this file (unsupported codec or invalid options).');
      const data = (await ff.readFile(outName)) as Uint8Array;
      downloadBlob(bytesToBlob(data, spec.mime), name);
      return `${name} (${formatBytes(data.length)})`;
    } catch (e) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      throw e;
    } finally { signal.removeEventListener('abort', onAbort); ff?.terminate(); ff = null; }
  }, { validate: validation });
  const previewPlan = button('Preview conversion', () => { const err = validation(); plan.hidden = false; plan.textContent = err ?? `Source: ${file!.name}\nOutput: ${outputName.value.trim() || baseName(file!.name)}.${FORMATS[fmt.value].ext}\nFFmpeg options: ${args().join(' ')}\nNo output has been created.`; });

  toolPage(root, 'media-converter', {
    config: [notice('info', `No special server headers needed. Limit: ${formatBytes(MEDIA_LIMIT)} per file. FFmpeg (~30 MB, bundled) loads only when you start a conversion. Cancel stops it by terminating the worker.`),
      ...(cap.state === 'Limited' ? [notice('warn', cap.detail)] : []), group(null, picker, info, preview),
      group('Output', field('Output format', fmt), h('div', { class: 'option-grid' }, field('Video quality', quality), field('Maximum video height', height), field('Audio bitrate', bitrate), field('Output filename (without extension)', outputName))),
      group('Trim time range', h('div', { class: 'option-grid' }, field('From', start, 'Seconds, M:SS, or H:MM:SS. Blank = beginning.'), field('To', end, 'Blank = media’s end.')), button('Use media’s end time', () => { end.value = Number.isFinite(preview.duration) ? String(preview.duration) : ''; })), plan],
    actions: [previewPlan, task.el] });
  persistForm('media-converter', root, ['start', 'end']);
  sync();
  return () => { ff?.terminate(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
}
