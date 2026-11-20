import type { DiscoverySearchResult } from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import { normalizeDomain, parseTrafficNumber } from '../scanner/domainUtils.js';
import {
  annotateDiscoveredCandidates,
  type RawDiscoveredCandidate,
} from './candidateAnnotator.js';

const DOMAIN_TOKEN_REGEX =
  /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{2,})+)(?:\/[^\s,;]*)?/gi;

const TRAFFIC_TOKEN_REGEX =
  /\b(\d+(?:[.,]\d+)?\s*[KMB]|\d{1,3}(?:,\d{3})+)\b/i;

export function parseSimilarwebPaste(
  db: AppDatabase,
  rawText: string,
  cooldownDays: number,
): DiscoverySearchResult {
  const lines = rawText.split(/\r?\n/);
  const extracted = new Map<string, RawDiscoveredCandidate>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const matches = Array.from(line.matchAll(DOMAIN_TOKEN_REGEX));
    if (matches.length === 0) continue;

    // Look for a traffic figure on the same line or the next 2 lines (common in Similarweb copy-paste)
    const contextWindow = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
    const trafficMatch = TRAFFIC_TOKEN_REGEX.exec(contextWindow);
    const visits = trafficMatch ? parseTrafficNumber(trafficMatch[1]) : null;

    for (const m of matches) {
      const domain = normalizeDomain(m[1]);
      if (!domain || domain === 'similarweb.com') continue;

      const prev = extracted.get(domain);
      if (!prev) {
        extracted.set(domain, {
          domain,
          url: `https://${domain}`,
          title: domain,
          snippet: visits ? `Estimated ${visits.toLocaleString()} visits from Similarweb paste` : 'Pasted from Similarweb',
          monthlyVisits: visits,
          sourceName: 'Similarweb Paste',
        });
      } else if (prev.monthlyVisits === null && visits !== null) {
        prev.monthlyVisits = visits;
      }
    }
  }

  return annotateDiscoveredCandidates(
    db,
    Array.from(extracted.values()),
    cooldownDays,
    ['Similarweb Paste'],
  );
}
