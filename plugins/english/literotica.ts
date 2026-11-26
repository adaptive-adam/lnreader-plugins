import { load as parseHTML, CheerioAPI } from 'cheerio';
import { fetchText, fetchViaWebview } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { storage } from '@libs/storage';

// Selectors follow the Lite4/litcli playbook: key off URL grammar, microdata
// and `?page=N`; Literotica's hashed CSS-module classes are only matched by
// substring (`[class*="..."]`) as a fallback.

const SITE = 'https://www.literotica.com/';

// [slug, label] as used in tags.literotica.com/<slug>-category-tags/<tag>/
const CATEGORIES = [
  ['anal', 'Anal'],
  ['audio', 'Audio'],
  ['bdsm', 'BDSM'],
  ['chain-stories', 'Chain Stories'],
  ['crossdressing', 'Crossdressing'],
  ['erotic-couplings', 'Erotic Couplings'],
  ['erotic-horror', 'Erotic Horror'],
  ['exhibitionist-voyeur', 'Exhibitionist & Voyeur'],
  ['fan-fiction-celebrities', 'Fan Fiction & Celebrities'],
  ['fetish', 'Fetish'],
  ['first-time', 'First Time'],
  ['gay-male', 'Gay Male'],
  ['group-sex', 'Group Sex'],
  ['how-to', 'How To'],
  ['humor-satire', 'Humor & Satire'],
  ['illustrated', 'Illustrated'],
  ['interracial-love', 'Interracial Love'],
  ['lesbian-sex', 'Lesbian Sex'],
  ['letters-transcripts', 'Letters & Transcripts'],
  ['loving-wives', 'Loving Wives'],
  ['mature', 'Mature'],
  ['mind-control', 'Mind Control'],
  ['non-erotic', 'Non-Erotic'],
  ['nonhuman', 'NonHuman'],
  ['novels-and-novellas', 'Novels and Novellas'],
  ['reluctance-nonconsent', 'Reluctance/NonConsent'],
  ['reviews-essays', 'Reviews & Essays'],
  ['romance', 'Romance'],
  ['sci-fi-fantasy', 'Sci-Fi & Fantasy'],
  ['taboo-incest', 'Taboo/Incest'],
  ['toys-masturbation', 'Toys & Masturbation'],
  ['transgender', 'Transgender'],
];

const STORY_RE = /\/s\/([^/?#"]+)/;
const SERIES_RE = /\/series\/se\/(\d+)/;

/** Absolute or relative Literotica URL -> `s/<slug>` or `series/se/<id>`. */
const toPath = (href: string): string | undefined => {
  const series = href.match(SERIES_RE);
  if (series) return 'series/se/' + series[1];
  const story = href.match(STORY_RE);
  if (story) return 's/' + story[1];
  return undefined;
};

/** Number in titles like "Ch. 03", "Pt. 2", "Part 4", "Chapter 12", "Ep 5". */
export const titleNumber = (title: string): number | undefined => {
  const m = title.match(
    /\b(?:ch(?:apter)?|pt|part|ep(?:isode)?|book|vol(?:ume)?)\.?\s*(\d+(?:\.\d+)?)/i,
  );
  return m ? parseFloat(m[1]) : undefined;
};

/**
 * Re-order chapters by the number in their title. Unnumbered chapters (often
 * the first part, e.g. "Flapper Dick" before "Flapper Dick Ch. 02") inherit
 * the previous chapter's number so they stay near their series position.
 */
export const sortByTitleNumber = (
  chapters: Plugin.ChapterItem[],
): Plugin.ChapterItem[] => {
  let last = 0;
  return chapters
    .map((c, i) => {
      const n = titleNumber(c.name);
      if (n !== undefined) last = n;
      return { c, key: n ?? last, i };
    })
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map(x => x.c);
};

/** Highest `?page=N` that belongs to THIS story (not related stories). */
export const pageCount = ($: CheerioAPI, slug: string): number => {
  let max = 1;
  $('a[href*="page="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/[?&]page=(\d+)/);
    if (!m) return;
    const own = href.startsWith('?') || href.indexOf('/s/' + slug + '?') !== -1;
    if (own) max = Math.max(max, parseInt(m[1], 10));
  });
  return max;
};

/** Cleaned inner HTML of the story body for one page. */
export const storyBody = ($: CheerioAPI): string => {
  let body = $('[itemprop="articleBody"]').first();
  if (!body.length) body = $('[class*="article__content"]').first();
  if (!body.length) return '';
  body.find('script, style, noscript, [class*="adsbygoogle"]').remove();
  // The site caps the body with an inline max-height that only its own JS
  // undoes; strip it so the text flows in the reader.
  body.find('[style]').each((_, el) => {
    const style = ($(el).attr('style') || '')
      .replace(/(?:max-|min-)?height\s*:[^;]*;?/gi, '')
      .replace(/overflow[a-z-]*\s*:[^;]*;?/gi, '')
      .trim();
    if (style) $(el).attr('style', style);
    else $(el).removeAttr('style');
  });
  return (body.html() || '').trim();
};

/** The series page's "Table of Contents" section (whole page if missing). */
const tocRoot = ($: CheerioAPI) => {
  const toc = $('h2')
    .filter((_, h) => /table of contents/i.test($(h).text()))
    .first()
    .parent();
  return toc.length ? toc : $.root();
};

/** Ordered chapter list from a series page's "Table of Contents". */
export const seriesChapters = ($: CheerioAPI): Plugin.ChapterItem[] => {
  const root = tocRoot($);
  const chapters: Plugin.ChapterItem[] = [];
  const seen: Record<string, boolean> = {};
  root.find('a[href*="/s/"]').each((_, a) => {
    const path = toPath($(a).attr('href') || '');
    const name = $(a).text().trim();
    if (!path || !name || seen[path]) return;
    seen[path] = true;
    chapters.push({ name, path, chapterNumber: chapters.length + 1 });
  });
  return chapters;
};

/** Story cards from search (microdata) or tag listings (<article>). */
export const parseListing = ($: CheerioAPI): Plugin.NovelItem[] => {
  const novels: Plugin.NovelItem[] = [];
  const seen: Record<string, boolean> = {};
  let cards = $('[property="itemListElement"]');
  if (!cards.length) cards = $('article');
  cards.each((_, card) => {
    const c = $(card);
    const href =
      c.find('meta[property="url"]').attr('content') ||
      c.attr('resource') ||
      c.find('a[href*="/s/"], a[href*="/series/se/"]').first().attr('href') ||
      '';
    const path = toPath(href);
    if (!path || seen[path]) return;
    const name =
      c.find('h4, h3, h2').first().text().trim() ||
      c.find('meta[property="name"]').first().attr('content') ||
      c.find('a[href*="/s/"]').first().text().trim();
    if (!name) return;
    seen[path] = true;
    novels.push({ name, path });
  });
  return novels;
};

class LiteroticaPlugin implements Plugin.PluginBase {
  id = 'literotica';
  name = 'Literotica';
  icon = 'src/en/literotica/icon.png';
  site = SITE;
  version = '1.1.0';

  pluginSettings = {
    chapterOrder: {
      value: 'series',
      label: 'Chapter order',
      type: 'Select',
      options: [
        { label: 'Series order (as the author listed it)', value: 'series' },
        { label: 'Number in chapter title (Ch. 03, Pt. 2…)', value: 'title' },
      ],
    },
  };

  filters = {
    tag: {
      label:
        'Tags, comma separated — stories must have all (e.g. cheating, bdsm)',
      value: 'romance',
      type: FilterTypes.TextInput,
    },
    category: {
      label: 'Category',
      value: '',
      type: FilterTypes.Picker,
      options: [{ label: 'All categories', value: '' }].concat(
        CATEGORIES.map(([value, label]) => ({ label, value })),
      ),
    },
    sortBy: {
      label: 'Sort by',
      value: '',
      type: FilterTypes.Picker,
      options: [
        { label: 'Newest', value: '' },
        { label: 'Rating', value: 'rating' },
        { label: 'Favorites', value: 'favorite' },
        { label: 'Views', value: 'views' },
      ],
    },
    period: {
      label: 'Period',
      value: '',
      type: FilterTypes.Picker,
      options: [
        { label: 'All time', value: '' },
        { label: 'Year', value: 'year' },
        { label: 'Month', value: 'month' },
        { label: 'Week', value: 'week' },
      ],
    },
  } satisfies Filters;

  /** Fetch HTML; fall back to the in-app WebView (Cloudflare/age gate). */
  private async getPage(url: string, mustHave: string): Promise<CheerioAPI> {
    let html = await fetchText(url);
    if (
      html.indexOf(mustHave) === -1 &&
      typeof fetchViaWebview === 'function'
    ) {
      const res = await fetchViaWebview(url, { waitForSelector: mustHave });
      if (res.ok) html = res.html;
    }
    if (!html)
      throw new Error('Could not load ' + url + ' — open it in WebView');
    return parseHTML(html);
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // "cheating, high heels" -> /cheating/?tag[]=high%20heels (all must match).
    // Multi-word tags keep their space; the site's hyphenated slug is a
    // different, much smaller tag.
    const tags = (filters?.tag?.value || 'romance')
      .split(',')
      .map(t => t.trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean);
    const tag = tags.shift() || 'romance';
    const params = tags.map(t => 'tag%5B%5D=' + encodeURIComponent(t));
    const sortBy = showLatestNovels ? '' : filters?.sortBy?.value || '';
    if (sortBy) params.push('sort_by=' + sortBy);
    if (filters?.period?.value) params.push('period=' + filters.period.value);
    if (pageNo > 1) params.push('page=' + pageNo);
    const category = filters?.category?.value;
    const url =
      'https://tags.literotica.com/' +
      (category ? category + '-category-tags/' : '') +
      encodeURIComponent(tag) +
      '/' +
      (params.length ? '?' + params.join('&') : '');
    return parseListing(await this.getPage(url, '/s/'));
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      'https://search.literotica.com/?query=' +
      encodeURIComponent(searchTerm) +
      '&sort=relevance' +
      (pageNo > 1 ? '&page=' + pageNo : '');
    return parseListing(await this.getPage(url, 'itemListElement'));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novel: Plugin.SourceNovel = { path: novelPath, name: '' };
    let seriesPath = novelPath.startsWith('series/') ? novelPath : undefined;

    if (!seriesPath) {
      // A single story. If it is one part of a series, read the series so
      // all its chapters show up no matter which part was opened.
      const $ = await this.getPage(SITE + novelPath, 'articleBody');
      novel.name = $('h1').first().text().trim();
      novel.summary = $('meta[property="og:description"]').attr('content');
      novel.author = $('[class*="author__title"]').first().text().trim();
      const tags = $('a[href*="tags.literotica.com/"]')
        .map((_, a) => $(a).text().trim())
        .get()
        .filter(Boolean);
      if (tags.length) novel.genres = Array.from(new Set(tags)).join(',');
      seriesPath = toPath(
        $('a[href*="/series/se/"]').first().attr('href') || '',
      );
      if (!seriesPath) {
        novel.chapters = [
          { name: novel.name, path: novelPath, chapterNumber: 1 },
        ];
        return novel;
      }
    }

    const $ = await this.getPage(SITE + seriesPath, '/s/');
    novel.name = $('h1').first().text().trim() || novel.name;
    novel.author =
      novel.author || $('[class*="author__title"]').first().text().trim();
    // First TOC entry's description, minus its trailing category link.
    const desc = tocRoot($).find('li p').first().clone();
    desc.find('a').remove();
    novel.summary = novel.summary || desc.text().trim();
    let chapters = seriesChapters($);
    if (storage.get('chapterOrder') === 'title') {
      chapters = sortByTitleNumber(chapters).map((c, i) => ({
        ...c,
        chapterNumber: i + 1,
      }));
    }
    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const slug = chapterPath.replace(/^s\//, '');
    const first = await this.getPage(SITE + chapterPath, 'articleBody');
    const pages = [storyBody(first)];
    const total = pageCount(first, slug);
    for (let p = 2; p <= total; p++) {
      // ponytail: fixed 1s pause between pages; litcli used 8 req/min
      await new Promise(r => setTimeout(r, 1000));
      pages.push(
        storyBody(
          await this.getPage(SITE + chapterPath + '?page=' + p, 'articleBody'),
        ),
      );
    }
    const html = pages.filter(Boolean).join('\n');
    if (!html)
      throw new Error('No story text — age-gated, removed or blocked?');
    return html;
  }

  resolveUrl = (path: string) => SITE + path;
}

export default new LiteroticaPlugin();
