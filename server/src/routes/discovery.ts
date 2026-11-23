import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDatabase } from '../db/index.js';
import {
  LeadsRepo,
  SettingsRepo,
  SuggestionsRepo,
  SuppressionRepo,
} from '../db/repositories.js';
import { discoverByNiche } from '../services/discovery/nicheDiscovery.js';
import { discoverSimilarSites } from '../services/discovery/similarDiscovery.js';
import { parseSimilarwebPaste } from '../services/discovery/similarwebParser.js';
import { normalizeDomain, parseTrafficNumber } from '../services/scanner/domainUtils.js';
import type { ScanOrchestrator } from '../services/scanner/scanOrchestrator.js';

const nicheSchema = z.object({
  query: z.string().min(2).max(200),
  intent: z.enum(['news_articles', 'independent_blogs', 'guides_reviews']).optional(),
  language: z.string().max(10).optional(),
  country: z.string().max(10).optional(),
  excludeMegaPublishers: z.boolean().optional(),
});

const similarSchema = z.object({
  leadId: z.string().optional(),
  seedUrl: z.string().optional(),
});

const similarwebSchema = z.object({
  rawText: z.string().min(1),
});

const queueSchema = z.object({
  items: z
    .array(
      z.object({
        domain: z.string().min(1),
        url: z.string().optional(),
        title: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        monthlyVisits: z.union([z.number(), z.string(), z.null()]).optional(),
        visitsSource: z.enum(['manual', 'similarweb_paste', 'discovery']).optional(),
        discoverySource: z.string().optional(),
      }),
    )
    .min(1),
  autoScan: z.boolean().optional().default(true),
});

export function createDiscoveryRoutes(db: AppDatabase, orchestrator: ScanOrchestrator): Hono {
  const app = new Hono();

  app.post('/niche', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = nicheSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Please provide a search topic (at least 2 characters).' }, 400);
    }

    const settings = new SettingsRepo(db).get();
    const result = await discoverByNiche(db, settings, parsed.data);
    return c.json(result);
  });

  app.post('/similar', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = similarSchema.safeParse(body);
    if (!parsed.success || (!parsed.data.leadId && !parsed.data.seedUrl)) {
      return c.json({ error: 'Provide either leadId or seedUrl.' }, 400);
    }

    try {
      const settings = new SettingsRepo(db).get();
      const result = await discoverSimilarSites(db, settings, parsed.data);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Could not analyze seed website' },
        400,
      );
    }
  });

  app.post('/similarweb/preview', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = similarwebSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Paste text copied from Similarweb first.' }, 400);
    }

    const settings = new SettingsRepo(db).get();
    const result = parseSimilarwebPaste(db, parsed.data.rawText, settings.contactedCooldownDays);
    return c.json(result);
  });

  app.post('/queue', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = queueSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid queue payload.' }, 400);
    }

    const settings = new SettingsRepo(db).get();
    const supRepo = new SuppressionRepo(db);
    const leadsRepo = new LeadsRepo(db);
    const suggestionsRepo = new SuggestionsRepo(db);

    const eligibleItems: Array<{
      domain: string;
      url: string;
      title?: string | null;
      description?: string | null;
      monthlyVisits: number | null;
      visitsSource: 'manual' | 'similarweb_paste' | 'discovery' | null;
      discoverySource: string;
    }> = [];

    const skippedSuppressed: Array<{ domain: string; reason: string }> = [];
    const invalidDomains: string[] = [];

    for (const rawItem of parsed.data.items) {
      const domain = normalizeDomain(rawItem.domain);
      if (!domain) {
        invalidDomains.push(rawItem.domain);
        continue;
      }

      const sup = supRepo.checkDomain(domain, settings.contactedCooldownDays);
      if (sup.status === 'opted_out') {
        skippedSuppressed.push({
          domain,
          reason: `Opted out (${sup.eventDate})`,
        });
        continue;
      }
      if (sup.status === 'cooldown') {
        skippedSuppressed.push({
          domain,
          reason: `Already contacted (${sup.daysRemaining}d cooldown left)`,
        });
        continue;
      }

      const visits =
        rawItem.monthlyVisits !== undefined && rawItem.monthlyVisits !== null
          ? parseTrafficNumber(rawItem.monthlyVisits)
          : null;

      eligibleItems.push({
        domain,
        url: rawItem.url && rawItem.url.startsWith('http') ? rawItem.url : `https://${domain}`,
        title: rawItem.title ?? null,
        description: rawItem.description ?? null,
        monthlyVisits: visits,
        visitsSource: visits !== null ? rawItem.visitsSource ?? 'discovery' : null,
        discoverySource: rawItem.discoverySource || 'discovery',
      });
    }

    const { createdIds, skippedExisting } = leadsRepo.createPending(eligibleItems);
    suggestionsRepo.dismissMatchingDomains(eligibleItems.map((i) => i.domain));

    let jobId: string | null = null;
    if (parsed.data.autoScan && createdIds.length > 0) {
      jobId = orchestrator.startJob(createdIds).jobId;
    }

    return c.json({
      addedCount: createdIds.length,
      createdIds,
      skippedExisting,
      skippedSuppressed,
      invalidDomains,
      jobId,
    });
  });

  app.get('/suggestions', (c) => {
    const settings = new SettingsRepo(db).get();
    const suggestions = new SuggestionsRepo(db).list(settings.contactedCooldownDays, 'new');
    return c.json({ suggestions });
  });

  app.patch('/suggestions/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      action?: 'queue' | 'dismiss';
      autoScan?: boolean;
    } | null;

    if (!body || (body.action !== 'queue' && body.action !== 'dismiss')) {
      return c.json({ error: 'Action must be queue or dismiss.' }, 400);
    }

    const repo = new SuggestionsRepo(db);
    const suggestion = repo.getById(id);
    if (!suggestion) {
      return c.json({ error: 'Suggestion not found' }, 404);
    }

    if (body.action === 'dismiss') {
      repo.updateStatus(id, 'dismissed');
      return c.json({ ok: true, status: 'dismissed' });
    }

    const settings = new SettingsRepo(db).get();
    const sup = new SuppressionRepo(db).checkDomain(
      suggestion.domain,
      settings.contactedCooldownDays,
    );
    if (sup.status === 'opted_out' || sup.status === 'cooldown') {
      repo.updateStatus(id, 'dismissed');
      return c.json({ error: `Domain is suppressed (${sup.status})`, suppressed: true }, 409);
    }

    const { createdIds, skippedExisting } = new LeadsRepo(db).createPending([
      {
        domain: suggestion.domain,
        url: suggestion.sample_url,
        title: suggestion.title,
        description: suggestion.snippet,
        monthlyVisits: suggestion.estimated_visits,
        visitsSource: suggestion.estimated_visits ? 'discovery' : null,
        discoverySource:
          suggestion.source_type === 'outbound_mine' && suggestion.source_domain
            ? `Mined from ${suggestion.source_domain}`
            : suggestion.source_type,
      },
    ]);

    repo.updateStatus(id, 'queued');

    let jobId: string | null = null;
    if ((body.autoScan ?? true) && createdIds.length > 0) {
      jobId = orchestrator.startJob(createdIds).jobId;
    }

    return c.json({ ok: true, createdIds, skippedExisting, jobId });
  });

  app.post('/suggestions/bulk-queue', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      ids?: string[];
      limit?: number | 'all';
      autoScan?: boolean;
    };
    const settings = new SettingsRepo(db).get();
    const suggestionsRepo = new SuggestionsRepo(db);
    const allNew = suggestionsRepo.list(settings.contactedCooldownDays, 'new');
    const selected = body.ids?.length
      ? allNew.filter((s) => body.ids!.includes(s.id))
      : body.limit === 'all'
        ? allNew.slice(0, 500)
        : allNew.slice(0, Math.min(500, Math.max(1, Number(body.limit) || 25)));

    const { createdIds, skippedExisting } = new LeadsRepo(db).createPending(
      selected.map((s) => ({
        domain: s.domain,
        url: s.sampleUrl,
        title: s.title,
        description: s.snippet,
        monthlyVisits: s.estimatedVisits,
        visitsSource: s.estimatedVisits ? 'discovery' : null,
        discoverySource: s.sourceDomain ? `Mined from ${s.sourceDomain}` : s.sourceType,
      })),
    );

    for (const s of selected) {
      suggestionsRepo.updateStatus(s.id, 'queued');
    }

    let jobId: string | null = null;
    if ((body.autoScan ?? true) && createdIds.length > 0) {
      jobId = orchestrator.startJob(createdIds).jobId;
    }

    return c.json({ addedCount: createdIds.length, createdIds, skippedExisting, jobId });
  });

  return app;
}
