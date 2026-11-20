import type {
  DiscoveryCandidate,
  DiscoveryCandidateStatus,
  DiscoverySearchResult,
  DiscoverySearchSummary,
} from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import {
  evaluateSuppressionRule,
  LeadsRepo,
  SuppressionRepo,
} from '../../db/repositories.js';
import { todayIsoDate } from '../scanner/domainUtils.js';

export interface RawDiscoveredCandidate {
  domain: string;
  url: string;
  title?: string | null;
  snippet?: string | null;
  monthlyVisits?: number | null;
  sourceName: string;
}

export function annotateDiscoveredCandidates(
  db: AppDatabase,
  rawList: RawDiscoveredCandidate[],
  cooldownDays: number,
  usedProviders: string[],
  warnings: string[] = [],
): DiscoverySearchResult {
  // Deduplicate by domain preserving highest-metadata entry
  const deduped = new Map<string, RawDiscoveredCandidate>();
  for (const item of rawList) {
    const domain = item.domain.toLowerCase();
    const prev = deduped.get(domain);
    if (!prev) {
      deduped.set(domain, { ...item, domain });
    } else {
      deduped.set(domain, {
        ...prev,
        title: prev.title || item.title,
        snippet: prev.snippet || item.snippet,
        monthlyVisits: prev.monthlyVisits ?? item.monthlyVisits,
      });
    }
  }

  const domains = Array.from(deduped.keys());
  const existingLeadDomains = new LeadsRepo(db).getExistingDomains(domains);
  const supMap = new SuppressionRepo(db).getRawMapByDomains(domains);
  const today = todayIsoDate();

  const summary: DiscoverySearchSummary = {
    totalFound: domains.length,
    freshCount: 0,
    inPipelineCount: 0,
    cooldownCount: 0,
    optedOutCount: 0,
    cooldownExpiredCount: 0,
    usedProviders,
    warnings,
  };

  const candidates: DiscoveryCandidate[] = [];

  for (const item of deduped.values()) {
    const suppression = evaluateSuppressionRule(
      supMap.get(item.domain),
      cooldownDays,
      today,
    );

    let status: DiscoveryCandidateStatus;
    if (suppression.status === 'opted_out') {
      status = 'opted_out';
      summary.optedOutCount++;
    } else if (suppression.status === 'cooldown') {
      status = 'cooldown';
      summary.cooldownCount++;
    } else if (existingLeadDomains.has(item.domain)) {
      status = 'in_pipeline';
      summary.inPipelineCount++;
    } else if (suppression.status === 'cooldown_expired') {
      status = 'cooldown_expired';
      summary.cooldownExpiredCount++;
    } else {
      status = 'fresh';
      summary.freshCount++;
    }

    candidates.push({
      domain: item.domain,
      url: item.url,
      title: item.title ?? null,
      snippet: item.snippet ?? null,
      monthlyVisits: item.monthlyVisits ?? null,
      sourceName: item.sourceName,
      status,
      suppression,
    });
  }

  // Sort eligible/fresh candidates first, suppressed/existing last
  const rankOrder: Record<DiscoveryCandidateStatus, number> = {
    fresh: 0,
    cooldown_expired: 1,
    in_pipeline: 2,
    cooldown: 3,
    opted_out: 4,
  };
  candidates.sort((a, b) => rankOrder[a.status] - rankOrder[b.status]);

  return { candidates, summary };
}
