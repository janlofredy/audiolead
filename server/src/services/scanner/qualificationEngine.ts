import type {
  AppSettings,
  LeadStatus,
  QualificationVerdict,
  SuppressionCheckResult,
} from '@audiolead/shared';
import { evaluateTraffic } from './trafficChecker.js';
import { daysBetweenIsoDates, todayIsoDate } from './domainUtils.js';

export interface QualificationInput {
  settings: AppSettings;
  suppression: SuppressionCheckResult;
  blockedByBotProtection: boolean;
  lastError: string | null;
  hasArticles: boolean | null;
  articleCountFound: number;
  latestArticleDate: string | null;
  hasAds: boolean | null;
  hasAudioPlayer: boolean | null;
  audioProvidersDetected: string[];
  detectedLanguage: string | null;
  detectedCountry: string | null;
  monthlyVisits: number | null;
  hasContacts: boolean;
}

export interface QualificationOutput {
  verdict: QualificationVerdict;
  status: LeadStatus;
  score: number;
  summary: string;
}

export function evaluateQualification(input: QualificationInput): QualificationOutput {
  const { settings, suppression } = input;

  // 1. Suppression always overrides everything else
  if (suppression.status === 'opted_out') {
    return {
      verdict: 'disqualified',
      status: 'opted_out',
      score: 0,
      summary: `Opted out / Do Not Contact (${suppression.eventDate}${suppression.reason ? `: ${suppression.reason}` : ''})`,
    };
  }

  if (suppression.status === 'cooldown') {
    return {
      verdict: 'disqualified',
      status: 'disqualified',
      score: 0,
      summary: `Already contacted on ${suppression.eventDate} (${suppression.daysRemaining}d cooldown remaining until ${suppression.expiresAt})`,
    };
  }

  // 2. Fetch failure / WAF challenge
  if (input.blockedByBotProtection) {
    return {
      verdict: 'review',
      status: 'review',
      score: 30,
      summary: 'Blocked by anti-bot challenge — check site & Similarweb manually',
    };
  }

  if (input.lastError && input.hasArticles === null && input.hasAds === null) {
    return {
      verdict: 'error',
      status: 'review',
      score: 0,
      summary: `Scan error: ${input.lastError}`,
    };
  }

  const reasonsFail: string[] = [];
  const reasonsReview: string[] = [];
  const reasonsPass: string[] = [];
  let score = 0;

  // 3. Articles check
  if (input.hasArticles) {
    let recencyOk = true;
    if (input.latestArticleDate && settings.maxDaysSinceLastArticle > 0) {
      const ageDays = daysBetweenIsoDates(input.latestArticleDate, todayIsoDate());
      if (ageDays > settings.maxDaysSinceLastArticle) {
        recencyOk = false;
        reasonsReview.push(`Last article is ${ageDays}d old (> ${settings.maxDaysSinceLastArticle}d)`);
      }
    }
    if (input.articleCountFound < settings.minArticleCount) {
      reasonsReview.push(`Only ${input.articleCountFound} articles detected`);
      score += 12;
    } else if (recencyOk) {
      reasonsPass.push(`${input.articleCountFound}+ articles`);
      score += 25;
    } else {
      score += 15;
    }
  } else {
    if (settings.requireArticles) {
      reasonsFail.push('No active articles/blog detected');
    } else {
      reasonsReview.push('No articles found');
    }
  }

  // 4. Ads check
  if (input.hasAds) {
    reasonsPass.push('Ads active');
    score += 25;
  } else if (settings.requireAds) {
    reasonsFail.push('No ads or /ads.txt detected');
  } else {
    reasonsReview.push('No ads detected');
  }

  // 5. No existing audio reader check
  if (input.hasAudioPlayer) {
    const prov = input.audioProvidersDetected.join(', ') || 'existing player';
    if (settings.requireNoAudioPlayer) {
      reasonsFail.push(`Already has audio reader (${prov})`);
    } else {
      reasonsReview.push(`Has audio reader (${prov})`);
    }
  } else {
    reasonsPass.push('No audio player');
    score += 25;
  }

  // 6. Language & Country check
  const langs = settings.targetLanguages.map((l) => l.toLowerCase()).filter(Boolean);
  if (langs.length > 0 && input.detectedLanguage) {
    if (langs.includes(input.detectedLanguage.toLowerCase())) {
      reasonsPass.push(`Lang: ${input.detectedLanguage.toUpperCase()}`);
      score += 10;
    } else {
      reasonsFail.push(`Language mismatch (${input.detectedLanguage.toUpperCase()})`);
    }
  } else if (langs.length > 0 && !input.detectedLanguage) {
    reasonsReview.push('Language unknown');
    score += 5;
  } else {
    score += 10;
  }

  const countries = settings.targetCountries.map((c) => c.toUpperCase()).filter(Boolean);
  if (countries.length > 0) {
    if (input.detectedCountry && !countries.includes(input.detectedCountry.toUpperCase())) {
      reasonsFail.push(`Region mismatch (${input.detectedCountry.toUpperCase()})`);
    }
  }

  // 7. Monthly Visitors check
  const trafficState = evaluateTraffic(input.monthlyVisits, settings.minMonthlyVisits);
  if (trafficState === 'pass') {
    reasonsPass.push('Traffic meets threshold');
    score += 15;
  } else if (trafficState === 'fail') {
    reasonsFail.push(`Traffic below ${settings.minMonthlyVisits.toLocaleString()}/mo`);
  } else {
    reasonsReview.push('Needs traffic check');
    score += 5;
  }

  if (suppression.status === 'cooldown_expired' && suppression.eventDate) {
    reasonsPass.push(`Cooldown expired (last contacted ${suppression.eventDate})`);
  }

  let verdict: QualificationVerdict;
  if (reasonsFail.length > 0) {
    verdict = 'disqualified';
  } else if (reasonsReview.length > 0) {
    verdict = 'review';
  } else {
    verdict = 'qualified';
  }

  let status: LeadStatus;
  if (verdict === 'disqualified') {
    status = 'disqualified';
  } else if (verdict === 'qualified' && input.hasContacts) {
    status = 'contact_found';
  } else if (verdict === 'qualified') {
    status = 'qualified';
  } else {
    status = 'review';
  }

  const summaryParts = [...reasonsFail, ...reasonsReview];
  if (summaryParts.length === 0) {
    summaryParts.push(...reasonsPass);
  } else if (reasonsPass.length > 0 && reasonsFail.length === 0) {
    summaryParts.push(`Passed: ${reasonsPass.join(', ')}`);
  }

  return {
    verdict,
    status,
    score: Math.min(100, Math.max(0, score)),
    summary: summaryParts.join(' · '),
  };
}
