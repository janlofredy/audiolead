import type { CheerioAPI } from 'cheerio';

export interface LanguageResult {
  language: string | null;
  country: string | null;
}

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'that', 'with', 'for', 'this', 'from', 'are', 'was', 'have', 'which', 'about'],
  es: ['que', 'los', 'del', 'las', 'por', 'para', 'con', 'una', 'como', 'más', 'pero', 'sobre'],
  fr: ['les', 'des', 'que', 'une', 'dans', 'pour', 'avec', 'sur', 'est', 'pas', 'plus', 'nous'],
  de: ['der', 'die', 'und', 'den', 'das', 'von', 'mit', 'auf', 'für', 'ist', 'nicht', 'sich'],
  pt: ['que', 'com', 'para', 'uma', 'por', 'dos', 'das', 'não', 'mais', 'como', 'sobre', 'seu'],
  it: ['che', 'per', 'con', 'una', 'del', 'dei', 'non', 'più', 'come', 'nel', 'della', 'sono'],
  nl: ['het', 'een', 'van', 'dat', 'met', 'voor', 'zijn', 'niet', 'ook', 'maar', 'aan', 'door'],
  id: ['yang', 'dan', 'untuk', 'dari', 'dengan', 'ini', 'itu', 'pada', 'atau', 'tidak', 'akan', 'dalam'],
  tl: ['ang', 'mga', 'nang', 'para', 'hindi', 'ito', 'siya', 'kami', 'nila', 'kung', 'pero', 'dahil'],
};

const CCTLD_COUNTRY: Record<string, string> = {
  uk: 'GB',
  au: 'AU',
  ca: 'CA',
  us: 'US',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  nl: 'NL',
  br: 'BR',
  pt: 'PT',
  in: 'IN',
  ph: 'PH',
  sg: 'SG',
  ie: 'IE',
  nz: 'NZ',
  za: 'ZA',
  jp: 'JP',
  kr: 'KR',
  id: 'ID',
  mx: 'MX',
};

function parseLocaleTag(raw: string | undefined | null): { lang: string | null; country: string | null } {
  if (!raw) return { lang: null, country: null };
  const cleaned = raw.trim().replace(/_/g, '-');
  const match = /^([a-z]{2,3})(?:-[a-z]{4})?(?:-([a-z]{2}|\d{3}))?/i.exec(cleaned);
  if (!match) return { lang: null, country: null };
  const lang = match[1].toLowerCase();
  const region = match[2] && /^[a-z]{2}$/i.test(match[2]) ? match[2].toUpperCase() : null;
  return { lang, country: region };
}

export function detectLanguageAndCountry(
  $: CheerioAPI,
  domain: string,
  extraText = '',
  contentLanguageHeader?: string,
): LanguageResult {
  const htmlLang = parseLocaleTag($('html').attr('lang'));
  const ogLocale = parseLocaleTag($('meta[property="og:locale"]').attr('content'));
  const metaLang = parseLocaleTag(
    $('meta[http-equiv="content-language"]').attr('content') || contentLanguageHeader,
  );

  // Stopword inference from visible text
  const pageText = `${$('h1, h2, p').slice(0, 40).text()} ${extraText}`.toLowerCase();
  const words = pageText.split(/[^a-z\u00c0-\u024f]+/).filter((w) => w.length >= 2 && w.length <= 12);

  let bestStopLang: string | null = null;
  let bestScore = 0;

  if (words.length >= 20) {
    const counts = new Map<string, number>();
    for (const w of words.slice(0, 400)) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }

    for (const [lang, list] of Object.entries(STOPWORDS)) {
      let score = 0;
      for (const sw of list) {
        score += counts.get(sw) ?? 0;
      }
      if (score > bestScore && score >= 4) {
        bestScore = score;
        bestStopLang = lang;
      }
    }
  }

  // Prefer text stopword inference if strong, otherwise HTML/OG tags
  const tagLang = htmlLang.lang || ogLocale.lang || metaLang.lang;
  const language =
    bestStopLang && bestScore >= 10 ? bestStopLang : tagLang || bestStopLang || null;

  const tld = domain.split('.').pop()?.toLowerCase() ?? '';
  const ccCountry = CCTLD_COUNTRY[tld] ?? null;

  let country = ogLocale.country || htmlLang.country || metaLang.country || ccCountry;
  if (!country && tld === 'com' && language === 'en') {
    country = 'US';
  }

  return { language, country };
}
