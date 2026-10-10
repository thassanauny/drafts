import { toolPage, group, outputPanel } from '../page';
import { h, field, input, option, notice } from '../ui';
import { rsyncCommands } from '../lib/commands';
import { commandPreview } from '../commandPreview';

export function mount(root: HTMLElement) {
  const source = input('text', 'source', '', { placeholder: '/path/to/source', spellcheck: false });
  const destination = input('text', 'destination', '', { placeholder: '/path/to/destination', spellcheck: false });
  const checksum = input('checkbox', 'checksum'), mirror = input('checkbox', 'mirror');
  const excludes = h('textarea', { name: 'excludes', rows: 3, placeholder: '*.tmp\n.git/', spellcheck: false });
  const preview = commandPreview(root, 'Preview changes', () => {
    const plan = rsyncCommands({ source: source.value, destination: destination.value, checksum: checksum.checked, mirror: mirror.checked, excludes: excludes.value });
    return [
      { title: '1. Preview changes in your terminal', command: plan.preview, detail: 'Dry run: lists changes without copying or deleting files.' },
      { title: '2. Sync after reviewing the dry run', command: plan.sync, detail: mirror.checked ? 'Copies changes and deletes destination-only files. Excluded files are kept.' : 'Copies new and changed files; destination-only files are kept.' },
    ];
  });
  toolPage(root, 'folder-sync', {
    config: [notice('info', 'Enter folder paths on the computer where you will run rsync. This page prepares commands; it does not read or change your folders.'),
      group('Folders', field('Source folder', source, 'Absolute path. Copy the contents of this folder.'), h('div', { class: 'flow-note' }, '↓ ', h('span', {}, 'Into the destination folder')), field('Destination folder', destination, 'Absolute path to a different folder, outside the source.')),
      group('Sync options', option('Compare file contents', 'Use rsync checksums instead of size and modification time.', checksum), option('Mirror source', 'Delete destination-only files when you run the sync command.', mirror), field('Exclude patterns', excludes, 'One rsync pattern per line, up to 100. Excluded files are protected from mirror deletion.'))],
    actions: [preview.button], output: [outputPanel('rsync commands', 'RUN LOCALLY', preview.result)] });
}
