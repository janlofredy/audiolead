import type { Lead } from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import { TrancoRepo } from '../../db/repositories.js';

const TRANCO_VISIT_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1, 50_000_000_000],
  [100, 200_000_000],
  [1_000, 35_000_000],
  [10_000, 5_000_000],
  [50_000, 1_200_000],
  [100_000, 600_000],
  [250_000, 200_000],
  [500_000, 80_000],
  [750_000, 45_000],
  [1_000_000, 30_000],
];

function roundToSigFigs(value: number, sigFigs = 2): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = Math.floor(Math.log10(value));
  const factor = Math.pow(10, magnitude - sigFigs + 1);
  return Math.max(1_000, Math.round(value / factor) * factor);
}

/**
 * Estimates monthly visits from a global Tranco rank using log-log interpolation
 * over traffic anchor points.
 */
export function estimateMonthlyVisitsFromTrancoRank(
  rank: number | null | undefined,
): number | null {
  if (rank === null || rank === undefined || !Number.isFinite(rank) || rank < 1) {
    return null;
  }

  if (rank === 1 || rank <= TRANCO_VISIT_ANCHORS[0][0]) {
    return TRANCO_VISIT_ANCHORS[0][1];
  }

  for (let i = 0; i < TRANCO_VISIT_ANCHORS.length - 1; i++) {
    const [r1, v1] = TRANCO_VISIT_ANCHORS[i];
    const [r2, v2] = TRANCO_VISIT_ANCHORS[i + 1];
    if (rank <= r2) {
      const t = (Math.log10(rank) - Math.log10(r1)) / (Math.log10(r2) - Math.log10(r1));
      const raw = Math.pow(10, Math.log10(v1) + t * (Math.log10(v2) - Math.log10(v1)));
      return roundToSigFigs(raw, 2);
    }
  }

  const extrapolated = Math.max(5_000, Math.round(30_000 * (1_000_000 / rank)));
  return roundToSigFigs(extrapolated, 2);
}

/**
 * Resolves a lead's monthly visits using a Tranco rank estimate while preserving
 * explicit manual, Similarweb paste, or discovery values.
 */
export function resolveMonthlyVisitsWithTranco(
  currentVisits: number | null,
  currentSource: Lead['visitsSource'],
  trancoRank: number | null,
): { monthlyVisits: number | null; visitsSource: Lead['visitsSource'] } {
  if (currentVisits !== null && currentSource !== 'tranco_estimate') {
    return { monthlyVisits: currentVisits, visitsSource: currentSource };
  }

  const estimated = estimateMonthlyVisitsFromTrancoRank(trancoRank);
  if (estimated !== null) {
    return { monthlyVisits: estimated, visitsSource: 'tranco_estimate' };
  }

  return currentSource === 'tranco_estimate'
    ? { monthlyVisits: null, visitsSource: null }
    : { monthlyVisits: currentVisits, visitsSource: currentSource };
}

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
