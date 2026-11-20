import dns from 'node:dns/promises';
import * as cheerio from 'cheerio';
import type { AuthorityTier, Contact } from '@audiolead/shared';
import { safeFetch } from './safeFetch.js';
import { normalizeDomain } from './domainUtils.js';
import { isGenericRoleEmail, scoreContactAuthority } from './authorityRanker.js';

export interface DiscoveredContactCandidate {
  fullName: string | null;
  roleTitle: string | null;
  authorityTier: AuthorityTier;
  authorityScore: number;
  email: string | null;
  isGenericEmail: boolean;
  mxValid: boolean | null;
  linkedinUrl: string | null;
  sourceUrl: string;
  sourceType: Contact['sourceType'];
}

const CONTACT_PAGE_KEYWORDS =
  /\b(about|team|staff|masthead|editorial|leadership|people|contact|advertise|partnership|partners|impressum|company|writers|contributors)\b/i;

const CANDIDATE_PATHS = [
  '/about',
  '/about-us',
  '/team',
  '/masthead',
  '/editorial',
  '/contact',
  '/contact-us',
  '/advertise',
  '/partnerships',
  '/impressum',
];

const NOISE_EMAIL_LOCAL =
  /^(noreply|no-reply|donotreply|do-not-reply|privacy|gdpr|dpo|dmca|abuse|legal|security|unsubscribe|bounce|mailer-daemon|postmaster|careers|jobs|hr|billing|invoices|sentry|support-noreply)$/i;

const NOISE_EMAIL_DOMAINS = new Set([
  'example.com',
  'domain.com',
  'yourdomain.com',
  'yoursite.com',
  'email.com',
  'sentry.io',
  'sentry.wixpress.com',
  'wixpress.com',
  'w3.org',
  'schema.org',
]);

const ASSET_EXTENSION = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|pdf)$/i;

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12}/g;
const OBFUSCATED_EMAIL_REGEX =
  /([a-zA-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([a-zA-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*([a-zA-Z]{2,10})/gi;

const TITLE_HINT_REGEX =
  /\b(founder|co-founder|cofounder|owner|ceo|president|publisher|managing director|editor[- ]in[- ]chief|executive editor|managing editor|editorial director|senior editor|associate editor|digital editor|chief\s+\w+\s+officer|cto|cdo|vp\b|vice president|head of\s+\w+|director of\s+\w+|webmaster|product manager|content manager|partnerships)\b/i;

/**
 * Decodes Cloudflare's XOR email obfuscation (`data-cfemail` hex payload).
 */
export function decodeCloudflareEmail(hex: string): string | null {
  const cleaned = hex.trim();
  if (!/^[0-9a-fA-F]{4,}$/.test(cleaned) || cleaned.length % 2 !== 0) {
    return null;
  }
  const key = Number.parseInt(cleaned.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < cleaned.length; i += 2) {
    const byte = Number.parseInt(cleaned.slice(i, i + 2), 16);
    out += String.fromCharCode(byte ^ key);
  }
  return out.includes('@') ? out.trim().toLowerCase() : null;
}

export function cleanValidEmail(raw: string): string | null {
  const trimmed = raw
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .trim()
    .replace(/^[\s<>"'(]+|[\s>"').,;]+$/g, '')
    .toLowerCase();

  if (!trimmed || trimmed.length > 120) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,12}$/.test(trimmed)) return null;
  if (ASSET_EXTENSION.test(trimmed)) return null;

  const [local, emailDomain] = trimmed.split('@');
  if (!local || !emailDomain) return null;
  if (NOISE_EMAIL_LOCAL.test(local)) return null;
  if (NOISE_EMAIL_DOMAINS.has(emailDomain)) return null;

  return trimmed;
}

export function extractEmailsFromHtml(html: string): string[] {
  const found = new Set<string>();
  const $ = cheerio.load(html);

  // 1. Cloudflare protected emails
  $('[data-cfemail]').each((_, el) => {
    const hex = $(el).attr('data-cfemail');
    if (hex) {
      const decoded = decodeCloudflareEmail(hex);
      const valid = decoded ? cleanValidEmail(decoded) : null;
      if (valid) found.add(valid);
    }
  });

  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const hex = href.split('#')[1];
    if (hex) {
      const decoded = decodeCloudflareEmail(hex);
      const valid = decoded ? cleanValidEmail(decoded) : null;
      if (valid) found.add(valid);
    }
  });

  // 2. mailto links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const valid = cleanValidEmail(href);
      if (valid) found.add(valid);
    }
  });

  // 3. Visible text emails & [at]/[dot] obfuscation
  $('script, style, noscript').remove();
  const text = $('body').text();

  for (const m of text.matchAll(EMAIL_REGEX)) {
    const valid = cleanValidEmail(m[0]);
    if (valid) found.add(valid);
  }

  for (const m of text.matchAll(OBFUSCATED_EMAIL_REGEX)) {
    const assembled = `${m[1]}@${m[2]}.${m[3]}`;
    const valid = cleanValidEmail(assembled);
    if (valid) found.add(valid);
  }

  return Array.from(found);
}

function looksLikePersonName(text: string): boolean {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 4 || cleaned.length > 48) return false;
  if (/[@/\\|<>0-9]/.test(cleaned)) return false;
  const words = cleaned.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  if (TITLE_HINT_REGEX.test(cleaned)) return false;
  return words.every((w) => /^[A-Z\u00C0-\u017F][a-zA-Z\u00C0-\u017F'.-]+$/.test(w));
}

export function extractStructuredPeopleFromHtml(
  html: string,
  pageUrl: string,
  siteDomain: string,
): Array<{
  fullName: string | null;
  roleTitle: string | null;
  email: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
}> {
  const $ = cheerio.load(html);
  const people: Array<{
    fullName: string | null;
    roleTitle: string | null;
    email: string | null;
    linkedinUrl: string | null;
    sourceUrl: string;
  }> = [];

  // 1. JSON-LD Person entities
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() || '') as unknown;
      const stack: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length > 0) {
        const item = stack.shift();
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        if (Array.isArray(obj['@graph'])) stack.push(...obj['@graph']);
        if (obj['@type'] === 'Person' && typeof obj.name === 'string') {
          const email =
            typeof obj.email === 'string' ? cleanValidEmail(obj.email) : null;
          const title = typeof obj.jobTitle === 'string' ? obj.jobTitle.trim() : null;
          const sameAs = Array.isArray(obj.sameAs) ? obj.sameAs : [obj.sameAs];
          const linkedin =
            sameAs.find((u): u is string => typeof u === 'string' && u.includes('linkedin.com/in/')) ??
            null;
          if (email || title) {
            people.push({
              fullName: obj.name.trim(),
              roleTitle: title,
              email,
              linkedinUrl: linkedin,
              sourceUrl: pageUrl,
            });
          }
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  });

  // 2. DOM person cards (elements containing a heading/strong name + role or email/linkedin)
  const seenCardTexts = new Set<string>();
  $('div, li, article, section').each((_, container) => {
    const $card = $(container);
    const childCards = $card.find('div, li, article').length;
    if (childCards > 6) return; // avoid matching huge wrapper containers

    const text = $card.text().replace(/\s+/g, ' ').trim();
    if (text.length < 10 || text.length > 350) return;
    if (seenCardTexts.has(text)) return;

    const hasTitle = TITLE_HINT_REGEX.test(text);
    const cardEmailHref = $card.find('a[href^="mailto:"]').first().attr('href');
    const cfHex = $card.find('[data-cfemail]').first().attr('data-cfemail');
    let email = cardEmailHref ? cleanValidEmail(cardEmailHref) : null;
    if (!email && cfHex) {
      const decoded = decodeCloudflareEmail(cfHex);
      email = decoded ? cleanValidEmail(decoded) : null;
    }
    if (!email) {
      const rawMatch = text.match(EMAIL_REGEX);
      if (rawMatch) email = cleanValidEmail(rawMatch[0]);
    }

    const linkedinUrl =
      $card.find('a[href*="linkedin.com/in/"]').first().attr('href') ?? null;

    if (!hasTitle && !email && !linkedinUrl) return;

    // Skip article teaser cards that happen to contain a role keyword (e.g. "Founder") with no email or LinkedIn
    const linksInside = $card
      .find('a[href]')
      .map((__, a) => $(a).attr('href') || '')
      .get();
    const looksLikeArticleTeaser = linksInside.some((href) =>
      /\/20[12]\d\/|\/articles?\/|\/blog\/|\/news\/|\/category\//i.test(href),
    );
    if (looksLikeArticleTeaser && !email && !linkedinUrl) return;

    let fullName: string | null = null;
    $card.find('h2, h3, h4, h5, strong, .name, [class*="name"]').each((__, nameEl) => {
      if (fullName) return;
      const cand = $(nameEl).text().trim();
      if (looksLikePersonName(cand)) fullName = cand;
    });

    if (!fullName && !email) return;

    let roleTitle: string | null = null;
    $card.find('p, span, div, .role, .title, [class*="title"], [class*="role"]').each((__, roleEl) => {
      if (roleTitle) return;
      const cand = $(roleEl).text().replace(/\s+/g, ' ').trim();
      if (cand.length >= 3 && cand.length <= 80 && cand !== fullName && TITLE_HINT_REGEX.test(cand)) {
        roleTitle = cand;
      }
    });
    if (!roleTitle) {
      const m = TITLE_HINT_REGEX.exec(text);
      if (m) roleTitle = m[0];
    }

    // Prefer site-matching emails or generic editorial emails over third-party links
    if (email) {
      const eDomain = normalizeDomain(email.split('@')[1]);
      if (eDomain && eDomain !== siteDomain && !fullName) return;
    }

    seenCardTexts.add(text);
    people.push({
      fullName,
      roleTitle,
      email,
      linkedinUrl,
      sourceUrl: pageUrl,
    });
  });

  // 3. Fallback: every extracted email on the page not yet tied to a person
  const allEmails = extractEmailsFromHtml(html);
  const coveredEmails = new Set(people.map((p) => p.email).filter(Boolean));

  for (const email of allEmails) {
    if (coveredEmails.has(email)) continue;
    const eDomain = normalizeDomain(email.split('@')[1]);
    // Keep same-domain emails (or Gmail/Proton if listed on small independent blog contact page)
    const isFreeMail = /^(gmail\.com|yahoo\.com|outlook\.com|hotmail\.com|proton\.me|protonmail\.com)$/.test(
      email.split('@')[1] || '',
    );
    if (eDomain && eDomain !== siteDomain && !isFreeMail) continue;

    people.push({
      fullName: null,
      roleTitle: null,
      email,
      linkedinUrl: null,
      sourceUrl: pageUrl,
    });
  }

  return people;
}

async function checkMxValid(emailDomain: string, cache: Map<string, boolean>): Promise<boolean> {
  if (cache.has(emailDomain)) return cache.get(emailDomain)!;

  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3500));
  const lookup = dns
    .resolveMx(emailDomain)
    .then((records) => Array.isArray(records) && records.length > 0)
    .catch(() => false);

  const valid = await Promise.race([lookup, timer]);
  cache.set(emailDomain, valid);
  return valid;
}

export async function crawlSiteContacts(
  baseUrl: string,
  domain: string,
  homepageHtml: string,
): Promise<DiscoveredContactCandidate[]> {
  const $home = cheerio.load(homepageHtml);
  const discoveredUrls = new Map<string, number>(); // url -> priority

  $home('a[href]').each((_, el) => {
    const href = $home(el).attr('href');
    const linkText = $home(el).text().trim();
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl);
      if (normalizeDomain(abs.hostname) !== domain) return;
      const pathAndText = `${abs.pathname} ${linkText}`;
      if (!CONTACT_PAGE_KEYWORDS.test(pathAndText)) return;
      const priority = /team|masthead|editorial|leadership|staff/i.test(pathAndText)
        ? 3
        : /about|contact/i.test(pathAndText)
          ? 2
          : 1;
      const clean = `${abs.origin}${abs.pathname}`;
      discoveredUrls.set(clean, Math.max(discoveredUrls.get(clean) ?? 0, priority));
    } catch {
      // ignore
    }
  });

  // Add standard candidate paths if nav links were sparse
  for (const path of CANDIDATE_PATHS) {
    try {
      const candidate = new URL(path, baseUrl).toString();
      if (!discoveredUrls.has(candidate)) {
        discoveredUrls.set(candidate, 0);
      }
    } catch {
      // ignore
    }
  }

  const pagesToFetch = Array.from(discoveredUrls.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([u]) => u);

  const rawPeople = extractStructuredPeopleFromHtml(homepageHtml, baseUrl, domain);

  // Fetch priority contact pages in small parallel pairs
  for (let i = 0; i < pagesToFetch.length; i += 2) {
    const batch = pagesToFetch.slice(i, i + 2);
    const results = await Promise.all(
      batch.map((pageUrl) => safeFetch(pageUrl, { timeoutMs: 7000, maxBytes: 1_500_000 })),
    );
    for (const res of results) {
      if (!res.ok || !res.contentType.toLowerCase().includes('html')) continue;
      rawPeople.push(...extractStructuredPeopleFromHtml(res.body, res.finalUrl, domain));
    }
  }

  // Deduplicate by email or (fullName + roleTitle)
  const deduped = new Map<string, (typeof rawPeople)[number]>();
  for (const p of rawPeople) {
    if (!p.email && !p.fullName) continue;
    const key = p.email
      ? `email:${p.email.toLowerCase()}`
      : `person:${(p.fullName || '').toLowerCase()}|${(p.roleTitle || '').toLowerCase()}`;
    const prev = deduped.get(key);
    if (!prev) {
      deduped.set(key, p);
    } else {
      // Merge missing name/title/linkedin
      deduped.set(key, {
        fullName: prev.fullName || p.fullName,
        roleTitle: prev.roleTitle || p.roleTitle,
        email: prev.email || p.email,
        linkedinUrl: prev.linkedinUrl || p.linkedinUrl,
        sourceUrl: prev.fullName ? prev.sourceUrl : p.sourceUrl,
      });
    }
  }

  const mxCache = new Map<string, boolean>();
  const ranked: DiscoveredContactCandidate[] = [];

  for (const item of deduped.values()) {
    const auth = scoreContactAuthority({
      fullName: item.fullName,
      roleTitle: item.roleTitle,
      email: item.email,
      sourcePage: item.sourceUrl,
    });

    let mxValid: boolean | null = null;
    if (item.email) {
      const eDomain = item.email.split('@')[1];
      if (eDomain) {
        mxValid = await checkMxValid(eDomain, mxCache);
      }
    }

    ranked.push({
      fullName: item.fullName,
      roleTitle: item.roleTitle,
      authorityTier: auth.tier,
      authorityScore: auth.score,
      email: item.email,
      isGenericEmail: item.email ? isGenericRoleEmail(item.email) : false,
      mxValid,
      linkedinUrl: item.linkedinUrl,
      sourceUrl: item.sourceUrl,
      sourceType: 'crawled',
    });
  }

  ranked.sort((a, b) => {
    if (Boolean(a.email) !== Boolean(b.email)) return a.email ? -1 : 1;
    if (a.isGenericEmail !== b.isGenericEmail) return a.isGenericEmail ? 1 : -1;
    if (a.authorityTier !== b.authorityTier) return a.authorityTier - b.authorityTier;
    return b.authorityScore - a.authorityScore;
  });

  return ranked.slice(0, 15);
}
