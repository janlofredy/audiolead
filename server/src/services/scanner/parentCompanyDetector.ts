import type * as cheerio from 'cheerio';

const LEGAL_SUFFIX_REGEX =
  /\b(incorporated|inc|llc|ltd|limited|corporation|corp|plc|llp|gmbh|pty|co)\b/gi;

const GENERIC_COMPANY_PHRASES = new Set([
  'all rights reserved',
  'privacy policy',
  'terms of use',
  'terms of service',
  'cookie policy',
  'about us',
  'contact us',
  'home',
  'website',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes a company name for case-insensitive, punctuation-insensitive matching,
 * stripping common legal entity suffixes (Inc., LLC, Ltd., plc, etc.).
 */
export function normalizeCompanyName(raw: string | null | undefined): string {
  if (!raw) return '';
  const base = raw
    .toLowerCase()
    .replace(/©/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!base) return '';

  const stripped = base
    .replace(LEGAL_SUFFIX_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped.length >= 2 ? stripped : base;
}

/**
 * Checks whether a lead's detected parent company matches a suppressed parent company rule.
 */
export function doesCompanyMatchRule(
  leadCompany: string | null | undefined,
  ruleNormalizedName: string,
): boolean {
  const normLead = normalizeCompanyName(leadCompany);
  if (!normLead || !ruleNormalizedName) return false;
  if (normLead === ruleNormalizedName) return true;
  if (ruleNormalizedName.length >= 4) {
    const boundary = new RegExp(`(^|\\s)${escapeRegex(ruleNormalizedName)}(\\s|$)`);
    return boundary.test(normLead);
  }
  return false;
}

function cleanExtractedCompany(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/\ball rights reserved\.?/gi, '')
    .replace(/^[-–—|:•·,\s]+|[-–—|:•·.,\s]+$/g, '')
    .trim();

  // Drop trailing year fragments or copyright symbols
  cleaned = cleaned.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/^[-–—|:•·,\s]+|[-–—|:•·.,\s]+$/g, '').trim();

  if (cleaned.length < 2 || cleaned.length > 80) return null;
  if (GENERIC_COMPANY_PHRASES.has(cleaned.toLowerCase())) return null;
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned;
}

function domainStem(domain: string): string {
  return domain.replace(/^www\./i, '').split('.')[0]?.toLowerCase() ?? '';
}

function extractFromJsonLdNode(
  node: unknown,
  stem: string,
  depth = 0,
): string | null {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = extractFromJsonLdNode(item, stem, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;
  const parentOrg = obj.parentOrganization as Record<string, unknown> | undefined;
  if (parentOrg && typeof parentOrg.name === 'string') {
    const cleaned = cleanExtractedCompany(parentOrg.name);
    if (cleaned) return cleaned;
  }

  const publisher = obj.publisher as Record<string, unknown> | undefined;
  if (publisher) {
    const pubParent = publisher.parentOrganization as Record<string, unknown> | undefined;
    if (pubParent && typeof pubParent.name === 'string') {
      const cleaned = cleanExtractedCompany(pubParent.name);
      if (cleaned) return cleaned;
    }
  }

  const holder = obj.copyrightHolder as Record<string, unknown> | undefined;
  if (holder && typeof holder.name === 'string') {
    const cleaned = cleanExtractedCompany(holder.name);
    if (cleaned) return cleaned;
  }

  if (publisher && typeof publisher.name === 'string') {
    const cleaned = cleanExtractedCompany(publisher.name);
    if (cleaned && normalizeCompanyName(cleaned).replace(/\s+/g, '') !== stem) {
      return cleaned;
    }
  }

  if (Array.isArray(obj['@graph'])) {
    return extractFromJsonLdNode(obj['@graph'], stem, depth + 1);
  }

  return null;
}

/**
 * Extracts a likely parent company / publisher owner name from homepage HTML
 * using JSON-LD, meta tags, and footer copyright/ownership notices.
 */
export function detectParentCompany(
  $home: cheerio.CheerioAPI,
  domain: string,
): string | null {
  const stem = domainStem(domain);

  // 1. JSON-LD structured data
  const ldScripts = $home('script[type="application/ld+json"]').toArray();
  for (const el of ldScripts) {
    const rawJson = $home(el).text().trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const found = extractFromJsonLdNode(parsed, stem);
      if (found) return found;
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  // 2. Meta tags
  const metaSelectors = [
    'meta[name="copyright"]',
    'meta[name="publisher"]',
    'meta[name="dc.publisher"]',
    'meta[name="DC.publisher"]',
  ];
  for (const sel of metaSelectors) {
    const val = cleanExtractedCompany($home(sel).attr('content'));
    if (val) return val;
  }

  // 3. Footer ownership & copyright patterns
  const footerText = $home('footer, [role="contentinfo"], .footer, #footer')
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  if (footerText) {
    const ownershipPatterns = [
      /\b(?:part of|a division of|owned by|published by|a property of|a subsidiary of)\s+([A-Z][A-Za-z0-9&.,' -]{2,60})/i,
      /(?:©|copyright)\s*(?:©\s*)?(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*)?([A-Z][A-Za-z0-9&.,' -]{2,60})/i,
    ];

    for (const pat of ownershipPatterns) {
      const m = pat.exec(footerText);
      if (m?.[1]) {
        const candidate = cleanExtractedCompany(m[1].split(/[|•·\n]/)[0]);
        if (candidate) return candidate;
      }
    }
  }

  return null;
}
