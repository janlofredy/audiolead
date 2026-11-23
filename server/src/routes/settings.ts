import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDatabase } from '../db/index.js';
import { SettingsRepo } from '../db/repositories.js';
import { reconcileLeadsWithSuppression } from '../services/suppression/reconcile.js';

const updateSettingsSchema = z.object({
  minMonthlyVisits: z.number().min(0).optional(),
  targetLanguages: z.array(z.string()).optional(),
  targetCountries: z.array(z.string()).optional(),
  requireArticles: z.boolean().optional(),
  requireAds: z.boolean().optional(),
  requireNoAudioPlayer: z.boolean().optional(),
  minArticleCount: z.number().min(1).optional(),
  maxDaysSinceLastArticle: z.number().min(1).optional(),
  contactedCooldownDays: z.number().min(0).max(3650).optional(),
  excludeMegaPublishers: z.boolean().optional(),
  hunterApiKey: z.string().optional(),
  apolloApiKey: z.string().optional(),
  serperApiKey: z.string().optional(),
  braveApiKey: z.string().optional(),
  openPageRankApiKey: z.string().optional(),
  cloudflareRadarApiToken: z.string().optional(),
  googleCruxApiKey: z.string().optional(),
  llmProvider: z.enum(['none', 'openai', 'gemini']).optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().optional(),
});

export function createSettingsRoutes(db: AppDatabase): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const masked = new SettingsRepo(db).getMasked();
    return c.json({ settings: masked });
  });

  app.put('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid settings payload' }, 400);
    }

    const repo = new SettingsRepo(db);
    const prevCooldown = repo.get().contactedCooldownDays;
    const masked = repo.update(parsed.data);

    if (
      parsed.data.contactedCooldownDays !== undefined &&
      parsed.data.contactedCooldownDays !== prevCooldown
    ) {
      reconcileLeadsWithSuppression(db);
    }

    return c.json({ settings: masked });
  });

  return app;
}
