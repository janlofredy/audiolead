import type { AppDatabase } from '../../db/index.js';
import { LeadsRepo, SettingsRepo, SuppressionRepo } from '../../db/repositories.js';
import { evaluateQualification } from '../scanner/qualificationEngine.js';
import { estimateMonthlyVisitsFromTrancoRank } from '../scanner/trafficChecker.js';

/**
 * Re-evaluates leads whose verdict/status may have changed because a suppression rule
 * was added, edited, deleted, or the cooldown window in Settings changed.
 */
export function reconcileLeadsWithSuppression(
  db: AppDatabase,
  domains?: string[],
): number {
  const settings = new SettingsRepo(db).get();
  const leadsRepo = new LeadsRepo(db);
  const supRepo = new SuppressionRepo(db);

  const { leads } = leadsRepo.list(settings.contactedCooldownDays);
  const targetSet = domains ? new Set(domains.map((d) => d.toLowerCase())) : null;
  let updatedCount = 0;

  for (const lead of leads) {
    if (targetSet && !targetSet.has(lead.domain)) continue;
    const sup = supRepo.checkDomainAndCompany(
      lead.domain,
      lead.parentCompany,
      settings.contactedCooldownDays,
    );

    if (sup.status === 'opted_out' || sup.status === 'cooldown') {
      const qual = evaluateQualification({
        settings,
        suppression: sup,
        blockedByBotProtection: lead.blockedByBotProtection,
        lastError: lead.lastError,
        hasArticles: lead.hasArticles,
        articleCountFound: lead.articleCountFound,
        latestArticleDate: lead.latestArticleDate,
        hasAds: lead.hasAds,
        hasAudioPlayer: lead.hasAudioPlayer,
        audioProvidersDetected: lead.audioProvidersDetected,
        detectedLanguage: lead.detectedLanguage,
        detectedCountry: lead.detectedCountry,
        monthlyVisits: lead.monthlyVisits,
        hasContacts: lead.contactCount > 0,
      });

      if (
        lead.status !== qual.status ||
        lead.verdict !== qual.verdict ||
        lead.qualificationSummary !== qual.summary
      ) {
        leadsRepo.updateLeadFields(lead.id, {
          status: qual.status,
          verdict: qual.verdict,
          qualificationScore: qual.score,
          qualificationSummary: qual.summary,
        });
        updatedCount++;
      }
      continue;
    }

    // If previously marked opted_out or disqualified specifically due to suppression, restore/recompute!
    const wasSuppressedInSummary =
      lead.status === 'opted_out' ||
      (lead.qualificationSummary ?? '').startsWith('Opted out') ||
      (lead.qualificationSummary ?? '').startsWith('Already contacted on');

    if (wasSuppressedInSummary) {
      if (lead.lastScannedAt === null) {
        leadsRepo.updateLeadFields(lead.id, {
          status: 'pending',
          verdict: 'pending',
          qualificationScore: 0,
          qualificationSummary: null,
        });
      } else {
        const qual = evaluateQualification({
          settings,
          suppression: sup,
          blockedByBotProtection: lead.blockedByBotProtection,
          lastError: lead.lastError,
          hasArticles: lead.hasArticles,
          articleCountFound: lead.articleCountFound,
          latestArticleDate: lead.latestArticleDate,
          hasAds: lead.hasAds,
          hasAudioPlayer: lead.hasAudioPlayer,
          audioProvidersDetected: lead.audioProvidersDetected,
          detectedLanguage: lead.detectedLanguage,
          detectedCountry: lead.detectedCountry,
          monthlyVisits: lead.monthlyVisits,
          hasContacts: lead.contactCount > 0,
        });

        leadsRepo.updateLeadFields(lead.id, {
          status: qual.status,
          verdict: qual.verdict,
          qualificationScore: qual.score,
          qualificationSummary: qual.summary,
        });
      }
      updatedCount++;
    }
  }

  return updatedCount;
}

/**
 * Populates estimated monthly visits for existing leads that have a Tranco rank
 * but no monthly visit count, and re-evaluates qualification for scanned leads.
 */
export function backfillTrancoVisitEstimates(db: AppDatabase): number {
  const rows = db
    .prepare('SELECT id FROM leads WHERE monthly_visits IS NULL AND tranco_rank IS NOT NULL')
    .all() as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  const settings = new SettingsRepo(db).get();
  const leadsRepo = new LeadsRepo(db);
  const supRepo = new SuppressionRepo(db);
  let updatedCount = 0;

  for (const row of rows) {
    const lead = leadsRepo.getById(row.id, settings.contactedCooldownDays);
    if (!lead || lead.monthlyVisits !== null) continue;

    const estimated = estimateMonthlyVisitsFromTrancoRank(lead.trancoRank);
    if (estimated === null) continue;

    let nextStatus = lead.status;
    let nextVerdict = lead.verdict;
    let nextScore = lead.qualificationScore;
    let nextSummary = lead.qualificationSummary;

    if (lead.lastScannedAt !== null) {
      const sup = supRepo.checkDomainAndCompany(
        lead.domain,
        lead.parentCompany,
        settings.contactedCooldownDays,
      );
      const qual = evaluateQualification({
        settings,
        suppression: sup,
        blockedByBotProtection: lead.blockedByBotProtection,
        lastError: lead.lastError,
        hasArticles: lead.hasArticles,
        articleCountFound: lead.articleCountFound,
        latestArticleDate: lead.latestArticleDate,
        hasAds: lead.hasAds,
        hasAudioPlayer: lead.hasAudioPlayer,
        audioProvidersDetected: lead.audioProvidersDetected,
        detectedLanguage: lead.detectedLanguage,
        detectedCountry: lead.detectedCountry,
        monthlyVisits: estimated,
        hasContacts: lead.contacts.some((ct) => Boolean(ct.email)),
      });

      nextVerdict = qual.verdict;
      nextScore = qual.score;
      nextSummary = qual.summary;

      if (
        lead.status !== 'contacted' &&
        lead.status !== 'exported' &&
        lead.status !== 'opted_out'
      ) {
        nextStatus = qual.status;
      }
    }

    leadsRepo.updateLeadFields(lead.id, {
      monthlyVisits: estimated,
      visitsSource: 'tranco_estimate',
      status: nextStatus,
      verdict: nextVerdict,
      qualificationScore: nextScore,
      qualificationSummary: nextSummary,
    });
    updatedCount++;
  }

  return updatedCount;
}
