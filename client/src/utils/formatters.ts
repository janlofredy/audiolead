import type {
  AuthorityTier,
  Lead,
  LeadStatus,
  QualificationVerdict,
  SuppressionCheckResult,
} from '@audiolead/shared';

export function formatVisits(visits: number | null | undefined): string {
  if (visits === null || visits === undefined) return 'Unknown';
  if (visits >= 1_000_000) return `${(visits / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (visits >= 1_000) return `${(visits / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return visits.toLocaleString();
}

export function visitsSourceLabel(source: Lead['visitsSource']): string | null {
  switch (source) {
    case 'tranco_estimate':
      return 'Tranco';
    case 'openpagerank_estimate':
      return 'Open PageRank';
    case 'cloudflare_radar_estimate':
      return 'CF Radar';
    case 'crux_estimate':
      return 'Google CrUX';
    default:
      return null;
  }
}

export function similarwebLink(domain: string, tab: 'overview' | 'competitors' = 'overview'): string {
  return tab === 'competitors'
    ? `https://www.similarweb.com/website/${encodeURIComponent(domain)}/#competitors`
    : `https://www.similarweb.com/website/${encodeURIComponent(domain)}/`;
}

export function verdictMeta(verdict: QualificationVerdict, suppression: SuppressionCheckResult): {
  label: string;
  classes: string;
} {
  if (suppression.status === 'opted_out') {
    return { label: 'Opted Out', classes: 'bg-rose-100 text-rose-800 border-rose-200' };
  }
  if (suppression.status === 'cooldown') {
    return { label: `Cooldown (${suppression.daysRemaining}d)`, classes: 'bg-rose-50 text-rose-700 border-rose-200' };
  }
  switch (verdict) {
    case 'qualified':
      return { label: 'Qualified', classes: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
    case 'review':
      return { label: 'Needs Review', classes: 'bg-amber-100 text-amber-800 border-amber-200' };
    case 'disqualified':
      return { label: 'Disqualified', classes: 'bg-rose-100 text-rose-800 border-rose-200' };
    case 'error':
      return { label: 'Scan Error', classes: 'bg-slate-200 text-slate-700 border-slate-300' };
    default:
      return { label: 'Pending', classes: 'bg-slate-100 text-slate-700 border-slate-200' };
  }
}

export function authorityTierLabel(tier: AuthorityTier): { text: string; classes: string } {
  switch (tier) {
    case 1:
      return { text: 'Tier 1 · Decision Maker', classes: 'bg-indigo-100 text-indigo-800 border-indigo-200' };
    case 2:
      return { text: 'Tier 2 · Strong Influence', classes: 'bg-sky-100 text-sky-800 border-sky-200' };
    case 3:
      return { text: 'Tier 3 · Editorial', classes: 'bg-slate-100 text-slate-700 border-slate-200' };
    default:
      return { text: 'Tier 4 · Generic Fallback', classes: 'bg-amber-50 text-amber-800 border-amber-200' };
  }
}

export const LEAD_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'contact_found', label: 'Contact Found' },
  { value: 'review', label: 'Needs Review' },
  { value: 'contacted', label: 'Contacted (Starts Cooldown)' },
  { value: 'exported', label: 'Exported' },
  { value: 'disqualified', label: 'Disqualified' },
  { value: 'opted_out', label: 'Opted Out (Permanent)' },
];
