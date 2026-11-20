import * as cheerio from 'cheerio';
import { safeFetch } from './safeFetch.js';
import { normalizeDomain } from './domainUtils.js';

export interface SampledArticle {
  url: string;
  html: string;
  wordCount: number;
  publishedDate: string | null;
}

export interface ArticleAnalysis {
  hasArticles: boolean;
  articleCountFound: number;
  latestArticleDate: string | null;
  avgArticleWords: number | null;
  sampleArticleUrls: string[];
  rssFeedUrl: string | null;
  sitemapUrl: string | null;
  sampledArticles: SampledArticle[];
  outboundLinks: string[];
}

const ARTICLE_PATH_HINT =
  /(\/20[12]\d\/\d{1,2}\/|\/articles?\/|\/news\/|\/blog\/|\/post\/|\/posts\/|\/stories\/|\/story\/|\/guide\/|\/guides\/|\/reviews?\/|\/insights\/)/i;
const SKIP_LINK_HINT =
  /\.(jpg|jpeg|png|gif|svg|webp|pdf|mp3|mp4|css|js|xml|zip)$/i;
const NON_ARTICLE_PATH_HINT =
  /^\/(about|about-us|contact|contact-us|team|staff|masthead|privacy|terms|cookie|login|signup|register|subscribe|pricing|advertise|tag|category|author|search|feed|wp-content|wp-admin)\/?$/i;

function parseDateToIso(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dt = new Date(trimmed);
  if (Number.isNaN(dt.getTime())) return null;
  const year = dt.getUTCFullYear();
  if (year < 2005 || year > 2030) return null;
  return dt.toISOString().slice(0, 10);
}

function extractFeedItems(xml: string): Array<{ url: string; date: string | null }> {
  const results: Array<{ url: string; date: string | null }> = [];
  const $ = cheerio.load(xml, { xmlMode: true });

  // RSS <item>
  $('item').each((_, el) => {
    const link = $(el).find('link').first().text().trim() || $(el).find('guid').first().text().trim();
    const pubDate =
      parseDateToIso($(el).find('pubDate').first().text()) ||
      parseDateToIso($(el).find('dc\\:date').first().text());
    if (link && /^https?:\/\//i.test(link)) {
      results.push({ url: link, date: pubDate });
    }
  });

  // Atom <entry>
  if (results.length === 0) {
    $('entry').each((_, el) => {
      const link =
        $(el).find('link[rel="alternate"]').attr('href') ||
        $(el).find('link').first().attr('href') ||
        '';
      const date =
        parseDateToIso($(el).find('published').first().text()) ||
        parseDateToIso($(el).find('updated').first().text());
      if (link && /^https?:\/\//i.test(link)) {
        results.push({ url: link, date });
      }
    });
  }

  return results;
}

function extractSitemapUrls(xml: string): Array<{ url: string; date: string | null }> {
  const results: Array<{ url: string; date: string | null }> = [];
  const $ = cheerio.load(xml, { xmlMode: true });

  $('url').each((_, el) => {
    const loc = $(el).find('loc').first().text().trim();
    const lastmod = parseDateToIso($(el).find('lastmod').first().text());
    if (loc && /^https?:\/\//i.test(loc)) {
      results.push({ url: loc, date: lastmod });
    }
  });

  return results;
}

function extractJsonLdDatesAndTypes(html: string): { isArticle: boolean; date: string | null } {
  const $ = cheerio.load(html);
  let isArticle = false;
  let date: string | null = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      const stack: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length > 0) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj['@graph'])) {
          stack.push(...obj['@graph']);
        }
        const rawType = obj['@type'];
        const types = Array.isArray(rawType) ? rawType : [rawType];
        if (
          types.some(
            (t) =>
              typeof t === 'string' &&
              /Article|BlogPosting|NewsArticle|ReportageNewsArticle|OpinionNewsArticle/i.test(t),
          )
        ) {
          isArticle = true;
          const d =
            parseDateToIso(typeof obj.datePublished === 'string' ? obj.datePublished : null) ||
            parseDateToIso(typeof obj.dateModified === 'string' ? obj.dateModified : null);
          if (d && (!date || d > date)) date = d;
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  });

  return { isArticle, date };
}

function countArticleWords($: cheerio.CheerioAPI): number {
  const container = $('article').first().length
    ? $('article').first()
    : $('main').first().length
      ? $('main').first()
      : $('body');

  const paragraphs = container
    .find('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length >= 25);

  const text = paragraphs.length > 0 ? paragraphs.join(' ') : container.text();
  return text.split(/\s+/).filter(Boolean).length;
}

function collectOutboundLinks($: cheerio.CheerioAPI, siteDomain: string, baseUrl: string): string[] {
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      return;
    }
    try {
      const abs = new URL(href, baseUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
      const targetDomain = normalizeDomain(abs.hostname);
      if (targetDomain && targetDomain !== siteDomain) {
        out.add(abs.toString());
      }
    } catch {
      // ignore invalid URLs
    }
  });
  return Array.from(out).slice(0, 60);
}

export async function analyzeArticles(
  baseUrl: string,
  domain: string,
  homepageHtml: string,
): Promise<ArticleAnalysis> {
  const $home = cheerio.load(homepageHtml);
  const outboundSet = new Set<string>(collectOutboundLinks($home, domain, baseUrl));

  let rssFeedUrl: string | null = null;
  let sitemapUrl: string | null = null;
  const candidateArticles = new Map<string, string | null>(); // url -> date

  // 1. Discover RSS/Atom feeds linked in homepage head (ignoring oEmbed XML), plus standard fallbacks
  const feedLinks: string[] = [];
  $home('link[rel="alternate"]').each((_, el) => {
    const type = ($home(el).attr('type') || '').toLowerCase();
    const href = $home(el).attr('href');
    if (
      href &&
      !type.includes('oembed') &&
      (type.includes('rss') || type.includes('atom') || type === 'application/xml' || type === 'text/xml')
    ) {
      try {
        feedLinks.push(new URL(href, baseUrl).toString());
      } catch {
        // ignore
      }
    }
  });

  for (const fallbackPath of ['/feed', '/rss.xml', '/feed.xml', '/rss']) {
    try {
      const candidate = new URL(fallbackPath, baseUrl).toString();
      if (!feedLinks.includes(candidate)) feedLinks.push(candidate);
    } catch {
      // ignore
    }
  }

  for (const candidateFeed of feedLinks.slice(0, 4)) {
    const res = await safeFetch(candidateFeed, { timeoutMs: 6000, maxBytes: 1_000_000 });
    if (res.ok && (res.body.includes('<rss') || res.body.includes('<feed') || res.body.includes('<item'))) {
      const items = extractFeedItems(res.body);
      if (items.length > 0) {
        rssFeedUrl = res.finalUrl;
        for (const item of items) {
          if (normalizeDomain(item.url) === domain && !candidateArticles.has(item.url)) {
            candidateArticles.set(item.url, item.date);
          }
        }
        break;
      }
    }
  }

  // 2. If few feed items found, check robots.txt / sitemap.xml
  if (candidateArticles.size < 5) {
    const robotsRes = await safeFetch(new URL('/robots.txt', baseUrl).toString(), {
      timeoutMs: 4000,
      maxBytes: 256_000,
    });
    const sitemapCandidates: string[] = [];
    if (robotsRes.ok) {
      for (const line of robotsRes.body.split(/\r?\n/)) {
        const match = /^sitemap:\s*(https?:\/\/\S+)/i.exec(line.trim());
        if (match) sitemapCandidates.push(match[1]);
      }
    }
    if (sitemapCandidates.length === 0) {
      sitemapCandidates.push(new URL('/sitemap.xml', baseUrl).toString());
    }

    for (const smUrl of sitemapCandidates.slice(0, 2)) {
      const smRes = await safeFetch(smUrl, { timeoutMs: 6000, maxBytes: 1_500_000 });
      if (!smRes.ok || (!smRes.body.includes('<urlset') && !smRes.body.includes('<sitemapindex'))) {
        continue;
      }
      sitemapUrl = smRes.finalUrl;

      let targetXml = smRes.body;
      if (smRes.body.includes('<sitemapindex')) {
        const $idx = cheerio.load(smRes.body, { xmlMode: true });
        const subSitemaps = $idx('sitemap')
          .map((_, el) => ({
            loc: $idx(el).find('loc').first().text().trim(),
            lastmod: parseDateToIso($idx(el).find('lastmod').first().text()) || '',
          }))
          .get()
          .filter((s) => s.loc);

        const articleMaps = subSitemaps.filter((s) =>
          /post|article|news|blog|story|stories/i.test(s.loc),
        );
        const pool = articleMaps.length > 0 ? articleMaps : subSitemaps;
        // Prefer newest lastmod; if dates are absent, Yoast/RankMath put newest posts in the last sitemap
        pool.sort((a, b) => {
          if (a.lastmod && b.lastmod) return b.lastmod.localeCompare(a.lastmod);
          if (a.lastmod && !b.lastmod) return -1;
          if (!a.lastmod && b.lastmod) return 1;
          return 0;
        });
        const chosen = pool[0]?.lastmod ? pool[0] : pool[pool.length - 1];
        if (chosen?.loc) {
          const subRes = await safeFetch(chosen.loc, { timeoutMs: 6000, maxBytes: 1_500_000 });
          if (subRes.ok) targetXml = subRes.body;
        }
      }

      const urls = extractSitemapUrls(targetXml).sort((a, b) =>
        (b.date || '').localeCompare(a.date || ''),
      );
      for (const u of urls) {
        if (normalizeDomain(u.url) !== domain) continue;
        try {
          const p = new URL(u.url).pathname;
          if (p === '/' || NON_ARTICLE_PATH_HINT.test(p) || SKIP_LINK_HINT.test(p)) continue;
          if (!candidateArticles.has(u.url)) {
            candidateArticles.set(u.url, u.date);
          }
        } catch {
          // ignore
        }
        if (candidateArticles.size >= 30) break;
      }
      if (candidateArticles.size > 0) break;
    }
  }

  // 3. Collect article-looking links from homepage DOM as well
  $home('article a[href], h2 a[href], h3 a[href], a[href]').each((_, el) => {
    const href = $home(el).attr('href');
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl);
      if (normalizeDomain(abs.hostname) !== domain) return;
      const pathname = abs.pathname;
      if (pathname === '/' || pathname.length < 8) return;
      if (SKIP_LINK_HINT.test(pathname) || NON_ARTICLE_PATH_HINT.test(pathname)) return;
      const insideCard = $home(el).closest('article').length > 0;
      const textLen = $home(el).text().trim().length;
      if (ARTICLE_PATH_HINT.test(pathname) || (insideCard && textLen >= 18) || pathname.split('/').filter(Boolean).length >= 2 && textLen >= 28) {
        const cleanUrl = `${abs.origin}${abs.pathname}${abs.search}`;
        if (!candidateArticles.has(cleanUrl)) {
          candidateArticles.set(cleanUrl, null);
        }
      }
    } catch {
      // ignore
    }
  });

  // Sort candidates preferring those with dates (newest first) or article path hints
  const sortedCandidates = Array.from(candidateArticles.entries())
    .sort((a, b) => {
      if (a[1] && !b[1]) return -1;
      if (!a[1] && b[1]) return 1;
      if (a[1] && b[1]) return b[1].localeCompare(a[1]);
      const aHint = ARTICLE_PATH_HINT.test(a[0]) ? 1 : 0;
      const bHint = ARTICLE_PATH_HINT.test(b[0]) ? 1 : 0;
      return bHint - aHint;
    })
    .slice(0, 25);

  let latestDate: string | null = null;
  for (const [, dt] of sortedCandidates) {
    if (dt && (!latestDate || dt > latestDate)) latestDate = dt;
  }

  const homeLd = extractJsonLdDatesAndTypes(homepageHtml);
  if (homeLd.date && (!latestDate || homeLd.date > latestDate)) {
    latestDate = homeLd.date;
  }

  // 4. Fetch up to 2 distinct recent article pages
  const sampledArticles: SampledArticle[] = [];
  for (const [artUrl, feedDate] of sortedCandidates.slice(0, 4)) {
    if (sampledArticles.length >= 2) break;
    const res = await safeFetch(artUrl, { timeoutMs: 8000, maxBytes: 1_500_000 });
    if (!res.ok || !res.contentType.toLowerCase().includes('html')) continue;

    const $art = cheerio.load(res.body);
    const ld = extractJsonLdDatesAndTypes(res.body);
    const metaDate =
      parseDateToIso($art('meta[property="article:published_time"]').attr('content')) ||
      parseDateToIso($art('meta[name="publish-date"]').attr('content')) ||
      parseDateToIso($art('meta[name="date"]').attr('content')) ||
      parseDateToIso($art('time[datetime]').first().attr('datetime'));

    const publishedDate = ld.date || metaDate || feedDate;
    if (publishedDate && (!latestDate || publishedDate > latestDate)) {
      latestDate = publishedDate;
    }

    const wordCount = countArticleWords($art);
    for (const outLink of collectOutboundLinks($art, domain, res.finalUrl)) {
      outboundSet.add(outLink);
    }

    sampledArticles.push({
      url: res.finalUrl,
      html: res.body,
      wordCount,
      publishedDate,
    });
  }

  const avgArticleWords =
    sampledArticles.length > 0
      ? Math.round(
          sampledArticles.reduce((acc, a) => acc + a.wordCount, 0) / sampledArticles.length,
        )
      : null;

  const articleCountFound = Math.max(candidateArticles.size, sampledArticles.length);
  const hasStrongArticleStructure =
    sampledArticles.some((a) => a.wordCount >= 180) ||
    Boolean(rssFeedUrl && articleCountFound >= 2) ||
    $home('article').length >= 3 ||
    homeLd.isArticle;

  const hasArticles = articleCountFound >= 1 && (hasStrongArticleStructure || articleCountFound >= 3);

  return {
    hasArticles,
    articleCountFound,
    latestArticleDate: latestDate,
    avgArticleWords,
    sampleArticleUrls: sampledArticles.map((a) => a.url),
    rssFeedUrl,
    sitemapUrl,
    sampledArticles,
    outboundLinks: Array.from(outboundSet),
  };
}
