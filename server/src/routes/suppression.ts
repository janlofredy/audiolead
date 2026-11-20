import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDatabase } from '../db/index.js';
import {
  LeadsRepo,
  SettingsRepo,
  SuggestionsRepo,
  SuppressionRepo,
} from '../db/repositories.js';
import {
  parseCsvSuppressionBuffer,
  parseRawSuppressionText,
  parseXlsxSuppressionBuffer,
  previewSuppressionRows,
} from '../services/suppression/suppressionParser.js';
import { reconcileLeadsWithSuppression } from '../services/suppression/reconcile.js';
import {
  normalizeDomain,
  parseFlexibleDate,
  todayIsoDate,
} from '../services/scanner/domainUtils.js';

const commitSchema = z.object({
  type: z.enum(['contacted', 'opt_out']),
  items: z
    .array(
      z.object({
        domain: z.string().min(1),
        eventDate: z.string().optional(),
        reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const singleSchema = z.object({
  domain: z.string().min(1),
  type: z.enum(['contacted', 'opt_out']),
  eventDate: z.string().optional(),
  reason: z.string().nullable().optional(),
});

export function createSuppressionRoutes(db: AppDatabase): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const type = (c.req.query('type') || 'all') as 'contacted' | 'opt_out' | 'all';
    const q = c.req.query('q') || '';
    const settings = new SettingsRepo(db).get();
    const rules = new SuppressionRepo(db).list(settings.contactedCooldownDays, { type, q });

    return c.json({
      rules,
      contactedCooldownDays: settings.contactedCooldownDays,
    });
  });

  app.post('/preview', async (c) => {
    const contentType = c.req.header('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      const typeRaw = String(formData.get('type') || 'contacted');
      const type = typeRaw === 'opt_out' ? 'opt_out' : 'contacted';
      const file = formData.get('file');
      const rawText = formData.get('rawText');

      if (file && typeof file !== 'string') {
        const buf = Buffer.from(await file.arrayBuffer());
        const fileName = (file.name || '').toLowerCase();
        const rows = fileName.endsWith('.xlsx')
          ? await parseXlsxSuppressionBuffer(buf)
          : parseCsvSuppressionBuffer(buf);
        return c.json(previewSuppressionRows(db, rows, type));
      }

      if (typeof rawText === 'string' && rawText.trim()) {
        const rows = parseRawSuppressionText(rawText);
        return c.json(previewSuppressionRows(db, rows, type));
      }

      return c.json({ error: 'Upload a CSV/XLSX file or paste domains.' }, 400);
    }

    const body = (await c.req.json().catch(() => null)) as {
      type?: 'contacted' | 'opt_out';
      rawText?: string;
    } | null;

    if (!body?.rawText?.trim()) {
      return c.json({ error: 'Paste at least one domain.' }, 400);
    }
    const type = body.type === 'opt_out' ? 'opt_out' : 'contacted';
    const rows = parseRawSuppressionText(body.rawText);
    return c.json(previewSuppressionRows(db, rows, type));
  });

  app.post('/commit', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = commitSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid suppression commit payload.' }, 400);
    }

    const supRepo = new SuppressionRepo(db);
    const settings = new SettingsRepo(db).get();
    const today = todayIsoDate();

    let inserted = 0;
    let updated = 0;
    let protectedOptOut = 0;
    let skippedOlder = 0;
    const touchedDomains: string[] = [];

    const tx = db.transaction(() => {
      for (const item of parsed.data.items) {
        const domain = normalizeDomain(item.domain);
        if (!domain) continue;
        const eventDate = parseFlexibleDate(item.eventDate) ?? today;
        const res = supRepo.upsertRule({
          domain,
          type: parsed.data.type,
          eventDate,
          reason: item.reason ?? null,
          source: 'import',
        });

        touchedDomains.push(domain);
        if (res.status === 'inserted') inserted++;
        else if (res.status === 'updated') updated++;
        else if (res.status === 'protected_opt_out') protectedOptOut++;
        else if (res.status === 'skipped_older') skippedOlder++;
      }
    });
    tx();

    const leadsUpdated = new LeadsRepo(db).applyRetroactiveSuppression(
      touchedDomains,
      settings.contactedCooldownDays,
    );
    new SuggestionsRepo(db).dismissMatchingDomains(touchedDomains);

    return c.json({
      inserted,
      updated,
      protectedOptOut,
      skippedOlder,
      leadsAffected: leadsUpdated,
    });
  });

  app.post('/single', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = singleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Please provide a valid domain.' }, 400);
    }

    const domain = normalizeDomain(parsed.data.domain);
    if (!domain) {
      return c.json({ error: 'Could not recognize a valid domain name.' }, 400);
    }

    const settings = new SettingsRepo(db).get();
    const eventDate = parseFlexibleDate(parsed.data.eventDate) ?? todayIsoDate();
    const res = new SuppressionRepo(db).upsertRule({
      domain,
      type: parsed.data.type,
      eventDate,
      reason: parsed.data.reason ?? null,
      source: 'manual',
    });

    new LeadsRepo(db).applyRetroactiveSuppression([domain], settings.contactedCooldownDays);
    new SuggestionsRepo(db).dismissMatchingDomains([domain]);

    const rule = new SuppressionRepo(db).getById(res.id, settings.contactedCooldownDays);
    return c.json({ status: res.status, rule });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      type?: 'contacted' | 'opt_out';
      eventDate?: string;
      reason?: string | null;
    } | null;
    if (!body) return c.json({ error: 'Invalid request body' }, 400);

    const settings = new SettingsRepo(db).get();
    const parsedDate = body.eventDate ? parseFlexibleDate(body.eventDate) : undefined;
    if (body.eventDate && !parsedDate) {
      return c.json({ error: 'Invalid date format (use YYYY-MM-DD).' }, 400);
    }

    const updated = new SuppressionRepo(db).updateById(
      id,
      {
        type: body.type,
        eventDate: parsedDate ?? undefined,
        reason: body.reason,
      },
      settings.contactedCooldownDays,
    );

    if (!updated) return c.json({ error: 'Rule not found' }, 404);
    reconcileLeadsWithSuppression(db, [updated.domain]);
    return c.json({ rule: updated });
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const { deletedDomain } = new SuppressionRepo(db).deleteById(id);
    if (!deletedDomain) return c.json({ error: 'Rule not found' }, 404);
    reconcileLeadsWithSuppression(db, [deletedDomain]);
    return c.json({ ok: true, deletedDomain });
  });

  return app;
}
