import './style.css';
import { icon } from './icons';
import { parseHash, hrefFor } from './lib/router';
import { TOOLS } from './registry';
import { h, badge, emptyState, button, pageHeader, input, toast, notice } from './ui';
import { sideTitle } from './page';
import { PRESENTATION, GROUPS } from './presentation';
import { store } from './lib/storage';
import { detectCapabilities, type CapState } from './lib/caps';

const app = document.getElementById('app')!;
let cleanup: void | (() => void);

const tone = (s: CapState) => (s === 'Supported' ? 'success' : s === 'Limited' ? 'warn' : 'danger');

function dashboard(root: HTMLElement) {
  const caps = detectCapabilities();
  const actList = h('ul', { class: 'activity' });
  const renderAct = () => {
    actList.replaceChildren();
    const a = store.getActivity();
    if (!a.length) actList.append(h('li', {}, emptyState('No recent activity', 'Completed, failed and cancelled operations appear here. Stored only in this browser.')));
    a.forEach((x) => actList.append(h('li', {}, badge(x.status, x.status === 'done' ? 'success' : x.status === 'failed' ? 'danger' : 'warn'), ` ${x.tool}: ${x.message} `, h('time', { class: 'muted', datetime: new Date(x.ts).toISOString() }, new Date(x.ts).toLocaleString()))));
  };
  renderAct();
  const query = input('search', 'q', '', { placeholder: 'Find a utility, e.g. PDF or resize', id: 'utility-search' });
  const count = h('span', { id: 'utility-count', role: 'status' });
  const empty = h('div', { class: 'empty-note panel', hidden: true }, h('strong', {}, 'No utilities found.'), 'Try a task like convert, merge, or PDF.');
  const groups = GROUPS.map(([cat, ids], index) => {
    const cards = ids.map((id) => {
      const t = TOOLS.find((x) => x.id === id)!;
      const p = PRESENTATION[id];
      const a = h('a', { class: 'utility-card', href: hrefFor(id) }, h('span', { class: 'utility-card-icon', 'aria-hidden': 'true' }, icon(t.icon)), t.unavailable ? h('span', { class: 'utility-card-category' }, 'Local app') : null, h('h3', {}, t.title), h('p', {}, p.summary), h('span', { class: 'utility-card-arrow', 'aria-hidden': 'true' }, '→'));
      if (t.unavailable) a.dataset.unavailable = 'true';
      a.dataset.search = `${t.title} ${t.desc} ${t.sub} ${p.summary} ${cat}`.toLowerCase();
      return a;
    });
    const headingId = `home-group-${index}`;
    const section = h('section', { class: 'utility-section', 'aria-labelledby': headingId }, h('h2', { id: headingId, class: 'utility-section-heading' }, cat), h('div', { class: 'utility-grid' }, ...cards));
    return { cards, section };
  });
  const cards = groups.flatMap((group) => group.cards);
  const filter = () => {
    const q = query.value.trim().toLowerCase();
    let n = 0;
    cards.forEach((c) => { const show = !q || q.split(/\s+/).every((w) => c.dataset.search!.includes(w)); c.hidden = !show; if (show) n++; });
    groups.forEach(({ cards, section }) => { section.hidden = cards.every((card) => card.hidden); });
    count.textContent = `${n} of ${cards.length} utilities`;
    empty.hidden = n > 0;
  };
  query.addEventListener('input', filter);
  const search = h('div', { class: 'home-search' }, h('label', { class: 'sr-only', for: 'utility-search' }, 'Find a utility'), query, button('Clear', () => { query.value = ''; filter(); query.focus(); }), count);
  root.append(
    h('div', { class: 'page-heading' }, h('div', {}, h('span', { class: 'eyebrow' }, 'YOUR EVERYDAY TOOLKIT'), h('h1', { id: 'page-title', tabindex: -1 }, 'What would you like to do?'))),
    search,
    h('nav', { class: 'utility-sections', 'aria-label': 'All utilities' }, ...groups.map((group) => group.section)), empty,
    h('div', { class: 'page-grid dash-grid' },
      h('section', { class: 'panel' }, sideTitle('Browser capabilities', 'FEATURE CHECK'),
        h('div', { class: 'dependency-list' }, ...caps.map((c) => h('div', { class: 'dependency', title: c.detail }, h('span', {}, h('code', {}, c.label), h('br'), h('small', { class: 'muted' }, c.detail)), badge(c.state, tone(c.state)))))),
      h('section', { class: 'panel' }, sideTitle('Recent activity', 'THIS BROWSER'), h('div', { class: 'recent-list' }, actList), h('div', { class: 'actions' }, button('Clear activity', () => { store.clearActivity(); renderAct(); toast('Activity cleared', 'success'); })))),
  );
  filter();
}

async function render() {
  const currentRender = ++renderRevision;
  document.getElementById('main')!.dispatchEvent(new Event('utility-desk:leave'));
  cleanup?.(); cleanup = undefined;
  const id = parseHash(location.hash);
  const root = document.getElementById('main')!;
  root.replaceChildren();
  app.classList.toggle('home-view', id === 'dashboard');
  document.querySelector('.workspace')!.classList.toggle('home-workspace', id === 'dashboard');
  document.querySelectorAll('.sidebar nav a').forEach((a) => { if (a.getAttribute('href') === (id === 'dashboard' ? '#/' : `#/${id}`)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (id === 'dashboard') { dashboard(root); document.title = 'Utility Desk Lite'; document.getElementById('breadcrumb')!.textContent = 'All utilities'; }
  else if (id === 'notfound') root.append(pageHeader('Page not found', 'That route does not exist.'), h('a', { href: '#/', class: 'btn btn-primary' }, 'Back to dashboard'));
  else {
    const def = TOOLS.find((t) => t.id === id)!;
    document.title = `${def.title} · Utility Desk Lite`;
    document.getElementById('breadcrumb')!.textContent = def.title;
    root.append(h('p', { class: 'muted' }, 'Loading…'));
    try { const m = await def.load(); if (currentRender !== renderRevision) return; root.replaceChildren(); cleanup = m.mount(root); }
    catch (e) { if (currentRender !== renderRevision) return; root.replaceChildren(notice('danger', `Could not load this tool: ${(e as Error).message}`)); }
  }
  (document.getElementById('page-title') as HTMLElement | null)?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function shell() {
  const topbarActions = h('div', { class: 'topbar-actions' },
    h('span', { class: 'local-pill' }, h('span', { class: 'status-dot' }), 'Local workspace'));
  const nav = h('nav', { id: 'utility-navigation', 'aria-label': 'Utilities' },
    h('a', { href: '#/' }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon('home')), h('span', {}, 'Home', h('small', {}, 'Browse all utilities'))),
    ...GROUPS.map(([cat, ids], index) => {
      const headingId = `nav-group-${index}`;
      return h('div', { class: 'nav-section', role: 'group', 'aria-labelledby': headingId },
        h('h2', { id: headingId, class: 'nav-section-heading' }, cat),
        h('div', { class: 'nav-section-links' }, ...ids.map((id) => {
          const t = TOOLS.find((tool) => tool.id === id)!;
          return h('a', { href: hrefFor(t.id) }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon(t.icon)), h('span', {}, t.title, h('small', {}, t.sub)));
        })));
    }));
  const aside = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-header' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '⌘'), h('span', {}, 'Utility Desk Lite', h('small', {}, 'Your everyday toolkit'))),
      h('button', { type: 'button', class: 'btn nav-toggle', 'aria-expanded': 'false', 'aria-controls': 'utility-navigation', onclick: (e: Event) => { const o = aside.classList.toggle('nav-open'); (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(o)); } }, 'Tools', h('span', { 'aria-hidden': 'true' }, '☰'))),
    h('div', { class: 'workspace-label' }, 'IN YOUR BROWSER'),
    nav,
    h('div', { class: 'sidebar-note' }, h('span', { class: 'eyebrow' }, 'PRIVATE BY DESIGN'), h('strong', {}, 'Nothing leaves this tab.'), h('p', {}, 'Preview your settings, review the output, then start when you’re ready.')));
  nav.addEventListener('click', () => { aside.classList.remove('nav-open'); aside.querySelector('.nav-toggle')!.setAttribute('aria-expanded', 'false'); });
  app.append(aside,
    h('div', { class: 'workspace' },
      h('header', { class: 'topbar' }, h('span', {}, h('a', { href: '#/' }, 'Home'), h('span', { class: 'breadcrumb-separator' }, '/'), h('strong', { id: 'breadcrumb' }, 'Home')), topbarActions),
      h('main', { id: 'main', tabindex: -1 }),
      h('footer', {}, h('span', {}, 'Made for everyday tasks. Runs in your browser.'), h('a', { href: `${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.md` }, 'Open-source notices'), h('span', {}, 'Utility Desk Lite · 1.0.72'))));
}

let renderRevision = 0;
shell();
document.querySelector('.skip')!.addEventListener('click', (e) => { e.preventDefault(); const main = document.getElementById('main')!; main.focus(); main.scrollIntoView(); });
window.addEventListener('hashchange', render);
void render();
