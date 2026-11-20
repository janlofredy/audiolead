import { parse as parseTld } from 'tldts';

/**
 * Normalizes any URL, domain, or email-domain fragment into a canonical registrable domain
 * (lowercased, without protocol, www/m prefixes, ports, or paths).
 * Returns null for invalid strings, bare IPs, or localhost.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let candidate = input.trim();
  if (!candidate) return null;

  // Reject email-looking strings only if caller passed an email directly without stripping @
  if (candidate.includes('@') && !candidate.includes('://')) {
    const parts = candidate.split('@');
    candidate = parts[parts.length - 1] ?? '';
  }

  // Strip surrounding punctuation or markdown brackets
  candidate = candidate.replace(/^[\s<>"'([`]+|[\s>"')\].,;`]+$/g, '');
  if (!candidate || /\s/.test(candidate)) return null;

  const withProto = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

  let hostname: string;
  try {
    const url = new URL(withProto);
    hostname = url.hostname.toLowerCase();
  } catch {
    return null;
  }

  if (!hostname || hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return null;
  }

  const parsed = parseTld(hostname, { allowPrivateDomains: true });
  if (!parsed.domain || parsed.isIp || !parsed.isIcann) {
    return null;
  }

  return parsed.domain.toLowerCase();
}

/**
 * Parses visitor / traffic shorthand strings like "1.2M", "450.5K", "85,000", "2.1B".
 */
export function parseTrafficNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  }

  const cleaned = raw.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!cleaned) return null;

  const match = /^([<>~]?\$?)?(\d+(?:\.\d+)?)\s*([kmb])?\+?$/i.exec(cleaned);
  if (!match) return null;

  const num = Number.parseFloat(match[2]);
  if (!Number.isFinite(num) || num < 0) return null;

  const suffix = (match[3] || '').toLowerCase();
  const multiplier = suffix === 'b' ? 1_000_000_000 : suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  return Math.round(num * multiplier);
}

/**
 * Parses flexible date inputs (JS Date, Excel serial date, YYYY-MM-DD, MM/DD/YYYY, YYYY/MM/DD, Month DD YYYY)
 * into canonical ISO YYYY-MM-DD, or null if invalid.
 */
export function parseFlexibleDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }

  // Excel serial date (days since 1899-12-30)
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw > 20000 && raw < 80000) {
      const utcMs = Date.UTC(1899, 11, 30) + Math.round(raw) * 86_400_000;
      return new Date(utcMs).toISOString().slice(0, 10);
    }
    return null;
  }

  const str = String(raw).trim();
  if (!str) return null;

  // Numeric string Excel serial
  if (/^\d{5}$/.test(str)) {
    return parseFlexibleDate(Number.parseInt(str, 10));
  }

  // ISO YYYY-MM-DD (optionally with timestamp)
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/.exec(str);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return toValidIsoDate(year, month, day);
  }

  // MM/DD/YYYY or MM-DD-YYYY (common US/Google Sheets format)
  const usMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(str);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    let year = Number(usMatch[3]);
    if (year < 100) year += 2000;
    return toValidIsoDate(year, month, day);
  }

  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2000 && parsed.getUTCFullYear() <= 2100) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function toValidIsoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const dt = new Date(`${isoDate}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetweenIsoDates(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00.000Z`);
  const b = Date.parse(`${toIso}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

export function formatSimilarwebUrl(domain: string, tab: 'overview' | 'competitors' = 'overview'): string {
  if (tab === 'competitors') {
    return `https://www.similarweb.com/website/${encodeURIComponent(domain)}/#competitors`;
  }
  return `https://www.similarweb.com/website/${encodeURIComponent(domain)}/`;
}
