import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../src/registry';

const expectedSections = [
  ['Media, documents & images', ['media-converter', 'document-converter', 'image-workshop', 'crop-image', 'compress-image']],
  ['PDFs', ['pdf-to-images', 'images-to-pdf', 'merge-pdfs', 'split-pdf', 'compress-pdf', 'unlock-pdf']],
  ['Command planners', ['folder-sync', 'media-downloader', 'secure-copy']],
  ['Miscellaneous', ['date-time', 'qr-generator']],
];

const links = (section: Element) => [...section.querySelectorAll('a')].map((link) => link.getAttribute('href')?.slice(2));
const homeSections = () => [...document.querySelectorAll<HTMLElement>('.utility-section')];
const search = (value: string) => {
  const input = document.getElementById('utility-search') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('grouped utility navigation', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<a class="skip" href="#main">Skip to content</a><div id="app"></div>';
    history.replaceState(null, '', '#/');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    await import('../src/main');
  });

  beforeEach(() => search(''));

  it('keeps every utility in matching sidebar and Home sections', () => {
    for (const selector of ['.nav-section', '.utility-section']) {
      const sections = [...document.querySelectorAll(selector)];
      expect(sections.map((section) => [section.querySelector('h2')?.textContent, links(section)])).toEqual(expectedSections);
      const ids = sections.flatMap(links);
      expect(ids).toHaveLength(TOOLS.length);
      expect(new Set(ids).size).toBe(TOOLS.length);
      expect([...ids].sort()).toEqual(TOOLS.map((tool) => tool.id).sort());
      sections.forEach((section) => {
        expect(document.getElementById(section.getAttribute('aria-labelledby')!)?.tagName).toBe('H2');
      });
    }
    expect(document.querySelector('.sidebar a[aria-current="page"]')?.getAttribute('href')).toBe('#/');
  });

  it('finds command planners by their section name and hides empty sections', () => {
    search('command planners');
    const visible = homeSections().filter((section) => !section.hidden);
    expect(visible).toHaveLength(1);
    expect(links(visible[0])).toEqual(['folder-sync', 'media-downloader', 'secure-copy']);
    expect(document.getElementById('utility-count')?.textContent).toBe('3 of 16 utilities');
    expect(document.querySelectorAll('.sidebar .nav-section')).toHaveLength(4);
  });

  it('finds Compress Image when searching for resize', () => {
    search('resize');
    const visible = [...document.querySelectorAll<HTMLElement>('.utility-card')].filter((card) => !card.hidden);
    expect(visible.map((card) => card.getAttribute('href'))).toEqual(['#/compress-image']);
  });

  it('restores sections after a search with no matches is cleared', () => {
    search('not a utility');
    expect(homeSections().every((section) => section.hidden)).toBe(true);
    expect((document.querySelector('.empty-note') as HTMLElement).hidden).toBe(false);
    const clear = [...document.querySelectorAll<HTMLButtonElement>('.home-search button')].find((button) => button.textContent === 'Clear')!;
    clear.click();
    expect(homeSections().every((section) => !section.hidden)).toBe(true);
    expect((document.querySelector('.empty-note') as HTMLElement).hidden).toBe(true);
    expect(document.getElementById('utility-count')?.textContent).toBe('16 of 16 utilities');
    expect(document.activeElement?.id).toBe('utility-search');
  });
});
