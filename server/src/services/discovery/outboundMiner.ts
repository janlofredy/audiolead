import type { AppDatabase } from '../../db/index.js';
import { SuggestionsRepo } from '../../db/repositories.js';
import { normalizeDomain } from '../scanner/domainUtils.js';
import {
  lookupTrafficWaterfall,
  type TrafficWaterfallSettings,
} from '../scanner/trafficChecker.js';
import { isBlockedCandidateDomain } from './blocklists.js';

export async function mineOutboundSuggestions(
  db: AppDatabase,
  input: {
    sourceLeadId: string;
    sourceDomain: string;
    outboundLinks: string[];
    excludeMegaPublishers: boolean;
    cooldownDays: number;
    minMonthlyVisits: number;
    trafficSettings?: TrafficWaterfallSettings;
  },
): Promise<number> {
  const candidates = new Map<string, string>();
  const skipLinkHint = /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp3|mp4|xml|zip)$/i;

  for (const rawUrl of input.outboundLinks) {
    if (skipLinkHint.test(rawUrl)) continue;
    const domain = normalizeDomain(rawUrl);
    if (!domain || domain === input.sourceDomain) continue;
    if (isBlockedCandidateDomain(domain, input.excludeMegaPublishers)) continue;
    if (!candidates.has(domain)) {
      candidates.set(domain, `https://${domain}`);
    }
    if (candidates.size >= 12) break;
  }

  if (candidates.size === 0) return 0;

  const entries = Array.from(candidates.entries());
  const qualified: Array<{
    domain: string;
    sampleUrl: string;
    estimatedVisits: number | null;
  }> = [];

  const waterfallSettings: TrafficWaterfallSettings = input.trafficSettings ?? {
    openPageRankApiKey: '',
    cloudflareRadarApiToken: '',
    googleCruxApiKey: '',
  };

  for (let i = 0; i < entries.length; i += 4) {
    const batch = entries.slice(i, i + 4);
    const resolved = await Promise.all(
      batch.map(async ([domain, sampleUrl]) => {
        const traffic = await lookupTrafficWaterfall(db, domain, waterfallSettings);
        return { domain, sampleUrl, estimatedVisits: traffic.monthlyVisits };
      }),
    );
    for (const item of resolved) {
      if (
        input.minMonthlyVisits > 0 &&
        (item.estimatedVisits === null || item.estimatedVisits < input.minMonthlyVisits)
      ) {
        continue;
      }
      qualified.push(item);
    }
  }

  if (qualified.length === 0) return 0;

  const repo = new SuggestionsRepo(db);
  return repo.addMany(
    qualified.map((item) => ({
      domain: item.domain,
      sampleUrl: item.sampleUrl,
      estimatedVisits: item.estimatedVisits,
      sourceType: 'outbound_mine',
      sourceLeadId: input.sourceLeadId,
      sourceDomain: input.sourceDomain,
    })),
    input.cooldownDays,
  );
}
