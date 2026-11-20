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
