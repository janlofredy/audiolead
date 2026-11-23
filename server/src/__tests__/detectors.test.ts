import { describe, expect, it } from 'vitest';
import type { AppSettings, SuppressionCheckResult } from '@audiolead/shared';
import { detectAudioPlayersFromHtml } from '../services/scanner/audioDetector.js';
import { detectAdsFromHtmlDocs, parseAdsTxt } from '../services/scanner/adDetector.js';
import {
  decodeCloudflareEmail,
  extractEmailsFromHtml,
  extractStructuredPeopleFromHtml,
} from '../services/scanner/contactFinder.js';
import { scoreContactAuthority } from '../services/scanner/authorityRanker.js';
import { evaluateQualification } from '../services/scanner/qualificationEngine.js';
import * as cheerio from 'cheerio';
import {
  estimateMonthlyVisitsFromOpenPageRank,
  estimateMonthlyVisitsFromTrancoRank,
  lookupTrafficWaterfall,
  resolveMonthlyVisitsWithTranco,
} from '../services/scanner/trafficChecker.js';
import { createDatabase } from '../db/index.js';
import { TrafficCacheRepo, TrancoRepo } from '../db/repositories.js';
import {
  detectParentCompany,
  normalizeCompanyName,
} from '../services/scanner/parentCompanyDetector.js';
import { isRetryableFetchFailure } from '../services/scanner/safeFetch.js';

const DEFAULT_SETTINGS: AppSettings = {
  minMonthlyVisits: 50000,
  targetLanguages: ['en'],
  targetCountries: [],
  requireArticles: true,
  requireAds: true,
  requireNoAudioPlayer: true,
  minArticleCount: 3,
  maxDaysSinceLastArticle: 180,
  contactedCooldownDays: 90,
  excludeMegaPublishers: true,
  hunterApiKey: '',
  apolloApiKey: '',
  serperApiKey: '',
  braveApiKey: '',
  openPageRankApiKey: '',
  cloudflareRadarApiToken: '',
  googleCruxApiKey: '',
  llmProvider: 'none',
  llmApiKey: '',
  llmModel: '',
};

const CLEAR_SUP: SuppressionCheckResult = {
  status: 'clear',
  type: null,
  eventDate: null,
  expiresAt: null,
  daysRemaining: null,
  reason: null,
};

describe('audioDetector', () => {
  it('detects commercial article audio readers and native article <audio> players', () => {
    const bw = detectAudioPlayersFromHtml([
      {
        url: 'https://news.test/post-1',
        isArticle: true,
        html: `<html><body><script src="https://cdn.beyondwords.io/player.js"></script><article><p>Hello</p></article></body></html>`,
      },
    ]);
    expect(bw.hasAudioPlayer).toBe(true);
    expect(bw.providersDetected).toContain('BeyondWords');

    const trinity = detectAudioPlayersFromHtml([
      {
        url: 'https://news.test/post-2',
        isArticle: true,
        html: `<html><body><script src="https://trinitymedia.ai/player/trinity.js"></script></body></html>`,
      },
    ]);
    expect(trinity.hasAudioPlayer).toBe(true);
    expect(trinity.providersDetected).toContain('Trinity Audio');

    const nativeAudio = detectAudioPlayersFromHtml([
      {
        url: 'https://news.test/post-3',
        isArticle: true,
        html: `<html><body><article><header><h1>Story</h1><button>Listen to this article</button><audio controls src="/a.mp3"></audio></header><p>Body</p></article></body></html>`,
      },
    ]);
    expect(nativeAudio.hasAudioPlayer).toBe(true);
    expect(nativeAudio.providersDetected).toContain('Native Article Audio');
  });

  it('returns false on standard written articles without audio widgets', () => {
    const clean = detectAudioPlayersFromHtml([
      {
        url: 'https://blog.test/article',
        isArticle: true,
        html: `<html><body><article><h1>Guide to Gardening</h1><p>Start with good soil.</p></article></body></html>`,
      },
    ]);
    expect(clean.hasAudioPlayer).toBe(false);
    expect(clean.providersDetected).toHaveLength(0);
  });
});

describe('adDetector', () => {
  it('validates real IAB ads.txt and rejects HTML soft-404 pages', () => {
    const valid = parseAdsTxt(
      'google.com, pub-1234567890, DIRECT, f08c47fec0942fa0\nmediavine.com, 9981, RESELLER\n',
      'text/plain',
    );
    expect(valid.valid).toBe(true);
    expect(valid.entryCount).toBe(2);
    expect(valid.networks).toContain('Google Ad Manager (GPT)');
    expect(valid.networks).toContain('Mediavine');

    const soft404 = parseAdsTxt('<!doctype html><html><body>Page Not Found</body></html>', 'text/html');
    expect(soft404.valid).toBe(false);
    expect(soft404.entryCount).toBe(0);
  });

  it('detects active publisher ad networks in HTML/scripts and passes ad-free controls cleanly', () => {
    const adRes = detectAdsFromHtmlDocs(
      [
        {
          html: `<html><head><script src="https://scripts.mediavine.com/tags/abc.js"></script><script src="https://cdn.taboola.com/libtrc/loader.js"></script></head><body><ins class="adsbygoogle" data-ad-client="ca-pub-123"></ins></body></html>`,
        },
      ],
      { valid: false, entryCount: 0, networks: [] },
    );
    expect(adRes.hasAds).toBe(true);
    expect(adRes.adNetworksDetected).toEqual(
      expect.arrayContaining(['Mediavine', 'Taboola', 'Google AdSense']),
    );

    const noAds = detectAdsFromHtmlDocs(
      [{ html: '<html><body><h1>SaaS Landing</h1><p>Buy software</p></body></html>' }],
      { valid: false, entryCount: 0, networks: [] },
    );
    expect(noAds.hasAds).toBe(false);
  });
});

describe('contactFinder & authorityRanker', () => {
  it('decodes Cloudflare XOR obfuscated emails and [at]/[dot] patterns', () => {
    // Key = 0x55, email = "jane@pub.com" -> j(0x6a^0x55=0x3f), a(0x61^0x55=0x34), ...
    const rawEmail = 'jane@pub.com';
    const key = 0x55;
    const hex =
      key.toString(16).padStart(2, '0') +
      Array.from(rawEmail)
        .map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
        .join('');
    expect(decodeCloudflareEmail(hex)).toBe('jane@pub.com');

    const html = `
      <html><body>
        <a href="/cdn-cgi/l/email-protection#${hex}">Email</a>
        <p>Reach us at editor [at] pub [dot] com or noreply@pub.com</p>
        <img src="avatar@2x.png" />
      </body></html>
    `;
    const emails = extractEmailsFromHtml(html);
    expect(emails).toContain('jane@pub.com');
    expect(emails).toContain('editor@pub.com');
    expect(emails).not.toContain('noreply@pub.com');
    expect(emails).not.toContain('avatar@2x.png');
  });

  it('extracts DOM person cards and ranks Tier 1 decision-makers above generic fallbacks', () => {
    const html = `
      <html><body>
        <div class="team-card">
          <h3>Jane Doe</h3>
          <p class="role">Editor-in-Chief</p>
          <a href="mailto:jane@pub.com">jane@pub.com</a>
        </div>
        <div class="team-card">
          <h3>Bob Smith</h3>
          <p class="role">Staff Writer</p>
          <a href="mailto:bob@pub.com">bob@pub.com</a>
        </div>
        <a href="mailto:editorial@pub.com">editorial@pub.com</a>
      </body></html>
    `;

    const people = extractStructuredPeopleFromHtml(html, 'https://pub.com/masthead', 'pub.com');
    const ranked = people.map((p) => ({
      ...p,
      ...scoreContactAuthority({
        fullName: p.fullName,
        roleTitle: p.roleTitle,
        email: p.email,
      }),
    }));

    const jane = ranked.find((r) => r.email === 'jane@pub.com')!;
    const bob = ranked.find((r) => r.email === 'bob@pub.com')!;
    const fallback = ranked.find((r) => r.email === 'editorial@pub.com')!;

    expect(jane.tier).toBe(1);
    expect(jane.isGenericEmail).toBe(false);
    expect(bob.tier).toBe(3);
    expect(fallback.tier).toBe(4);
    expect(fallback.isGenericEmail).toBe(true);
    expect(jane.score).toBeGreaterThan(bob.score);
    expect(bob.score).toBeGreaterThan(fallback.score);

    // Article teaser card mentioning "Founder" without email/LinkedIn should be ignored
    const teaserHtml = `
      <html><body>
        <article class="post-card">
          <h3>UX Insiders</h3>
          <p>Interview with a Founder on design</p>
          <a href="/2026/11/ux-insiders/">Read more</a>
        </article>
      </body></html>
    `;
    const teaserPeople = extractStructuredPeopleFromHtml(
      teaserHtml,
      'https://pub.com/about',
      'pub.com',
    );
    expect(teaserPeople).toHaveLength(0);
  });
});

describe('qualificationEngine', () => {
  it('qualifies English ad-monetized article publishers with >=50K visits and no audio player', () => {
    const res = evaluateQualification({
      settings: DEFAULT_SETTINGS,
      suppression: CLEAR_SUP,
      blockedByBotProtection: false,
      lastError: null,
      hasArticles: true,
      articleCountFound: 12,
      latestArticleDate: new Date().toISOString().slice(0, 10),
      hasAds: true,
      hasAudioPlayer: false,
      audioProvidersDetected: [],
      detectedLanguage: 'en',
      detectedCountry: 'US',
      monthlyVisits: 120000,
      hasContacts: true,
    });
    expect(res.verdict).toBe('qualified');
    expect(res.status).toBe('contact_found');
    expect(res.score).toBe(100);
  });

  it('marks sites without traffic count as review instead of false disqualified', () => {
    const res = evaluateQualification({
      settings: DEFAULT_SETTINGS,
      suppression: CLEAR_SUP,
      blockedByBotProtection: false,
      lastError: null,
      hasArticles: true,
      articleCountFound: 8,
      latestArticleDate: new Date().toISOString().slice(0, 10),
      hasAds: true,
      hasAudioPlayer: false,
      audioProvidersDetected: [],
      detectedLanguage: 'en',
      detectedCountry: 'US',
      monthlyVisits: null,
      hasContacts: false,
    });
    expect(res.verdict).toBe('review');
    expect(res.summary).toContain('Needs traffic check');
  });

  it('disqualifies sites missing ads or already running an audio player', () => {
    const noAds = evaluateQualification({
      settings: DEFAULT_SETTINGS,
      suppression: CLEAR_SUP,
      blockedByBotProtection: false,
      lastError: null,
      hasArticles: true,
      articleCountFound: 10,
      latestArticleDate: new Date().toISOString().slice(0, 10),
      hasAds: false,
      hasAudioPlayer: false,
      audioProvidersDetected: [],
      detectedLanguage: 'en',
      detectedCountry: 'US',
      monthlyVisits: 120000,
      hasContacts: false,
    });
    expect(noAds.verdict).toBe('disqualified');

    const hasAudio = evaluateQualification({
      settings: DEFAULT_SETTINGS,
      suppression: CLEAR_SUP,
      blockedByBotProtection: false,
      lastError: null,
      hasArticles: true,
      articleCountFound: 10,
      latestArticleDate: new Date().toISOString().slice(0, 10),
      hasAds: true,
      hasAudioPlayer: true,
      audioProvidersDetected: ['BeyondWords'],
      detectedLanguage: 'en',
      detectedCountry: 'US',
      monthlyVisits: 120000,
      hasContacts: false,
    });
    expect(hasAudio.verdict).toBe('disqualified');
  });
});

describe('tranco traffic estimation', () => {
  it('estimates monthly visits from Tranco rank with monotonic decrease and clean rounding', () => {
    expect(estimateMonthlyVisitsFromTrancoRank(null)).toBeNull();
    expect(estimateMonthlyVisitsFromTrancoRank(undefined)).toBeNull();
    expect(estimateMonthlyVisitsFromTrancoRank(0)).toBeNull();
    expect(estimateMonthlyVisitsFromTrancoRank(-10)).toBeNull();
    expect(estimateMonthlyVisitsFromTrancoRank(Number.NaN)).toBeNull();

    expect(estimateMonthlyVisitsFromTrancoRank(1)).toBe(50_000_000_000);
    expect(estimateMonthlyVisitsFromTrancoRank(50_000)).toBe(1_200_000);
    expect(estimateMonthlyVisitsFromTrancoRank(250_000)).toBe(200_000);
    expect(estimateMonthlyVisitsFromTrancoRank(500_000)).toBe(80_000);
    expect(estimateMonthlyVisitsFromTrancoRank(1_000_000)).toBe(30_000);

    const midTier = estimateMonthlyVisitsFromTrancoRank(350_000);
    expect(midTier).not.toBeNull();
    expect(midTier!).toBeLessThan(200_000);
    expect(midTier!).toBeGreaterThan(80_000);
    expect(midTier! % 10_000).toBe(0);

    const longTail = estimateMonthlyVisitsFromTrancoRank(1_500_000);
    expect(longTail).toBe(20_000);
    expect(estimateMonthlyVisitsFromTrancoRank(10_000_000)).toBe(5_000);
  });

  it('resolves Tranco estimates while preserving manual, Similarweb, and discovery counts', () => {
    expect(resolveMonthlyVisitsWithTranco(null, null, 250_000)).toEqual({
      monthlyVisits: 200_000,
      visitsSource: 'tranco_estimate',
    });

    expect(resolveMonthlyVisitsWithTranco(200_000, 'tranco_estimate', 500_000)).toEqual({
      monthlyVisits: 80_000,
      visitsSource: 'tranco_estimate',
    });

    expect(resolveMonthlyVisitsWithTranco(200_000, 'tranco_estimate', null)).toEqual({
      monthlyVisits: null,
      visitsSource: null,
    });

    expect(resolveMonthlyVisitsWithTranco(145_000, 'manual', 250_000)).toEqual({
      monthlyVisits: 145_000,
      visitsSource: 'manual',
    });

    expect(resolveMonthlyVisitsWithTranco(420_500, 'similarweb_paste', 250_000)).toEqual({
      monthlyVisits: 420_500,
      visitsSource: 'similarweb_paste',
    });

    expect(resolveMonthlyVisitsWithTranco(85_000, 'discovery', 250_000)).toEqual({
      monthlyVisits: 85_000,
      visitsSource: 'discovery',
    });
  });
});

describe('parentCompanyDetector & retryable fetch classification', () => {
  it('normalizes company names and detects parent company from JSON-LD and footer', () => {
    expect(normalizeCompanyName('Static Media, Inc.')).toBe('static media');
    expect(normalizeCompanyName('Future Publishing Limited')).toBe('future publishing');
    expect(normalizeCompanyName('Valnet LLC')).toBe('valnet');

    const jsonLdHtml = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"NewsMediaOrganization","name":"Collider","parentOrganization":{"@type":"Organization","name":"Valnet Inc."}}
        </script>
      </head><body></body></html>
    `;
    expect(detectParentCompany(cheerio.load(jsonLdHtml), 'collider.com')).toBe('Valnet Inc');

    const footerHtml = `
      <html><body>
        <footer>Part of Static Media · All rights reserved.</footer>
      </body></html>
    `;
    expect(detectParentCompany(cheerio.load(footerHtml), 'slashfilm.com')).toBe('Static Media');
  });

  it('classifies timeouts and 429/503 as retryable, while skipping bot-protection blocks', () => {
    expect(
      isRetryableFetchFailure({
        ok: false,
        status: 429,
        finalUrl: 'https://example.com',
        contentType: 'text/html',
        headers: { 'retry-after': '12' },
        body: '',
        blockedByBotProtection: false,
        error: 'HTTP 429',
      }),
    ).toEqual({ retryable: true, delayMs: 12_000, reason: 'rate limited (HTTP 429)' });

    expect(
      isRetryableFetchFailure({
        ok: false,
        status: 503,
        finalUrl: 'https://example.com',
        contentType: 'text/html',
        headers: {},
        body: '',
        blockedByBotProtection: false,
        error: 'HTTP 503',
      }),
    ).toEqual({ retryable: true, delayMs: 6_000, reason: 'HTTP 503' });

    expect(
      isRetryableFetchFailure({
        ok: false,
        status: 0,
        finalUrl: 'https://example.com',
        contentType: '',
        headers: {},
        body: '',
        blockedByBotProtection: false,
        error: 'Request timed out after 10000ms',
      }),
    ).toEqual({ retryable: true, delayMs: 5_000, reason: 'timed out' });

    expect(
      isRetryableFetchFailure({
        ok: false,
        status: 403,
        finalUrl: 'https://example.com',
        contentType: 'text/html',
        headers: { 'cf-mitigated': 'challenge' },
        body: 'Just a moment...',
        blockedByBotProtection: true,
        error: 'Blocked by bot protection (HTTP 403)',
      }).retryable,
    ).toBe(false);
  });

  it('estimates visits from Open PageRank and executes traffic waterfall in priority order', async () => {
    expect(estimateMonthlyVisitsFromOpenPageRank(250_000, 4.1)).toBe(200_000);
    expect(estimateMonthlyVisitsFromOpenPageRank(null, 5.8)).toBe(600_000);
    expect(estimateMonthlyVisitsFromOpenPageRank(null, 3.6)).toBe(50_000);
    expect(estimateMonthlyVisitsFromOpenPageRank(null, 1.0)).toBeNull();

    const db = createDatabase(':memory:');
    const tranco = new TrancoRepo(db);
    const cache = new TrafficCacheRepo(db);

    // 1. Tranco wins when present
    tranco.setCached('tranco-site.com', 100_000);
    cache.setCached('tranco-site.com', 'openpagerank', 999_000, null);
    await expect(
      lookupTrafficWaterfall(db, 'tranco-site.com', {
        openPageRankApiKey: 'opr-key',
        cloudflareRadarApiToken: 'cf-token',
        googleCruxApiKey: 'crux-key',
      }),
    ).resolves.toEqual({
      trancoRank: 100_000,
      monthlyVisits: 600_000,
      visitsSource: 'tranco_estimate',
    });

    // 2. Open PageRank fallback when Tranco is null and key is configured
    tranco.setCached('opr-site.com', null);
    cache.setCached('opr-site.com', 'openpagerank', 150_000, 300_000);
    cache.setCached('opr-site.com', 'cloudflare_radar', 80_000, 500_000);
    await expect(
      lookupTrafficWaterfall(db, 'opr-site.com', {
        openPageRankApiKey: 'opr-key',
        cloudflareRadarApiToken: 'cf-token',
        googleCruxApiKey: 'crux-key',
      }),
    ).resolves.toEqual({
      trancoRank: null,
      monthlyVisits: 150_000,
      visitsSource: 'openpagerank_estimate',
    });

    // 3. Skips Open PageRank when key is empty, falling back to Cloudflare Radar
    await expect(
      lookupTrafficWaterfall(db, 'opr-site.com', {
        openPageRankApiKey: '',
        cloudflareRadarApiToken: 'cf-token',
        googleCruxApiKey: 'crux-key',
      }),
    ).resolves.toEqual({
      trancoRank: null,
      monthlyVisits: 80_000,
      visitsSource: 'cloudflare_radar_estimate',
    });

    // 4. Falls back to Google CrUX when only CrUX key is configured
    cache.setCached('crux-only.com', 'crux', 50_000, null);
    tranco.setCached('crux-only.com', null);
    await expect(
      lookupTrafficWaterfall(db, 'crux-only.com', {
        openPageRankApiKey: '',
        cloudflareRadarApiToken: '',
        googleCruxApiKey: 'crux-key',
      }),
    ).resolves.toEqual({
      trancoRank: null,
      monthlyVisits: 50_000,
      visitsSource: 'crux_estimate',
    });
  });
});
