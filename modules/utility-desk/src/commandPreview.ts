import { h, button, notice, toast } from './ui';

interface Command { title: string; command: string; detail: string }

export function commandPreview(root: HTMLElement, label: string, prepare: () => Command[]) {
  const result = h('div', { 'aria-live': 'polite' });
  const clear = () => result.replaceChildren();
  root.addEventListener('input', clear); root.addEventListener('change', clear);
  const preview = button(label, () => {
    try {
      const commands = prepare();
      result.replaceChildren(notice('info', 'Commands for a macOS or Linux shell. Paths and installed tools are checked when you run them locally.'),
        ...commands.map(({ title, command, detail }) => h('div', { class: 'options-group' }, h('h3', {}, title), h('p', {}, detail), h('pre', { class: 'report', tabindex: 0, 'aria-label': title }, command), button('Copy command', async () => {
          try { await navigator.clipboard.writeText(command); toast('Command copied', 'success'); }
          catch { toast('Copy is unavailable. Select the command manually.', 'warn'); }
        }))));
    } catch (e) { result.replaceChildren(notice('danger', (e as Error).message)); }
  });
  return { button: preview, result };
}
