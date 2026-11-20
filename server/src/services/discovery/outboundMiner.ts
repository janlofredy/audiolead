import type { AppDatabase } from '../../db/index.js';
import { SuggestionsRepo } from '../../db/repositories.js';
import { normalizeDomain } from '../scanner/domainUtils.js';
import { isBlockedCandidateDomain } from './blocklists.js';

export function mineOutboundSuggestions(
  db: AppDatabase,
  input: {
    sourceLeadId: string;
    sourceDomain: string;
    outboundLinks: string[];
    excludeMegaPublishers: boolean;
    cooldownDays: number;
  },
): number {
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

  const repo = new SuggestionsRepo(db);
  return repo.addMany(
    Array.from(candidates.entries()).map(([domain, sampleUrl]) => ({
      domain,
      sampleUrl,
      sourceType: 'outbound_mine',
      sourceLeadId: input.sourceLeadId,
      sourceDomain: input.sourceDomain,
    })),
    input.cooldownDays,
  );
}
