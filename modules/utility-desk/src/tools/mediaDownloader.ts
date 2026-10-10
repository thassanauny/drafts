import { toolPage, group, outputPanel } from '../page';
import { h, field, input, select, option, notice } from '../ui';
import { ytdlpCommand } from '../lib/commands';
import { commandPreview } from '../commandPreview';

export function mount(root: HTMLElement) {
  const url = input('url', 'url', '', { placeholder: 'https://example.com/video', spellcheck: false });
  const output = input('text', 'output', '', { placeholder: '/path/to/downloads', spellcheck: false });
  const scope = select('scope', [['single', 'Single item'], ['playlist', 'Playlist']]);
  const items = input('text', 'items', '', { placeholder: 'All items, or 1, 3, 5-8' });
  const media = select('media', [['video', 'Video'], ['audio', 'Audio only']]);
  const videoFormat = select('videoFormat', [['mp4', 'MP4'], ['mkv', 'MKV']]);
  const height = select('height', [['best', 'Best available'], ['2160', 'Up to 2160p'], ['1080', 'Up to 1080p'], ['720', 'Up to 720p'], ['480', 'Up to 480p']]);
  const audioFormat = select('audioFormat', [['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV'], ['opus', 'Opus']]);
  const bitrate = select('bitrate', [['best', 'Best available'], ['128', '128 kbps'], ['192', '192 kbps'], ['320', '320 kbps']]);
  const partial = input('checkbox', 'partial'), accurate = input('checkbox', 'accurate');
  accurate.checked = true;
  const start = input('text', 'start', '', { placeholder: '0:00' }), end = input('text', 'end', '', { placeholder: 'End of media' });
  const videoOptions = h('div', { class: 'option-grid' }, field('Video format', videoFormat), field('Maximum video height', height));
  const audioOptions = h('div', { class: 'option-grid' }, field('Audio format', audioFormat), field('Audio quality', bitrate));
  const playlistOptions = field('Playlist items (optional)', items, 'Positions such as 1, 3, 5-8. Up to 1,000 selected positions.');
  const rangeOptions = group(null, h('div', { class: 'option-grid' }, field('From', start, 'Seconds, M:SS, or H:MM:SS. Blank = beginning.'), field('To', end, 'Blank = end of media.')), option('Make cuts accurate', 'Re-encode at cut boundaries; slower processing.', accurate));
  const sync = () => {
    const video = media.value === 'video', playlist = scope.value === 'playlist';
    videoOptions.hidden = !video; audioOptions.hidden = video;
    playlistOptions.hidden = !playlist;
    if (playlist) partial.checked = false;
    partial.disabled = playlist; rangeOptions.hidden = !partial.checked;
    bitrate.disabled = audioFormat.value === 'wav'; accurate.disabled = !video;
  };
  for (const control of [media, scope, partial, audioFormat]) control.addEventListener('change', sync);
  sync();
  const preview = commandPreview(root, 'Preview command', () => [{ title: 'Download with yt-dlp', command: ytdlpCommand({ url: url.value, output: output.value, scope: scope.value, items: items.value, media: media.value, videoFormat: videoFormat.value, height: height.value, audioFormat: audioFormat.value, bitrate: bitrate.value, partial: partial.checked, start: start.value, end: end.value, accurate: accurate.checked }), detail: 'Run in your terminal with yt-dlp and FFmpeg installed. Existing output files are kept.' }]);
  toolPage(root, 'media-downloader', {
    config: [notice('info', 'Choose a link, download folder and options to prepare a yt-dlp command. The download runs in your terminal.'),
      group('Source and destination', field('Video, audio, or playlist link', url, 'One HTTP/HTTPS link supported by yt-dlp.'), field('Download folder', output, 'Absolute path on the computer where you will run the command.')),
      group('Download options', field('Download', scope), playlistOptions, field('Save as', media), videoOptions, audioOptions),
      group('Time range', option('Download a time range', 'For a single item; playlist downloads use whole items.', partial), rangeOptions)],
    actions: [preview.button], output: [outputPanel('yt-dlp command', 'RUN LOCALLY', preview.result)] });
}
