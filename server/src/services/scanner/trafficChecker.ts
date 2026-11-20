import type { AppDatabase } from '../../db/index.js';
import { TrancoRepo } from '../../db/repositories.js';

export async function lookupTrancoRank(db: AppDatabase, domain: string): Promise<number | null> {
  const repo = new TrancoRepo(db);
  const cached = repo.getCached(domain);
  if (cached.found) return cached.rank;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(
      `https://tranco-list.eu/api/ranks/domain/${encodeURIComponent(domain)}`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      },
    );
    clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { ranks?: Array<{ rank?: number }> };
    const rank = typeof data?.ranks?.[0]?.rank === 'number' ? data.ranks[0].rank : null;
    repo.setCached(domain, rank);
    return rank;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export function evaluateTraffic(
  monthlyVisits: number | null,
  minMonthlyVisits: number,
): 'pass' | 'fail' | 'unknown' {
  if (monthlyVisits === null || monthlyVisits === undefined) {
    return 'unknown';
  }
  return monthlyVisits >= minMonthlyVisits ? 'pass' : 'fail';
}
