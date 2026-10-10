import { h, field, input, select, button, toast, notice, type Child } from '../ui';
import { sideTitle } from '../page';
import { icon } from '../icons';
import { PRESENTATION } from '../presentation';
import { shiftDate, diffDates, timestampToDate, dateToTimestamp, worldClock, WORLD_ZONES } from '../lib/dates';
import { store } from '../lib/storage';

const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const detectedZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
type Tab = 'arithmetic' | 'difference' | 'timestamp' | 'date' | 'world';
const TABS: [Tab, string][] = [['arithmetic', 'Add or subtract'], ['difference', 'Date difference'], ['timestamp', 'From timestamp'], ['date', 'To timestamp'], ['world', 'World clocks']];
type Row = { label: string; value: string };

export function mount(root: HTMLElement) {
  const draft = store.getDraft('date-time');
  let tab = (TABS.some(([k]) => k === draft.tab) ? draft.tab : 'arithmetic') as Tab;
  const vals: Record<string, string> = { date: localNow().slice(0, 10), end: localNow().slice(0, 10), operation: 'add', amount: '1', unit: 'days', timestamp: String(Math.floor(Date.now() / 1000)), tsUnit: 'seconds', zone: detectedZone(), dt: localNow(), occurrence: 'earlier', ...draft };
  const save = () => store.setDraft('date-time', { ...vals, tab });
  let timer: ReturnType<typeof setInterval> | undefined;
  const p = PRESENTATION['date-time'];
  const body = h('div', { class: 'form-content datetime-form-content' });
  const tabsEl = h('div', { class: 'datetime-tabs', role: 'tablist', 'aria-label': 'Date and time utilities' });

  const bind = <T extends HTMLInputElement | HTMLSelectElement>(el: T, key: string) => { el.value = vals[key] ?? ''; el.addEventListener('input', () => { vals[key] = el.value; save(); }); return el; };
  const calendarInput = (type: 'date' | 'datetime-local', key: string) => bind(input(type, key, '', { class: 'calendar-input', ...(type === 'datetime-local' ? { step: 1 } : {}) }), key);
  const zones = [...new Set([detectedZone(), ...WORLD_ZONES])];
  const zoneInput = () => { const i = bind(input('text', 'zone', '', { list: 'dt-zones', autocomplete: 'off', spellcheck: false }), 'zone'); return i; };
  const results = (rows: Row[], notes: string[] = []) => h('div', { class: 'datetime-results', 'aria-live': 'polite' },
    ...rows.map((r) => h('div', { class: 'datetime-result' }, h('span', {}, r.label), h('code', {}, r.value), button('Copy', () => { navigator.clipboard?.writeText(r.value).then(() => toast('Copied', 'success'), () => toast('Copy not available', 'danger')); }, { variant: 'ghost' }))),
    notes.length ? h('div', { class: 'notice' }, ...notes.map((n) => h('p', {}, n))) : null);
  const out = h('div', {}, h('div', { class: 'empty-note' }, h('strong', {}, 'Ready when you are.'), 'Enter a date, timestamp, or timezone to calculate.'));
  const outputPanel = h('section', { class: 'panel datetime-output', 'aria-label': 'Result' }, sideTitle('Result', 'CALCULATED LOCALLY'), out);

  function run(fn: () => { rows: Row[]; notes?: string[] }) {
    try { const r = fn(); out.replaceChildren(results(r.rows, r.notes)); }
    catch (e) { out.replaceChildren(notice('danger', (e as Error).message)); }
  }
  const fmtDate = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

  function formFor(): Child[] {
    if (tab === 'arithmetic') {
      const unit = bind(select('unit', [['years', 'Years'], ['months', 'Months'], ['weeks', 'Weeks'], ['days', 'Days']]), 'unit');
      unit.setAttribute('aria-describedby', 'date-adjustment-note');
      return [h('div', { class: 'datetime-fields datetime-arithmetic-grid' },
        field('Starting date', calendarInput('date', 'date')),
        field('Change', bind(select('operation', [['add', 'Add'], ['subtract', 'Subtract']]), 'operation')),
        field('Amount', bind(input('number', 'amount', '', { step: 1 }), 'amount')),
        field('Unit', unit))];
    }
    if (tab === 'difference') return [h('div', { class: 'datetime-fields datetime-difference-grid' }, field('Start date', calendarInput('date', 'date')), field('End date', calendarInput('date', 'end')))];
    if (tab === 'timestamp') {
      const timestamp = bind(input('text', 'timestamp', '', { inputmode: 'decimal', 'aria-describedby': 'date-adjustment-note' }), 'timestamp');
      return [h('div', { class: 'datetime-fields datetime-timestamp-grid' }, field('Unix timestamp', timestamp), field('Timestamp unit', bind(select('tsUnit', [['seconds', 'Seconds'], ['milliseconds', 'Milliseconds']]), 'tsUnit')), field('Show the date in', zoneInput()))];
    }
    const occurrence = bind(select('occurrence', [['earlier', 'Earlier occurrence'], ['later', 'Later occurrence']]), 'occurrence');
    occurrence.setAttribute('aria-describedby', 'date-adjustment-note');
    return [h('div', { class: 'datetime-fields datetime-date-grid' }, field('Date and time', calendarInput('datetime-local', 'dt')), field('Timezone', zoneInput()), field('Repeated local time', occurrence))];
  }

  function submit() {
    const n = (k: string) => vals[k];
    if (tab === 'arithmetic') run(() => { const d = { [n('unit')]: Number(n('amount')) || 0 }; const r = shiftDate(n('date'), d, n('operation') === 'add' ? 1 : -1); return { rows: [{ label: 'Result', value: r }, { label: 'Weekday & date', value: fmtDate(r) }] }; });
    else if (tab === 'difference') run(() => { const d = diffDates(n('date'), n('end')); return { rows: [{ label: 'Years, months, days', value: `${d.years}y ${d.months}m ${d.days}d` }, { label: 'Total days', value: String(d.totalDays) }, { label: 'Weeks + days', value: `${d.weeks} weeks, ${d.remDays} days` }] }; });
    else if (tab === 'timestamp') run(() => { const r = timestampToDate(Number(n('timestamp')), n('zone'), n('tsUnit') === 'milliseconds' ? 'ms' : 's'); return { rows: [{ label: `In ${n('zone')}`, value: r.iso.replace('T', ' ') }, { label: 'UTC', value: r.utc }] }; });
    else run(() => { const v = n('dt').length === 16 ? `${n('dt')}:00` : n('dt'); const r = dateToTimestamp(v, n('zone'), n('occurrence') as 'earlier' | 'later'); return { rows: [{ label: 'Seconds', value: String(r.seconds) }, { label: 'Milliseconds', value: String(r.milliseconds) }] }; });
  }

  function worldMarkup() {
    const grid = h('div', { class: 'world-clock-grid' });
    const tick = () => { const now = new Date(); grid.replaceChildren(...WORLD_ZONES.map((z) => { const c = worldClock(now, z); return h('div', { class: 'world-clock' }, h('span', {}, `${c.tz} · ${c.offset}`), h('strong', {}, `${c.date}, ${c.time}`)); })); };
    tick(); timer = setInterval(tick, 1000);
    return [grid, h('p', { class: 'field-hint' }, 'Uses the timezone data in your browser. Clocks update every second.')];
  }

  function render() {
    clearInterval(timer); timer = undefined;
    tabsEl.replaceChildren(...TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; save(); render(); } }, l)));
    outputPanel.hidden = tab === 'world';
    out.replaceChildren(h('div', { class: 'empty-note' }, h('strong', {}, 'Ready when you are.'), 'Enter a date, timestamp, or timezone to calculate.'));
    if (tab === 'world') { body.replaceChildren(...worldMarkup()); return; }
    const hint = tab === 'arithmetic' ? 'Calendar dates only. Month ends use the last valid day.' : tab === 'difference' ? 'Counts calendar days between the two dates.' : tab === 'timestamp' ? 'A negative value is before 1970. Decimals are supported.' : 'Choose an occurrence when clocks move back. Missing local times are rejected.';
    body.replaceChildren(h('form', { onsubmit: (e: Event) => { e.preventDefault(); submit(); } }, ...formFor(),
      h('div', { class: 'datetime-form-footer' }, hint ? h('p', { id: 'date-adjustment-note', class: 'field-hint' }, hint) : null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Calculate →'))));
    submit();
  }

  root.append(
    h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, p.eyebrow), h('h1', { id: 'page-title', tabindex: -1 }, 'Date & time'), h('p', {}, 'Calculate dates, convert Unix timestamps, and compare world clocks without sending your data anywhere.')), h('div', { class: 'tool-mark', 'aria-hidden': 'true' }, icon('date-time'))),
    h('datalist', { id: 'dt-zones' }, zones.map((z) => h('option', { value: z }))),
    h('div', { class: 'datetime-layout' },
      h('div', {}, h('section', { class: 'panel datetime-panel' }, tabsEl, body), outputPanel),
      h('aside', { class: 'side-panels' },
        h('section', { class: 'panel about' }, h('span', { class: 'eyebrow' }, 'ABOUT THIS TOOL'), h('h3', {}, p.about), h('p', {}, p.text), h('p', {}, p.note)),
        h('section', { class: 'panel about' }, h('span', { class: 'eyebrow' }, 'QUICK TIP'), h('h3', {}, 'Timezone names'), h('p', {}, 'Use names such as Asia/Bangkok, Europe/London, or America/New_York.')))));
  render();
  return () => clearInterval(timer);
}
