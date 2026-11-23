import { EventEmitter } from 'node:events';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import type { ScanJobSummary, ScanProgressEvent } from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import {
  ContactsRepo,
  LeadsRepo,
  SettingsRepo,
  SuppressionRepo,
} from '../../db/repositories.js';
import { isRetryableFetchFailure, safeFetch } from './safeFetch.js';
import { detectLanguageAndCountry } from './languageDetector.js';
import { analyzeArticles } from './articleDetector.js';
import { detectAudioPlayersFromHtml } from './audioDetector.js';
import { analyzeAds } from './adDetector.js';
import {
  isEstimatedVisitsSource,
  lookupTrafficWaterfall,
} from './trafficChecker.js';
import { crawlSiteContacts } from './contactFinder.js';
import { evaluateQualification } from './qualificationEngine.js';
import { detectParentCompany } from './parentCompanyDetector.js';
import { mineOutboundSuggestions } from '../discovery/outboundMiner.js';

interface QueuedScanEntry {
  leadId: string;
  forceRescan: boolean;
  notBefore: number;
}

interface ActiveJob {
  jobId: string;
  total: number;
  completed: number;
  done: boolean;
  emitter: EventEmitter;
  events: ScanProgressEvent[];
  queue: QueuedScanEntry[];
  enqueuedIds: Set<string>;
}

export class ScanOrchestrator {
  private jobs = new Map<string, ActiveJob>();
  private activeJobId: string | null = null;

  constructor(private db: AppDatabase) {}

  getJobSummary(jobId: string): ScanJobSummary | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return { jobId: job.jobId, total: job.total, completed: job.completed, done: job.done };
  }

  getActiveJobSummary(): ScanJobSummary | null {
    if (!this.activeJobId) return null;
    const job = this.jobs.get(this.activeJobId);
    if (!job || job.done) return null;
    return { jobId: job.jobId, total: job.total, completed: job.completed, done: job.done };
  }

  getJobEmitter(jobId: string): ActiveJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  resumePendingOnStartup(): ScanJobSummary | null {
    const leadsRepo = new LeadsRepo(this.db);
    leadsRepo.resetInterruptedScans();
    const pendingIds = leadsRepo.getPendingLeadIds(500);
    if (pendingIds.length === 0) return null;
    return this.startJob(pendingIds);
  }

  startJob(leadIds: string[], options?: { forceRescan?: boolean }): ScanJobSummary {
    const uniqueIds = Array.from(new Set(leadIds));
    const forceRescan = Boolean(options?.forceRescan);

    if (this.activeJobId) {
      const existing = this.jobs.get(this.activeJobId);
      if (existing && !existing.done) {
        const added = uniqueIds.filter((id) => !existing.enqueuedIds.has(id));
        for (const id of added) {
          existing.enqueuedIds.add(id);
          existing.queue.push({ leadId: id, forceRescan, notBefore: 0 });
        }
        if (added.length > 0) {
          existing.total += added.length;
          const ev: ScanProgressEvent = {
            jobId: existing.jobId,
            type: 'lead_progress',
            total: existing.total,
            completed: existing.completed,
            stage: `Queued ${added.length} additional site(s)`,
          };
          existing.events.push(ev);
          existing.emitter.emit('event', ev);
        }
        return {
          jobId: existing.jobId,
          total: existing.total,
          completed: existing.completed,
          done: existing.done,
        };
      }
    }

    const jobId = nanoid(10);
    const job: ActiveJob = {
      jobId,
      total: uniqueIds.length,
      completed: 0,
      done: false,
      emitter: new EventEmitter(),
      events: [],
      queue: uniqueIds.map((leadId) => ({ leadId, forceRescan, notBefore: 0 })),
      enqueuedIds: new Set(uniqueIds),
    };
    this.jobs.set(jobId, job);

    // Prune older completed jobs after 15 minutes
    setTimeout(() => {
      this.jobs.delete(jobId);
    }, 15 * 60_000).unref();

    const emitEvent = (ev: ScanProgressEvent) => {
      job.events.push(ev);
      job.emitter.emit('event', ev);
    };

    emitEvent({
      jobId,
      type: 'started',
      total: job.total,
      completed: 0,
      message: `Starting scan of ${job.total} site(s)`,
    });

    if (uniqueIds.length === 0) {
      job.done = true;
      emitEvent({ jobId, type: 'job_done', total: 0, completed: 0, message: 'No sites to scan' });
      return { jobId, total: 0, completed: 0, done: true };
    }

    this.activeJobId = jobId;
    // Run asynchronously in server background with concurrency = 3
    void this.runQueue(job, emitEvent);

    return { jobId, total: job.total, completed: 0, done: false };
  }

  private async runQueue(
    job: ActiveJob,
    emitEvent: (ev: ScanProgressEvent) => void,
  ): Promise<void> {
    const MAX_RETRIES = 2;
    const attempts = new Map<string, number>();
    const concurrency = Math.min(3, Math.max(1, job.queue.length));

    const workers = Array.from({ length: concurrency }, async () => {
      while (job.queue.length > 0) {
        const now = Date.now();
        const readyIndex = job.queue.findIndex((item) => item.notBefore <= now);
        if (readyIndex === -1) {
          const earliest = Math.min(...job.queue.map((item) => item.notBefore));
          const waitMs = Math.min(1_000, Math.max(50, earliest - now));
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        const [entry] = job.queue.splice(readyIndex, 1);
        if (!entry) break;

        const attempt = attempts.get(entry.leadId) ?? 0;
        const outcome = await this.scanSingleLead(
          job,
          entry.leadId,
          entry.forceRescan,
          attempt,
          emitEvent,
        );

        if (outcome?.requeue && attempt < MAX_RETRIES) {
          const nextAttempt = attempt + 1;
          attempts.set(entry.leadId, nextAttempt);
          job.queue.push({
            leadId: entry.leadId,
            forceRescan: entry.forceRescan,
            notBefore: Date.now() + outcome.delayMs * nextAttempt,
          });
          emitEvent({
            jobId: job.jobId,
            type: 'lead_progress',
            total: job.total,
            completed: job.completed,
            currentDomain: outcome.domain,
            stage: `Requeued (retry ${nextAttempt}/${MAX_RETRIES} after ${outcome.reason})`,
          });
          continue;
        }

        job.completed++;
        const updatedLead = new LeadsRepo(this.db).getById(
          entry.leadId,
          new SettingsRepo(this.db).get().contactedCooldownDays,
        );
        emitEvent({
          jobId: job.jobId,
          type: 'lead_done',
          total: job.total,
          completed: job.completed,
          currentDomain: updatedLead?.domain,
          lead: updatedLead ?? undefined,
        });
      }
    });

    await Promise.all(workers);
    job.done = true;
    if (this.activeJobId === job.jobId) {
      this.activeJobId = null;
    }
    emitEvent({
      jobId: job.jobId,
      type: 'job_done',
      total: job.total,
      completed: job.completed,
      message: `Completed scanning ${job.completed} site(s)`,
    });
  }

  private async scanSingleLead(
    job: ActiveJob,
    leadId: string,
    forceRescan: boolean,
    attempt: number,
    emitEvent: (ev: ScanProgressEvent) => void,
  ): Promise<{ requeue: true; delayMs: number; reason: string; domain: string } | void> {
    const settings = new SettingsRepo(this.db).get();
    const leadsRepo = new LeadsRepo(this.db);
    const supRepo = new SuppressionRepo(this.db);
    const contactsRepo = new ContactsRepo(this.db);

    const lead = leadsRepo.getById(leadId, settings.contactedCooldownDays);
    if (!lead) return;

    const reportStage = (stage: string) => {
      emitEvent({
        jobId: job.jobId,
        type: 'lead_progress',
        total: job.total,
        completed: job.completed,
        currentDomain: lead.domain,
        stage,
      });
    };

    // Enforce Suppression FIRST before making outbound requests
    const sup = supRepo.checkDomainAndCompany(
      lead.domain,
      lead.parentCompany,
      settings.contactedCooldownDays,
    );
    if (!forceRescan && (sup.status === 'opted_out' || sup.status === 'cooldown')) {
      const qual = evaluateQualification({
        settings,
        suppression: sup,
        blockedByBotProtection: false,
        lastError: null,
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
      return;
    }

    leadsRepo.markStatus(lead.id, 'scanning');
    reportStage(attempt > 0 ? `Retrying homepage (attempt ${attempt + 1})...` : 'Fetching homepage...');

    const timeoutMs = attempt === 0 ? 10_000 : attempt === 1 ? 15_000 : 20_000;
    const targetUrl = lead.url || `https://${lead.domain}`;
    let homeRes = await safeFetch(targetUrl, { timeoutMs, maxBytes: 2_000_000 });
    if (!homeRes.ok && !homeRes.blockedByBotProtection && !targetUrl.includes('://www.')) {
      const wwwUrl = `https://www.${lead.domain}`;
      const retry = await safeFetch(wwwUrl, { timeoutMs, maxBytes: 2_000_000 });
      if (retry.ok || retry.blockedByBotProtection) {
        homeRes = retry;
      }
    }

    if (!homeRes.ok) {
      const retryInfo = isRetryableFetchFailure(homeRes);
      if (retryInfo.retryable && attempt < 2) {
        leadsRepo.markStatus(lead.id, 'pending');
        return {
          requeue: true,
          delayMs: retryInfo.delayMs,
          reason: retryInfo.reason,
          domain: lead.domain,
        };
      }
    }

    const preserveExplicitTraffic =
      lead.monthlyVisits !== null && !isEstimatedVisitsSource(lead.visitsSource);
    const waterfall = await lookupTrafficWaterfall(this.db, lead.domain, settings);
    const trancoRank = waterfall.trancoRank;
    const resolvedTraffic = preserveExplicitTraffic
      ? { monthlyVisits: lead.monthlyVisits, visitsSource: lead.visitsSource }
      : { monthlyVisits: waterfall.monthlyVisits, visitsSource: waterfall.visitsSource };

    if (!homeRes.ok) {
      const qual = evaluateQualification({
        settings,
        suppression: sup,
        blockedByBotProtection: homeRes.blockedByBotProtection,
        lastError: homeRes.error || 'Failed to fetch site',
        hasArticles: null,
        articleCountFound: 0,
        latestArticleDate: null,
        hasAds: null,
        hasAudioPlayer: null,
        audioProvidersDetected: [],
        detectedLanguage: null,
        detectedCountry: null,
        monthlyVisits: resolvedTraffic.monthlyVisits,
        hasContacts: lead.contactCount > 0,
      });

      leadsRepo.updateScanResult(lead.id, {
        url: homeRes.finalUrl || targetUrl,
        siteTitle: null,
        description: null,
        status: qual.status,
        verdict: qual.verdict,
        qualificationScore: qual.score,
        qualificationSummary: qual.summary,
        monthlyVisits: resolvedTraffic.monthlyVisits,
        visitsSource: resolvedTraffic.visitsSource,
        trancoRank,
        hasArticles: null,
        articleCountFound: 0,
        latestArticleDate: null,
        avgArticleWords: null,
        sampleArticleUrls: [],
        rssFeedUrl: null,
        sitemapUrl: null,
        hasAds: null,
        hasAdsTxt: null,
        adsTxtEntries: 0,
        adNetworksDetected: [],
        hasAudioPlayer: null,
        audioProvidersDetected: [],
        audioEvidence: null,
        detectedLanguage: null,
        detectedCountry: null,
        keywords: [],
        blockedByBotProtection: homeRes.blockedByBotProtection,
        lastError: homeRes.error || 'Failed to fetch site',
      });
      return;
    }

    const $home = cheerio.load(homeRes.body);
    const siteTitle =
      $home('meta[property="og:site_name"]').attr('content')?.trim() ||
      $home('title').first().text().trim().slice(0, 140) ||
      null;
    const description =
      $home('meta[name="description"]').attr('content')?.trim().slice(0, 300) ||
      $home('meta[property="og:description"]').attr('content')?.trim().slice(0, 300) ||
      null;

    const rawKeywords = ($home('meta[name="keywords"]').attr('content') || '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length >= 2 && k.length <= 35)
      .slice(0, 10);

    reportStage('Checking articles, ads & audio player...');
    const [articleAnalysis, crawledContacts] = await Promise.all([
      analyzeArticles(homeRes.finalUrl, lead.domain, homeRes.body),
      (async () => {
        reportStage('Crawling decision-maker contacts...');
        return crawlSiteContacts(homeRes.finalUrl, lead.domain, homeRes.body);
      })(),
    ]);

    const htmlDocs: Array<{ url: string; html: string; isArticle?: boolean }> = [
      { url: homeRes.finalUrl, html: homeRes.body, isArticle: false },
      ...articleAnalysis.sampledArticles.map((a) => ({
        url: a.url,
        html: a.html,
        isArticle: true,
      })),
    ];

    const audioResult = detectAudioPlayersFromHtml(htmlDocs);
    const adResult = await analyzeAds(homeRes.finalUrl, htmlDocs);

    const extraText = articleAnalysis.sampledArticles
      .map((a) => cheerio.load(a.html)('p').slice(0, 10).text())
      .join(' ');
    const langResult = detectLanguageAndCountry(
      $home,
      lead.domain,
      extraText,
      homeRes.headers['content-language'],
    );

    const parentCompany = lead.parentCompany || detectParentCompany($home, lead.domain);
    const effectiveSup = supRepo.checkDomainAndCompany(
      lead.domain,
      parentCompany,
      settings.contactedCooldownDays,
    );

    const savedContacts = contactsRepo.replaceCrawledContacts(lead.id, crawledContacts);
    const hasUsableContact = savedContacts.some((c) => Boolean(c.email));

    const qual = evaluateQualification({
      settings,
      suppression: effectiveSup,
      blockedByBotProtection: false,
      lastError: null,
      hasArticles: articleAnalysis.hasArticles,
      articleCountFound: articleAnalysis.articleCountFound,
      latestArticleDate: articleAnalysis.latestArticleDate,
      hasAds: adResult.hasAds,
      hasAudioPlayer: audioResult.hasAudioPlayer,
      audioProvidersDetected: audioResult.providersDetected,
      detectedLanguage: langResult.language,
      detectedCountry: langResult.country,
      monthlyVisits: resolvedTraffic.monthlyVisits,
      hasContacts: hasUsableContact,
    });

    leadsRepo.updateScanResult(lead.id, {
      url: homeRes.finalUrl,
      siteTitle,
      description,
      parentCompany,
      status: qual.status,
      verdict: qual.verdict,
      qualificationScore: qual.score,
      qualificationSummary: qual.summary,
      monthlyVisits: resolvedTraffic.monthlyVisits,
      visitsSource: resolvedTraffic.visitsSource,
      trancoRank,
      hasArticles: articleAnalysis.hasArticles,
      articleCountFound: articleAnalysis.articleCountFound,
      latestArticleDate: articleAnalysis.latestArticleDate,
      avgArticleWords: articleAnalysis.avgArticleWords,
      sampleArticleUrls: articleAnalysis.sampleArticleUrls,
      rssFeedUrl: articleAnalysis.rssFeedUrl,
      sitemapUrl: articleAnalysis.sitemapUrl,
      hasAds: adResult.hasAds,
      hasAdsTxt: adResult.hasAdsTxt,
      adsTxtEntries: adResult.adsTxtEntries,
      adNetworksDetected: adResult.adNetworksDetected,
      hasAudioPlayer: audioResult.hasAudioPlayer,
      audioProvidersDetected: audioResult.providersDetected,
      audioEvidence: audioResult.evidence,
      detectedLanguage: langResult.language,
      detectedCountry: langResult.country,
      keywords: rawKeywords,
      blockedByBotProtection: false,
      lastError: null,
    });

    // Passively mine outbound independent publisher links into Suggestions
    await mineOutboundSuggestions(this.db, {
      sourceLeadId: lead.id,
      sourceDomain: lead.domain,
      outboundLinks: articleAnalysis.outboundLinks,
      excludeMegaPublishers: settings.excludeMegaPublishers,
      cooldownDays: settings.contactedCooldownDays,
      minMonthlyVisits: settings.minMonthlyVisits,
      trafficSettings: settings,
    });
  }
}
