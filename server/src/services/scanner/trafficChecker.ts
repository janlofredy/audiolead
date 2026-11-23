import type { AppSettings, Lead } from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import { TrafficCacheRepo, TrancoRepo } from '../../db/repositories.js';

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

export function isEstimatedVisitsSource(source: Lead['visitsSource']): boolean {
  return (
    source === 'tranco_estimate' ||
    source === 'openpagerank_estimate' ||
    source === 'cloudflare_radar_estimate' ||
    source === 'crux_estimate'
  );
}

export function estimateMonthlyVisitsFromOpenPageRank(
  rank: number | null | undefined,
  pageRankDecimal: number | null | undefined,
): number | null {
  const rankEstimate = estimateMonthlyVisitsFromTrancoRank(rank);
  if (rankEstimate !== null) return rankEstimate;

  if (
    pageRankDecimal === null ||
    pageRankDecimal === undefined ||
    !Number.isFinite(pageRankDecimal)
  ) {
    return null;
  }

  if (pageRankDecimal >= 7.5) return 10_000_000;
  if (pageRankDecimal >= 6.5) return 2_500_000;
  if (pageRankDecimal >= 5.5) return 600_000;
  if (pageRankDecimal >= 4.5) return 150_000;
  if (pageRankDecimal >= 3.5) return 50_000;
  if (pageRankDecimal >= 2.5) return 15_000;
  if (pageRankDecimal >= 1.5) return 5_000;
  return null;
}

export async function lookupOpenPageRank(
  db: AppDatabase,
  domain: string,
  apiKey: string,
): Promise<number | null> {
  if (!apiKey.trim()) return null;
  const cache = new TrafficCacheRepo(db);
  const cached = cache.getCached(domain, 'openpagerank');
  if (cached.found) return cached.estimatedVisits;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://openpagerank.com/api/v1.0/getPageRank?domains[]=${encodeURIComponent(domain)}`,
      {
        signal: controller.signal,
        headers: {
          'API-OPR': apiKey.trim(),
          Accept: 'application/json',
        },
      },
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = (await res.json()) as {
      response?: Array<{
        rank?: string | number | null;
        page_rank_decimal?: number | string | null;
      }>;
    };
    const entry = json?.response?.[0];
    const rawRank = entry?.rank !== undefined && entry?.rank !== null ? Number(entry.rank) : null;
    const rankNum = rawRank !== null && Number.isFinite(rawRank) && rawRank > 0 ? rawRank : null;
    const prRaw =
      entry?.page_rank_decimal !== undefined && entry?.page_rank_decimal !== null
        ? Number(entry.page_rank_decimal)
        : null;
    const est = estimateMonthlyVisitsFromOpenPageRank(rankNum, prRaw);
    cache.setCached(domain, 'openpagerank', est, rankNum);
    return est;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function lookupCloudflareRadar(
  db: AppDatabase,
  domain: string,
  apiToken: string,
): Promise<number | null> {
  if (!apiToken.trim()) return null;
  const cache = new TrafficCacheRepo(db);
  const cached = cache.getCached(domain, 'cloudflare_radar');
  if (cached.found) return cached.estimatedVisits;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/radar/ranking/domain/${encodeURIComponent(domain)}`,
      {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiToken.trim()}`,
          Accept: 'application/json',
        },
      },
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = (await res.json()) as {
      result?: {
        details_0?: {
          rank?: number | string | null;
          bucket?: string | null;
        };
      };
    };
    const details = json?.result?.details_0;
    const rawVal = details?.rank ?? details?.bucket;
    const parsedNum = rawVal !== undefined && rawVal !== null ? Number(rawVal) : NaN;
    const rankNum = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : null;
    const est = estimateMonthlyVisitsFromTrancoRank(rankNum);
    cache.setCached(domain, 'cloudflare_radar', est, rankNum);
    return est;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function lookupGoogleCrux(
  db: AppDatabase,
  domain: string,
  apiKey: string,
): Promise<number | null> {
  if (!apiKey.trim()) return null;
  const cache = new TrafficCacheRepo(db);
  const cached = cache.getCached(domain, 'crux');
  if (cached.found) return cached.estimatedVisits;

  const origins = [`https://${domain}`, `https://www.${domain}`];
  for (const origin of origins) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(
        `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(apiKey.trim())}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ origin }),
        },
      );
      clearTimeout(timer);

      if (res.status === 404) {
        continue;
      }
      if (!res.ok) return null;

      const json = (await res.json()) as {
        record?: {
          experimental?: {
            popularity?: {
              rank?: number | string;
            };
          };
        };
      };
      if (!json?.record) {
        cache.setCached(domain, 'crux', null, null);
        return null;
      }

      const rawPopRank = json.record.experimental?.popularity?.rank;
      const popRank =
        rawPopRank !== undefined && rawPopRank !== null ? Number(rawPopRank) : NaN;
      const validRank = Number.isFinite(popRank) && popRank > 0 ? popRank : null;
      const est =
        validRank !== null ? estimateMonthlyVisitsFromTrancoRank(validRank) : 50_000;
      cache.setCached(domain, 'crux', est, validRank);
      return est;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  cache.setCached(domain, 'crux', null, null);
  return null;
}

export type TrafficWaterfallSettings = Pick<
  AppSettings,
  'openPageRankApiKey' | 'cloudflareRadarApiToken' | 'googleCruxApiKey'
>;

export async function lookupTrafficWaterfall(
  db: AppDatabase,
  domain: string,
  settings: TrafficWaterfallSettings,
): Promise<{
  trancoRank: number | null;
  monthlyVisits: number | null;
  visitsSource: Lead['visitsSource'];
}> {
  const trancoRank = await lookupTrancoRank(db, domain);
  const trancoEst = estimateMonthlyVisitsFromTrancoRank(trancoRank);
  if (trancoEst !== null) {
    return { trancoRank, monthlyVisits: trancoEst, visitsSource: 'tranco_estimate' };
  }

  if (settings.openPageRankApiKey) {
    const oprEst = await lookupOpenPageRank(db, domain, settings.openPageRankApiKey);
    if (oprEst !== null) {
      return { trancoRank, monthlyVisits: oprEst, visitsSource: 'openpagerank_estimate' };
    }
  }

  if (settings.cloudflareRadarApiToken) {
    const cfEst = await lookupCloudflareRadar(db, domain, settings.cloudflareRadarApiToken);
    if (cfEst !== null) {
      return { trancoRank, monthlyVisits: cfEst, visitsSource: 'cloudflare_radar_estimate' };
    }
  }

  if (settings.googleCruxApiKey) {
    const cruxEst = await lookupGoogleCrux(db, domain, settings.googleCruxApiKey);
    if (cruxEst !== null) {
      return { trancoRank, monthlyVisits: cruxEst, visitsSource: 'crux_estimate' };
    }
  }

  return { trancoRank, monthlyVisits: null, visitsSource: null };
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
