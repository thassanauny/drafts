import { toolPage, group, outputPanel } from '../page';
import { h, field, input, select, option, notice } from '../ui';
import { shellQuote as quote } from '../lib/commands';
import { commandPreview } from '../commandPreview';

export function scpCommand(o: { direction: string; folder: boolean; preserve: boolean; host: string; user: string; port: string; local: string; remote: string }) {
  if (!['upload', 'download'].includes(o.direction)) throw new Error('Choose upload or download.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(o.host)) throw new Error('Enter a hostname, IPv4 address, or SSH alias.');
  if (o.user && !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(o.user)) throw new Error('Enter a valid SSH username.');
  if (!/^\/[a-zA-Z0-9/._-]*$/.test(o.remote)) throw new Error('Use an absolute remote path with letters, numbers, /, ., _, or -.');
  if (!o.local.startsWith('/') || /[\r\n\0]/.test(o.local)) throw new Error('Enter an absolute local path.');
  if (o.port && (!/^\d+$/.test(o.port) || Number(o.port) < 1 || Number(o.port) > 65535)) throw new Error('Port must be between 1 and 65535.');
  const args = ['scp', '-B', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', ...(o.folder ? ['-r'] : []), ...(o.preserve ? ['-p'] : []), ...(o.port ? ['-P', o.port] : [])];
  const remote = `${o.user ? o.user + '@' : ''}${o.host}:${o.remote}`;
  return [...args, ...(o.direction === 'upload' ? [quote(o.local), quote(remote)] : [quote(remote), quote(o.local)])].join(' ');
}

export function mount(root: HTMLElement) {
  const direction = select('direction', [['upload', 'Upload to remote'], ['download', 'Download to this computer']]);
  const folder = input('checkbox', 'folder'), preserve = input('checkbox', 'preserve');
  const host = input('text', 'host', '', { placeholder: 'server.example.com' }), user = input('text', 'user'), port = input('number', 'port', '', { min: 1, max: 65535 });
  const local = input('text', 'local', '', { placeholder: '/absolute/local/path' }), remote = input('text', 'remote', '', { placeholder: '/absolute/remote/path' });
  const preview = commandPreview(root, 'Preview transfer', () => [{ title: 'Transfer with scp', command: scpCommand({ direction: direction.value, folder: folder.checked, preserve: preserve.checked, host: host.value.trim(), user: user.value.trim(), port: port.value, local: local.value, remote: remote.value }), detail: 'Run with your local SSH client. SCP may replace same-name destination files.' }]);
  toolPage(root, 'secure-copy', {
    config: [notice('info', 'Choose paths and connection options to prepare an scp command. Run it in your terminal with your existing SSH setup.'), group(null, field('Direction', direction), option('A folder and its contents', 'Copy the folder itself, including its name.', folder), option('Preserve times and permissions', 'Use the SSH client’s preserve option.', preserve)), group('Connection', field('Host / SSH alias', host), h('div', { class: 'option-grid' }, field('Username (optional)', user), field('Port (optional)', port))), group('Paths', field('Local path', local), field('Remote path', remote))],
    actions: [preview.button], output: [outputPanel('scp command', 'RUN LOCALLY', preview.result)],
  });
}
