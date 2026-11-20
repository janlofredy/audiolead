import * as cheerio from 'cheerio';
import type { AppSettings, DiscoverySearchResult } from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import { LeadsRepo } from '../../db/repositories.js';
import { normalizeDomain } from '../scanner/domainUtils.js';
import { safeFetch } from '../scanner/safeFetch.js';
import { isBlockedCandidateDomain } from './blocklists.js';
import { discoverByNiche } from './nicheDiscovery.js';
import {
  annotateDiscoveredCandidates,
  type RawDiscoveredCandidate,
} from './candidateAnnotator.js';

function deriveTopicQuery(seedDomain: string, title: string | null, description: string | null, keywords: string[]): string {
  if (keywords.length >= 2) {
    return keywords.slice(0, 3).join(' ');
  }
  const source = `${title || ''} ${description || ''}`
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const brandToken = seedDomain.split('.')[0].toLowerCase();
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'about',
    'news', 'blog', 'home', 'official', 'site', 'website', 'online', brandToken,
  ]);
  const words = source
    .split(' ')
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !stop.has(w));
  const unique = Array.from(new Set(words)).slice(0, 4);
  return unique.length > 0 ? unique.join(' ') : seedDomain.split('.')[0];
}

export async function discoverSimilarSites(
  db: AppDatabase,
  settings: AppSettings,
  input: { leadId?: string; seedUrl?: string },
): Promise<DiscoverySearchResult & { seedDomain: string; derivedQuery: string }> {
  const leadsRepo = new LeadsRepo(db);
  let seedDomain: string | null = null;
  let seedTitle: string | null = null;
  let seedDesc: string | null = null;
  let seedKeywords: string[] = [];
  const outboundCandidates: RawDiscoveredCandidate[] = [];

  if (input.leadId) {
    const lead = leadsRepo.getById(input.leadId, settings.contactedCooldownDays);
    if (!lead) {
      throw new Error('Seed lead not found');
    }
    seedDomain = lead.domain;
    seedTitle = lead.siteTitle;
    seedDesc = lead.description;
    seedKeywords = lead.keywords;
  } else if (input.seedUrl) {
    seedDomain = normalizeDomain(input.seedUrl);
  }

  if (!seedDomain) {
    throw new Error('Please provide a valid seed website or lead');
  }

  // Fetch seed homepage to gather outbound editorial links & metadata if needed
  const homeRes = await safeFetch(`https://${seedDomain}`, { timeoutMs: 8000, maxBytes: 1_500_000 });
  if (homeRes.ok) {
    const $ = cheerio.load(homeRes.body);
    if (!seedTitle) {
      seedTitle =
        $('meta[property="og:site_name"]').attr('content')?.trim() ||
        $('title').first().text().trim() ||
        null;
    }
    if (!seedDesc) {
      seedDesc =
        $('meta[name="description"]').attr('content')?.trim() ||
        $('meta[property="og:description"]').attr('content')?.trim() ||
        null;
    }
    if (seedKeywords.length === 0) {
      seedKeywords = ($('meta[name="keywords"]').attr('content') || '')
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length >= 3 && k.length <= 30)
        .slice(0, 6);
    }

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const abs = new URL(href, homeRes.finalUrl);
        const targetDomain = normalizeDomain(abs.hostname);
        if (!targetDomain || targetDomain === seedDomain) return;
        if (isBlockedCandidateDomain(targetDomain, settings.excludeMegaPublishers)) return;
        outboundCandidates.push({
          domain: targetDomain,
          url: `https://${targetDomain}`,
          title: $(el).text().trim().slice(0, 80) || targetDomain,
          snippet: `Linked from ${seedDomain}`,
          sourceName: `Outbound from ${seedDomain}`,
        });
      } catch {
        // ignore
      }
    });
  }

  const derivedQuery = deriveTopicQuery(seedDomain, seedTitle, seedDesc, seedKeywords);

  // Run niche search on the seed's derived topic
  const nicheResult = await discoverByNiche(db, settings, {
    query: derivedQuery,
    intent: 'independent_blogs',
    excludeMegaPublishers: settings.excludeMegaPublishers,
  });

  const combinedRaw: RawDiscoveredCandidate[] = [
    ...outboundCandidates.slice(0, 20),
    ...nicheResult.candidates
      .filter((c) => c.domain !== seedDomain)
      .map((c) => ({
        domain: c.domain,
        url: c.url,
        title: c.title,
        snippet: c.snippet,
        monthlyVisits: c.monthlyVisits,
        sourceName: c.sourceName,
      })),
  ];

  const final = annotateDiscoveredCandidates(
    db,
    combinedRaw.filter((c) => c.domain !== seedDomain),
    settings.contactedCooldownDays,
    Array.from(new Set([`Seed (${seedDomain})`, ...nicheResult.summary.usedProviders])),
    nicheResult.summary.warnings,
  );

  return {
    ...final,
    seedDomain,
    derivedQuery,
  };
}
