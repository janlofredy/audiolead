import dns from 'node:dns/promises';
import net from 'node:net';

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  blockedByBotProtection: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_REDIRECTS = 5;

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    const lower = normalized.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }

  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error(`Blocked non-public IP: ${hostname}`);
    }
    return;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error(`Blocked private/reserved resolved IP for ${hostname}`);
    }
  }
}

export function detectBotChallenge(status: number, headers: Record<string, string>, body: string): boolean {
  if (headers['cf-mitigated'] === 'challenge') return true;
  if (status === 403 || status === 429 || status === 503) {
    const snippet = body.slice(0, 8000).toLowerCase();
    if (
      snippet.includes('just a moment...') ||
      snippet.includes('cf-browser-verification') ||
      snippet.includes('attention required! | cloudflare') ||
      snippet.includes('/cdn-cgi/challenge-platform/') ||
      snippet.includes('verify you are human') ||
      snippet.includes('perimeterx') ||
      snippet.includes('px-captcha') ||
      snippet.includes('access to this page has been denied')
    ) {
      return true;
    }
  }
  return false;
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Return partial body if stream ended mid-read
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function safeFetch(
  targetUrl: string,
  options?: {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    skipSsrfCheck?: boolean;
  },
): Promise<SafeFetchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  let currentUrl = targetUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        contentType: '',
        headers: {},
        body: '',
        blockedByBotProtection: false,
        error: `Invalid URL: ${currentUrl}`,
      };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        contentType: '',
        headers: {},
        body: '',
        blockedByBotProtection: false,
        error: `Unsupported protocol: ${parsed.protocol}`,
      };
    }

    if (!options?.skipSsrfCheck) {
      try {
        await assertPublicHost(parsed.hostname);
      } catch (err) {
        return {
          ok: false,
          status: 0,
          finalUrl: currentUrl,
          contentType: '',
          headers: {},
          body: '',
          blockedByBotProtection: false,
          error: err instanceof Error ? err.message : 'Host check failed',
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          ...BROWSER_HEADERS,
          ...options?.headers,
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        clearTimeout(timer);
        if (!location) {
          return {
            ok: false,
            status: res.status,
            finalUrl: currentUrl,
            contentType: '',
            headers: {},
            body: '',
            blockedByBotProtection: false,
            error: `HTTP ${res.status} redirect without location`,
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerMap[k.toLowerCase()] = v;
      });
      const contentType = headerMap['content-type'] ?? '';
      const body = await readBodyCapped(res, maxBytes);
      clearTimeout(timer);

      const blockedByBotProtection = detectBotChallenge(res.status, headerMap, body);
      return {
        ok: res.ok && !blockedByBotProtection,
        status: res.status,
        finalUrl: currentUrl,
        contentType,
        headers: headerMap,
        body,
        blockedByBotProtection,
        error: blockedByBotProtection
          ? `Blocked by bot protection (HTTP ${res.status})`
          : !res.ok
            ? `HTTP ${res.status}`
            : undefined,
      };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        contentType: '',
        headers: {},
        body: '',
        blockedByBotProtection: false,
        error: isAbort
          ? `Request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : 'Network error',
      };
    }
  }

  return {
    ok: false,
    status: 0,
    finalUrl: currentUrl,
    contentType: '',
    headers: {},
    body: '',
    blockedByBotProtection: false,
    error: 'Too many redirects',
  };
}
