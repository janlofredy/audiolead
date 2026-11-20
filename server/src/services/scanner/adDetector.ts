import * as cheerio from 'cheerio';
import { safeFetch } from './safeFetch.js';

export interface AdDetectionResult {
  hasAds: boolean;
  hasAdsTxt: boolean;
  adsTxtEntries: number;
  adNetworksDetected: string[];
}

interface AdNetworkSignature {
  name: string;
  htmlPatterns: RegExp[];
  adsTxtDomains?: RegExp[];
}

const AD_SIGNATURES: AdNetworkSignature[] = [
  {
    name: 'Mediavine',
    htmlPatterns: [/scripts\.mediavine\.com/i, /mediavine-settings/i, /mv-ad-box/i],
    adsTxtDomains: [/mediavine\.com/i],
  },
  {
    name: 'Raptive / AdThrive',
    htmlPatterns: [/ads\.adthrive\.com/i, /raptive\.com/i, /adthrive-ad/i],
    adsTxtDomains: [/adthrive\.com/i, /raptive\.com/i, /cafemedia\.com/i],
  },
  {
    name: 'Ezoic',
    htmlPatterns: [/ezojs\.com/i, /ezoic\.net/i, /ezoic-pub-ad/i, /ezstandalone/i],
    adsTxtDomains: [/ezoic\.com/i, /ezoic\.ai/i],
  },
  {
    name: 'Freestar',
    htmlPatterns: [/a\.pub\.network/i, /freestar\.io/i, /data-freestar/i],
    adsTxtDomains: [/freestar\.com/i, /freestar\.io/i],
  },
  {
    name: 'Playwire',
    htmlPatterns: [/cdn\.intergient\.com/i, /ramp\.playwire\.com/i, /playwire/i],
    adsTxtDomains: [/playwire\.com/i],
  },
  {
    name: 'NitroPay',
    htmlPatterns: [/s\.nitropay\.com/i, /window\.nitroAds/i],
    adsTxtDomains: [/nitropay\.com/i],
  },
  {
    name: 'Monumetric',
    htmlPatterns: [/monumetric\.com/i, /monu-ad/i],
    adsTxtDomains: [/monumetric\.com/i],
  },
  {
    name: 'SheMedia',
    htmlPatterns: [/ads\.blogherads\.com/i, /shemedia/i],
    adsTxtDomains: [/shemedia\.com/i, /blogherads\.com/i],
  },
  {
    name: 'Snigel',
    htmlPatterns: [/cdn\.snigelweb\.com/i, /adengine\.snigelweb/i],
    adsTxtDomains: [/snigelweb\.com/i],
  },
  {
    name: 'Publift',
    htmlPatterns: [/cdn\.fuseplatform\.net/i, /publift/i],
    adsTxtDomains: [/publift\.com/i],
  },
  {
    name: 'AdPushup',
    htmlPatterns: [/cdn\.adpushup\.com/i],
    adsTxtDomains: [/adpushup\.com/i],
  },
  {
    name: 'Setupad',
    htmlPatterns: [/setupad\.com/i],
    adsTxtDomains: [/setupad\.com/i],
  },
  {
    name: 'Sovrn',
    htmlPatterns: [/ap\.lijit\.com/i, /sovrn/i],
    adsTxtDomains: [/lijit\.com/i, /sovrn\.com/i],
  },
  {
    name: 'Media.net',
    htmlPatterns: [/contextual\.media\.net/i, /medianet/i],
    adsTxtDomains: [/media\.net/i],
  },
  {
    name: 'Google AdSense',
    htmlPatterns: [
      /pagead2\.googlesyndication\.com/i,
      /class=["'][^"']*adsbygoogle/i,
      /data-ad-client=["']ca-pub-/i,
    ],
    adsTxtDomains: [],
  },
  {
    name: 'Google Ad Manager (GPT)',
    htmlPatterns: [
      /securepubads\.g\.doubleclick\.net/i,
      /googletag\.defineSlot/i,
      /div-gpt-ad/i,
      /gpt\.js/i,
    ],
    adsTxtDomains: [/google\.com/i],
  },
  {
    name: 'Amazon APS',
    htmlPatterns: [/c\.amazon-adsystem\.com/i, /apstag\.js/i, /apstag\.init/i],
    adsTxtDomains: [/aps\.amazon\.com/i, /amazon-adsystem\.com/i],
  },
  {
    name: 'Prebid',
    htmlPatterns: [/pbjs\.que/i, /prebid\.js/i, /prebid-wrapper/i],
  },
  {
    name: 'Criteo',
    htmlPatterns: [/static\.criteo\.net/i, /Criteo\.DisplayAd/i],
    adsTxtDomains: [/criteo\.com/i],
  },
  {
    name: 'Taboola',
    htmlPatterns: [/cdn\.taboola\.com/i, /_taboola/i],
    adsTxtDomains: [/taboola\.com/i],
  },
  {
    name: 'Outbrain',
    htmlPatterns: [/widgets\.outbrain\.com/i, /OUTBRAIN/i],
    adsTxtDomains: [/outbrain\.com/i],
  },
  {
    name: 'MGID',
    htmlPatterns: [/jsc\.mgid\.com/i],
    adsTxtDomains: [/mgid\.com/i],
  },
  {
    name: 'Revcontent',
    htmlPatterns: [/trends\.revcontent\.com/i, /assets\.revcontent\.com/i],
    adsTxtDomains: [/revcontent\.com/i],
  },
];

const IAB_ADS_TXT_LINE =
  /^[a-z0-9.-]+\.[a-z]{2,}\s*,\s*[^,\s#]+\s*,\s*(DIRECT|RESELLER)(?:\s*,\s*[a-z0-9]+)?(?:\s*#.*)?$/i;

export function parseAdsTxt(body: string, contentType = ''): {
  valid: boolean;
  entryCount: number;
  networks: string[];
} {
  if (!body) return { valid: false, entryCount: 0, networks: [] };
  const lowerType = contentType.toLowerCase();
  const trimmedStart = body.trim().slice(0, 300).toLowerCase();
  if (
    lowerType.includes('text/html') ||
    trimmedStart.startsWith('<!doctype') ||
    trimmedStart.startsWith('<html')
  ) {
    return { valid: false, entryCount: 0, networks: [] };
  }

  let entryCount = 0;
  const networks = new Set<string>();

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    if (IAB_ADS_TXT_LINE.test(line)) {
      entryCount++;
      const sellerDomain = line.split(',')[0].trim().toLowerCase();
      for (const sig of AD_SIGNATURES) {
        if (sig.adsTxtDomains?.some((rx) => rx.test(sellerDomain))) {
          networks.add(sig.name);
        }
      }
    }
  }

  return {
    valid: entryCount >= 1,
    entryCount,
    networks: Array.from(networks),
  };
}

export function detectAdsFromHtmlDocs(
  htmlDocs: Array<{ html: string }>,
  adsTxtResult: { valid: boolean; entryCount: number; networks: string[] },
): AdDetectionResult {
  const networks = new Set<string>(adsTxtResult.networks);
  let hasDomAdSlots = false;

  for (const doc of htmlDocs) {
    if (!doc.html) continue;
    for (const sig of AD_SIGNATURES) {
      if (sig.htmlPatterns.some((rx) => rx.test(doc.html))) {
        networks.add(sig.name);
      }
    }

    const $ = cheerio.load(doc.html);
    if (
      $('ins.adsbygoogle, [data-ad-client], [data-ad-slot], [id^="div-gpt-ad"], .adthrive-ad, .mv-ad-box').length >
      0
    ) {
      hasDomAdSlots = true;
    }
  }

  const adNetworksDetected = Array.from(networks);
  const hasAds = adsTxtResult.valid || adNetworksDetected.length > 0 || hasDomAdSlots;

  return {
    hasAds,
    hasAdsTxt: adsTxtResult.valid,
    adsTxtEntries: adsTxtResult.entryCount,
    adNetworksDetected,
  };
}

export async function analyzeAds(
  baseUrl: string,
  htmlDocs: Array<{ html: string }>,
): Promise<AdDetectionResult> {
  let adsTxtResult = { valid: false, entryCount: 0, networks: [] as string[] };
  try {
    const adsTxtUrl = new URL('/ads.txt', baseUrl).toString();
    const res = await safeFetch(adsTxtUrl, { timeoutMs: 5000, maxBytes: 512_000 });
    if (res.ok) {
      adsTxtResult = parseAdsTxt(res.body, res.contentType);
    }
  } catch {
    // ignore fetch failure
  }

  return detectAdsFromHtmlDocs(htmlDocs, adsTxtResult);
}
