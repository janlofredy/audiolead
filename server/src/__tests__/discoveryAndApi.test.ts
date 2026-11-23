import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { createApp } from '../app.js';
import { parseSimilarwebPaste } from '../services/discovery/similarwebParser.js';
import { addDaysToIsoDate, todayIsoDate } from '../services/scanner/domainUtils.js';
import { LeadsRepo, SuggestionsRepo, TrancoRepo } from '../db/repositories.js';
import { backfillTrancoVisitEstimates } from '../services/suppression/reconcile.js';
import { mineOutboundSuggestions } from '../services/discovery/outboundMiner.js';

describe('discovery, suppression & API integration', () => {
  it('parses Similarweb paste text and tags suppression/pipeline state accurately', () => {
    const db = createDatabase(':memory:');
    const app = createApp(db);
    expect(app).toBeDefined();

    const parsed = parseSimilarwebPaste(
      db,
      `
      examplefinance.com
      420.5K
      savingadvice.org   1.2M
      `,
      90,
    );

    expect(parsed.summary.totalFound).toBe(2);
    expect(parsed.summary.freshCount).toBe(2);
    expect(parsed.candidates.find((c) => c.domain === 'examplefinance.com')?.monthlyVisits).toBe(
      420_500,
    );
    expect(parsed.candidates.find((c) => c.domain === 'savingadvice.org')?.monthlyVisits).toBe(
      1_200_000,
    );
  });

  it('enforces suppression across queue, pipeline status sync, and CSV/TSV export', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db);
    const today = todayIsoDate();
    const expiredDate = addDaysToIsoDate(today, -120);

    // 1. Add 1 active contacted, 1 expired contacted, and 1 permanent opt-out
    const supCommitRes = await app.request('/api/suppression/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'contacted',
        items: [
          { domain: 'activecooldown.com', eventDate: today, reason: 'Emailed this week' },
          { domain: 'expiredcooldown.com', eventDate: expiredDate, reason: 'Old outreach' },
        ],
      }),
    });
    expect(supCommitRes.status).toBe(200);

    const optRes = await app.request('/api/suppression/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'neveremail.com',
        type: 'opt_out',
        reason: 'Replied opt out',
      }),
    });
    expect(optRes.status).toBe(200);

    // 2. Queue 4 sites via discovery/queue (autoScan: false for deterministic DB check)
    const queueRes = await app.request('/api/discovery/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoScan: false,
        items: [
          { domain: 'freshpublisher.com', monthlyVisits: '85K', discoverySource: 'Niche' },
          { domain: 'expiredcooldown.com', monthlyVisits: '120K', discoverySource: 'Niche' },
          { domain: 'activecooldown.com', monthlyVisits: '90K', discoverySource: 'Niche' },
          { domain: 'neveremail.com', monthlyVisits: '200K', discoverySource: 'Niche' },
        ],
      }),
    });
    expect(queueRes.status).toBe(200);
    const queueJson = (await queueRes.json()) as {
      addedCount: number;
      createdIds: string[];
      skippedSuppressed: Array<{ domain: string }>;
    };
    expect(queueJson.addedCount).toBe(2); // freshpublisher.com + expiredcooldown.com
    expect(queueJson.skippedSuppressed.map((s) => s.domain)).toEqual(
      expect.arrayContaining(['activecooldown.com', 'neveremail.com']),
    );

    const freshId = queueJson.createdIds[0];

    // 3. Add a contact to freshpublisher.com and check export includes both eligible leads
    await app.request(`/api/leads/${freshId}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Alex Mercer',
        roleTitle: 'Publisher',
        email: 'alex@freshpublisher.com',
      }),
    });

    const exportBefore = await app.request('/api/leads/export?format=csv');
    expect(exportBefore.status).toBe(200);
    const csvBefore = await exportBefore.text();
    expect(csvBefore).toContain('freshpublisher.com');
    expect(csvBefore).toContain('alex@freshpublisher.com');
    expect(csvBefore).toContain('expiredcooldown.com');

    // 4. Mark freshpublisher.com as opted_out from pipeline -> should auto-suppress & exclude from export
    const patchRes = await app.request(`/api/leads/${freshId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'opted_out' }),
    });
    expect(patchRes.status).toBe(200);

    const exportAfter = await app.request('/api/leads/export?format=tsv');
    expect(exportAfter.status).toBe(200);
    expect(exportAfter.headers.get('X-Excluded-Suppressed')).toBe('1');
    const tsvAfter = await exportAfter.text();
    expect(tsvAfter).not.toContain('freshpublisher.com');
    expect(tsvAfter).toContain('expiredcooldown.com');
  });

  it('backfills estimated monthly visits from Tranco rank and updates qualification', () => {
    const db = createDatabase(':memory:');
    const leadsRepo = new LeadsRepo(db);
    const { createdIds } = leadsRepo.createPending([
      { domain: 'ranked-site.com', discoverySource: 'Niche' },
      { domain: 'manual-site.com', monthlyVisits: 95_000, visitsSource: 'manual', discoverySource: 'Niche' },
    ]);

    const [rankedId, manualId] = createdIds;

    leadsRepo.updateScanResult(rankedId, {
      url: 'https://ranked-site.com',
      siteTitle: 'Ranked Site',
      description: null,
      status: 'review',
      verdict: 'review',
      qualificationScore: 90,
      qualificationSummary: 'Needs traffic check',
      monthlyVisits: null,
      visitsSource: null,
      trancoRank: 250_000,
      hasArticles: true,
      articleCountFound: 10,
      latestArticleDate: todayIsoDate(),
      avgArticleWords: 800,
      sampleArticleUrls: [],
      rssFeedUrl: null,
      sitemapUrl: null,
      hasAds: true,
      hasAdsTxt: true,
      adsTxtEntries: 5,
      adNetworksDetected: ['Google AdSense'],
      hasAudioPlayer: false,
      audioProvidersDetected: [],
      audioEvidence: null,
      detectedLanguage: 'en',
      detectedCountry: 'US',
      keywords: [],
      blockedByBotProtection: false,
      lastError: null,
    });

    leadsRepo.updateScanResult(manualId, {
      url: 'https://manual-site.com',
      siteTitle: 'Manual Site',
      description: null,
      status: 'qualified',
      verdict: 'qualified',
      qualificationScore: 100,
      qualificationSummary: 'Traffic meets threshold',
      monthlyVisits: 95_000,
      visitsSource: 'manual',
      trancoRank: 250_000,
      hasArticles: true,
      articleCountFound: 10,
      latestArticleDate: todayIsoDate(),
      avgArticleWords: 800,
      sampleArticleUrls: [],
      rssFeedUrl: null,
      sitemapUrl: null,
      hasAds: true,
      hasAdsTxt: true,
      adsTxtEntries: 5,
      adNetworksDetected: ['Google AdSense'],
      hasAudioPlayer: false,
      audioProvidersDetected: [],
      audioEvidence: null,
      detectedLanguage: 'en',
      detectedCountry: 'US',
      keywords: [],
      blockedByBotProtection: false,
      lastError: null,
    });

    const updated = backfillTrancoVisitEstimates(db);
    expect(updated).toBe(1);

    const rankedLead = leadsRepo.getById(rankedId, 90);
    expect(rankedLead?.monthlyVisits).toBe(200_000);
    expect(rankedLead?.visitsSource).toBe('tranco_estimate');
    expect(rankedLead?.verdict).toBe('qualified');
    expect(rankedLead?.status).toBe('qualified');

    const manualLead = leadsRepo.getById(manualId, 90);
    expect(manualLead?.monthlyVisits).toBe(95_000);
    expect(manualLead?.visitsSource).toBe('manual');
  });

  it('supports configurable bulk-queue limits and all-batch queueing for suggestions', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db);
    const suggestionsRepo = new SuggestionsRepo(db);

    const items = Array.from({ length: 15 }, (_, idx) => ({
      domain: `suggested-site-${idx + 1}.com`,
      sampleUrl: `https://suggested-site-${idx + 1}.com`,
      sourceType: 'outbound_mine' as const,
      sourceDomain: 'seed-publisher.com',
    }));
    const inserted = suggestionsRepo.addMany(items, 90);
    expect(inserted).toBe(15);

    const firstBatchRes = await app.request('/api/discovery/suggestions/bulk-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 12, autoScan: false }),
    });
    expect(firstBatchRes.status).toBe(200);
    const firstBatchJson = (await firstBatchRes.json()) as { addedCount: number };
    expect(firstBatchJson.addedCount).toBe(12);

    const remainingRes = await app.request('/api/discovery/suggestions/bulk-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 'all', autoScan: false }),
    });
    expect(remainingRes.status).toBe(200);
    const remainingJson = (await remainingRes.json()) as { addedCount: number };
    expect(remainingJson.addedCount).toBe(3);
  });

  it('filters outbound suggestions to high-traffic sites using Tranco rank', async () => {
    const db = createDatabase(':memory:');
    const trancoRepo = new TrancoRepo(db);
    trancoRepo.setCached('high-traffic-pub.com', 100_000); // ~600K/mo
    trancoRepo.setCached('low-traffic-blog.com', 900_000); // ~35K/mo (< 50K)
    trancoRepo.setCached('unranked-site.com', null);

    const added = await mineOutboundSuggestions(db, {
      sourceLeadId: 'seed-1',
      sourceDomain: 'seed-pub.com',
      outboundLinks: [
        'https://high-traffic-pub.com/article',
        'https://low-traffic-blog.com/post',
        'https://unranked-site.com/news',
      ],
      excludeMegaPublishers: true,
      cooldownDays: 90,
      minMonthlyVisits: 50_000,
    });

    expect(added).toBe(1);
    const list = new SuggestionsRepo(db).list(90, 'new');
    expect(list).toHaveLength(1);
    expect(list[0].domain).toBe('high-traffic-pub.com');
    expect(list[0].estimatedVisits).toBe(600_000);
  });

  it('exposes /api/scans/active and resets interrupted scanning leads to pending', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db);
    const leadsRepo = new LeadsRepo(db);

    const activeRes = await app.request('/api/scans/active');
    expect(activeRes.status).toBe(200);
    expect(await activeRes.json()).toEqual({ job: null });

    const { createdIds } = leadsRepo.createPending([{ domain: 'interrupted-site.com' }]);
    leadsRepo.markStatus(createdIds[0], 'scanning');
    expect(leadsRepo.getPendingLeadIds(10)).toHaveLength(0);

    const resetCount = leadsRepo.resetInterruptedScans();
    expect(resetCount).toBe(1);
    expect(leadsRepo.getPendingLeadIds(10)).toEqual([createdIds[0]]);
  });
});
