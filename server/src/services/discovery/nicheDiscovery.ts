import * as cheerio from 'cheerio';
import type { AppSettings, DiscoverySearchResult } from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import { safeFetch } from '../scanner/safeFetch.js';
import { normalizeDomain } from '../scanner/domainUtils.js';
import { isBlockedCandidateDomain } from './blocklists.js';
import {
  annotateDiscoveredCandidates,
  type RawDiscoveredCandidate,
} from './candidateAnnotator.js';

export type NicheIntent = 'news_articles' | 'independent_blogs' | 'guides_reviews';

const INTENT_SUFFIX: Record<NicheIntent, string> = {
  news_articles: '',
  independent_blogs: 'blog OR magazine OR editorial',
  guides_reviews: 'guide OR review OR insights',
};

async function searchGoogleNewsRss(
  query: string,
  language: string,
  country: string,
  excludeMega: boolean,
): Promise<RawDiscoveredCandidate[]> {
  const lang = (language || 'en').toLowerCase();
  const gl = (country || 'US').toUpperCase();
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(lang)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(gl)}:${encodeURIComponent(lang)}`;

  const res = await safeFetch(url, { timeoutMs: 8000, maxBytes: 1_500_000, skipSsrfCheck: true });
  if (!res.ok) return [];

  const $ = cheerio.load(res.body, { xmlMode: true });
  const results: RawDiscoveredCandidate[] = [];

  $('item').each((_, el) => {
    const sourceUrl = $(el).find('source').attr('url');
    const sourceTitle = $(el).find('source').text().trim();
    const articleTitle = $(el).find('title').text().trim();
    if (!sourceUrl) return;
    const domain = normalizeDomain(sourceUrl);
    if (!domain || isBlockedCandidateDomain(domain, excludeMega)) return;

    results.push({
      domain,
      url: `https://${domain}`,
      title: sourceTitle || domain,
      snippet: articleTitle || null,
      sourceName: 'Google News RSS',
    });
  });

  return results;
}

async function searchBingNewsRss(
  query: string,
  excludeMega: boolean,
): Promise<RawDiscoveredCandidate[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await safeFetch(url, { timeoutMs: 8000, maxBytes: 1_500_000, skipSsrfCheck: true });
  if (!res.ok) return [];

  const $ = cheerio.load(res.body, { xmlMode: true });
  const results: RawDiscoveredCandidate[] = [];

  $('item').each((_, el) => {
    const rawLink = $(el).find('link').text().trim();
    const title = $(el).find('title').text().trim();
    const desc = $(el).find('description').text().trim();
    let targetUrl = rawLink;

    try {
      const parsed = new URL(rawLink);
      const unwrapped = parsed.searchParams.get('url');
      if (unwrapped) targetUrl = unwrapped;
    } catch {
      // ignore
    }

    const domain = normalizeDomain(targetUrl);
    if (!domain || isBlockedCandidateDomain(domain, excludeMega)) return;

    results.push({
      domain,
      url: `https://${domain}`,
      title: domain,
      snippet: title || desc || null,
      sourceName: 'Bing News RSS',
    });
  });

  return results;
}

async function searchDuckDuckGoHtml(
  query: string,
  excludeMega: boolean,
): Promise<RawDiscoveredCandidate[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await safeFetch(url, { timeoutMs: 8000, maxBytes: 1_000_000, skipSsrfCheck: true });
  if (!res.ok) return [];

  const $ = cheerio.load(res.body);
  const results: RawDiscoveredCandidate[] = [];

  $('.result, .web-result').each((_, el) => {
    const anchor = $(el).find('a.result__a').first();
    const href = anchor.attr('href') || '';
    const title = anchor.text().trim();
    const snippet = $(el).find('.result__snippet').text().trim();

    let targetUrl = href;
    try {
      const parsed = new URL(href, 'https://html.duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) targetUrl = uddg;
    } catch {
      // ignore
    }

    const domain = normalizeDomain(targetUrl);
    if (!domain || isBlockedCandidateDomain(domain, excludeMega)) return;

    results.push({
      domain,
      url: `https://${domain}`,
      title: title || domain,
      snippet: snippet || null,
      sourceName: 'DuckDuckGo',
    });
  });

  return results;
}

async function searchSerper(
  query: string,
  apiKey: string,
  country: string,
  language: string,
  excludeMega: boolean,
): Promise<RawDiscoveredCandidate[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      gl: (country || 'us').toLowerCase(),
      hl: (language || 'en').toLowerCase(),
      num: 30,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    organic?: Array<{ link?: string; title?: string; snippet?: string }>;
  };

  const out: RawDiscoveredCandidate[] = [];
  for (const item of json.organic ?? []) {
    if (!item.link) continue;
    const domain = normalizeDomain(item.link);
    if (!domain || isBlockedCandidateDomain(domain, excludeMega)) continue;
    out.push({
      domain,
      url: `https://${domain}`,
      title: item.title || domain,
      snippet: item.snippet || null,
      sourceName: 'Serper',
    });
  }
  return out;
}

async function searchBrave(
  query: string,
  apiKey: string,
  country: string,
  language: string,
  excludeMega: boolean,
): Promise<RawDiscoveredCandidate[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=${encodeURIComponent((country || 'US').toUpperCase())}&search_lang=${encodeURIComponent((language || 'en').toLowerCase())}&count=20`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
  };

  const out: RawDiscoveredCandidate[] = [];
  for (const item of json.web?.results ?? []) {
    if (!item.url) continue;
    const domain = normalizeDomain(item.url);
    if (!domain || isBlockedCandidateDomain(domain, excludeMega)) continue;
    out.push({
      domain,
      url: `https://${domain}`,
      title: item.title || domain,
      snippet: item.description || null,
      sourceName: 'Brave Search',
    });
  }
  return out;
}

export async function discoverByNiche(
  db: AppDatabase,
  settings: AppSettings,
  input: {
    query: string;
    intent?: NicheIntent;
    language?: string;
    country?: string;
    excludeMegaPublishers?: boolean;
  },
): Promise<DiscoverySearchResult> {
  const baseQuery = input.query.trim();
  const intent = input.intent ?? 'news_articles';
  const suffix = INTENT_SUFFIX[intent];
  const webQuery = suffix ? `${baseQuery} ${suffix}` : baseQuery;
  const language = input.language || settings.targetLanguages[0] || 'en';
  const country = input.country || settings.targetCountries[0] || 'US';
  const excludeMega = input.excludeMegaPublishers ?? settings.excludeMegaPublishers;

  const usedProviders: string[] = [];
  const warnings: string[] = [];
  const tasks: Array<Promise<RawDiscoveredCandidate[]>> = [];

  usedProviders.push('Google News RSS', 'Bing News RSS', 'DuckDuckGo');
  tasks.push(
    searchGoogleNewsRss(baseQuery, language, country, excludeMega).catch(() => {
      warnings.push('Google News RSS temporarily unavailable');
      return [];
    }),
    searchBingNewsRss(baseQuery, excludeMega).catch(() => {
      warnings.push('Bing News RSS temporarily unavailable');
      return [];
    }),
    searchDuckDuckGoHtml(webQuery, excludeMega).catch(() => {
      warnings.push('DuckDuckGo HTML search temporarily unavailable');
      return [];
    }),
  );

  if (settings.serperApiKey) {
    usedProviders.push('Serper');
    tasks.push(
      searchSerper(webQuery, settings.serperApiKey, country, language, excludeMega).catch(() => {
        warnings.push('Serper API search failed');
        return [];
      }),
    );
  }

  if (settings.braveApiKey) {
    usedProviders.push('Brave Search');
    tasks.push(
      searchBrave(webQuery, settings.braveApiKey, country, language, excludeMega).catch(() => {
        warnings.push('Brave Search API failed');
        return [];
      }),
    );
  }

  const chunks = await Promise.all(tasks);
  const combined = chunks.flat();

  return annotateDiscoveredCandidates(
    db,
    combined,
    settings.contactedCooldownDays,
    usedProviders,
    warnings,
  );
}
