import { Hono } from 'hono';
import Papa from 'papaparse';
import { z } from 'zod';
import type { AuthorityTier, LeadStatus } from '@audiolead/shared';
import type { AppDatabase } from '../db/index.js';
import {
  ContactsRepo,
  LeadsRepo,
  SettingsRepo,
  SuggestionsRepo,
  SuppressionRepo,
} from '../db/repositories.js';
import {
  parseTrafficNumber,
  todayIsoDate,
} from '../services/scanner/domainUtils.js';
import { evaluateQualification } from '../services/scanner/qualificationEngine.js';
import { isGenericRoleEmail, scoreContactAuthority } from '../services/scanner/authorityRanker.js';
import { enrichDomainWithApis } from '../services/scanner/enrichmentService.js';

const updateLeadSchema = z.object({
  monthlyVisits: z.union([z.number(), z.string(), z.null()]).optional(),
  status: z
    .enum([
      'pending',
      'scanning',
      'qualified',
      'review',
      'disqualified',
      'contact_found',
      'contacted',
      'opted_out',
      'exported',
    ])
    .optional(),
  notes: z.string().nullable().optional(),
});

const addContactSchema = z.object({
  fullName: z.string().nullable().optional(),
  roleTitle: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const patchContactSchema = z.object({
  fullName: z.string().nullable().optional(),
  roleTitle: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

function sanitizeSheetCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

export function createLeadsRoutes(db: AppDatabase): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const settings = new SettingsRepo(db).get();
    const q = c.req.query('q') || '';
    const verdict = c.req.query('verdict') || 'all';
    const status = c.req.query('status') || 'all';
    const hasAds = (c.req.query('hasAds') || 'all') as 'yes' | 'no' | 'all';
    const hasAudio = (c.req.query('hasAudio') || 'all') as 'yes' | 'no' | 'all';

    const result = new LeadsRepo(db).list(settings.contactedCooldownDays, {
      q,
      verdict,
      status,
      hasAds,
      hasAudio,
    });
    return c.json(result);
  });

  app.get('/export', (c) => {
    const format = c.req.query('format') === 'tsv' ? 'tsv' : 'csv';
    const verdict = c.req.query('verdict') || 'all';
    const includeSuppressed = c.req.query('includeSuppressed') === 'true';

    const settings = new SettingsRepo(db).get();
    const leadsRepo = new LeadsRepo(db);
    const { leads: allMatching } = leadsRepo.list(settings.contactedCooldownDays, { verdict });

    let excludedSuppressed = 0;
    const exportRows = allMatching.filter((lead) => {
      const isSuppressed =
        lead.suppression.status === 'opted_out' || lead.suppression.status === 'cooldown';
      if (!includeSuppressed && isSuppressed) {
        excludedSuppressed++;
        return false;
      }
      return true;
    });

    const headers = [
      'Website',
      'URL',
      'Verdict',
      'Score',
      'Monthly Visits',
      'Tranco Rank',
      'Has Articles',
      'Latest Article',
      'Has Ads',
      'Ad Networks',
      'Audio Player',
      'Language',
      'Decision Maker',
      'Role',
      'Authority Tier',
      'Email',
      'Generic Email?',
      'Contact Source',
      'Discovery Source',
      'Status',
      'Qualification Notes',
      'Notes',
    ];

    const matrix = exportRows.map((l) => [
      sanitizeSheetCell(l.domain),
      sanitizeSheetCell(l.url),
      l.verdict,
      String(l.qualificationScore),
      l.monthlyVisits !== null ? String(l.monthlyVisits) : '',
      l.trancoRank !== null ? String(l.trancoRank) : '',
      l.hasArticles === null ? '' : l.hasArticles ? 'Yes' : 'No',
      l.latestArticleDate || '',
      l.hasAds === null ? '' : l.hasAds ? 'Yes' : 'No',
      sanitizeSheetCell(l.adNetworksDetected.join(', ')),
      l.hasAudioPlayer === null ? '' : l.hasAudioPlayer ? `Yes (${l.audioProvidersDetected.join(', ')})` : 'No',
      l.detectedLanguage ? l.detectedLanguage.toUpperCase() : '',
      sanitizeSheetCell(l.primaryContact?.fullName),
      sanitizeSheetCell(l.primaryContact?.roleTitle),
      l.primaryContact ? `Tier ${l.primaryContact.authorityTier}` : '',
      sanitizeSheetCell(l.primaryContact?.email),
      l.primaryContact?.email ? (l.primaryContact.isGenericEmail ? 'Yes (Fallback)' : 'No (Personal)') : '',
      sanitizeSheetCell(l.primaryContact?.sourceUrl),
      sanitizeSheetCell(l.discoverySource),
      l.status,
      sanitizeSheetCell(l.qualificationSummary),
      sanitizeSheetCell(l.notes),
    ]);

    c.header('X-Excluded-Suppressed', String(excludedSuppressed));
    c.header('X-Exported-Count', String(exportRows.length));

    if (format === 'tsv') {
      const tsv = [headers, ...matrix]
        .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ')).join('\t'))
        .join('\n');
      c.header('Content-Type', 'text/tab-separated-values; charset=utf-8');
      return c.body(tsv);
    }

    const csv = Papa.unparse({ fields: headers, data: matrix });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="audiolead-export.csv"');
    return c.body(csv);
  });

  app.get('/:id', (c) => {
    const settings = new SettingsRepo(db).get();
    const lead = new LeadsRepo(db).getById(c.req.param('id'), settings.contactedCooldownDays);
    if (!lead) return c.json({ error: 'Lead not found' }, 404);
    return c.json({ lead });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = updateLeadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid lead update payload' }, 400);
    }

    const settings = new SettingsRepo(db).get();
    const leadsRepo = new LeadsRepo(db);
    const existing = leadsRepo.getById(id, settings.contactedCooldownDays);
    if (!existing) return c.json({ error: 'Lead not found' }, 404);

    const supRepo = new SuppressionRepo(db);
    const today = todayIsoDate();

    let nextVisits = existing.monthlyVisits;
    let nextVisitsSource = existing.visitsSource;
    if (parsed.data.monthlyVisits !== undefined) {
      nextVisits =
        parsed.data.monthlyVisits === null || parsed.data.monthlyVisits === ''
          ? null
          : parseTrafficNumber(parsed.data.monthlyVisits);
      nextVisitsSource = nextVisits !== null ? 'manual' : null;
    }

    let nextStatus: LeadStatus = parsed.data.status ?? existing.status;

    // Sync suppression rules when user marks Contacted or Opted Out
    if (parsed.data.status === 'contacted') {
      supRepo.upsertRule({
        domain: existing.domain,
        type: 'contacted',
        eventDate: today,
        reason: 'Marked contacted from pipeline',
        source: 'pipeline',
      });
      new SuggestionsRepo(db).dismissMatchingDomains([existing.domain]);
    } else if (parsed.data.status === 'opted_out') {
      supRepo.upsertRule({
        domain: existing.domain,
        type: 'opt_out',
        eventDate: today,
        reason: 'Marked opt-out from pipeline',
        source: 'pipeline',
      });
      new SuggestionsRepo(db).dismissMatchingDomains([existing.domain]);
    }

    const latestSup = supRepo.checkDomain(existing.domain, settings.contactedCooldownDays);

    let nextVerdict = existing.verdict;
    let nextScore = existing.qualificationScore;
    let nextSummary = existing.qualificationSummary ?? '';

    if (
      parsed.data.monthlyVisits !== undefined ||
      parsed.data.status === 'opted_out' ||
      parsed.data.status === 'contacted'
    ) {
      if (existing.lastScannedAt !== null || parsed.data.status === 'opted_out' || parsed.data.status === 'contacted') {
        const qual = evaluateQualification({
          settings,
          suppression: latestSup,
          blockedByBotProtection: existing.blockedByBotProtection,
          lastError: existing.lastError,
          hasArticles: existing.hasArticles,
          articleCountFound: existing.articleCountFound,
          latestArticleDate: existing.latestArticleDate,
          hasAds: existing.hasAds,
          hasAudioPlayer: existing.hasAudioPlayer,
          audioProvidersDetected: existing.audioProvidersDetected,
          detectedLanguage: existing.detectedLanguage,
          detectedCountry: existing.detectedCountry,
          monthlyVisits: nextVisits,
          hasContacts: existing.contacts.some((ct) => Boolean(ct.email)),
        });

        nextVerdict = qual.verdict;
        nextScore = qual.score;
        nextSummary = qual.summary;

        // Preserve explicit status like 'contacted' or 'exported' if user picked it
        if (parsed.data.status === 'contacted') {
          nextStatus = latestSup.status === 'opted_out' ? 'opted_out' : 'contacted';
        } else if (parsed.data.status === 'opted_out') {
          nextStatus = 'opted_out';
        } else if (!parsed.data.status) {
          nextStatus = qual.status;
        }
      }
    }

    leadsRepo.updateLeadFields(id, {
      monthlyVisits: parsed.data.monthlyVisits !== undefined ? nextVisits : undefined,
      visitsSource: parsed.data.monthlyVisits !== undefined ? nextVisitsSource : undefined,
      status: nextStatus,
      verdict: nextVerdict,
      qualificationScore: nextScore,
      qualificationSummary: nextSummary,
      notes: parsed.data.notes !== undefined ? parsed.data.notes : undefined,
    });

    const updated = leadsRepo.getById(id, settings.contactedCooldownDays);
    return c.json({ lead: updated });
  });

  app.delete('/:id', (c) => {
    const deleted = new LeadsRepo(db).deleteLead(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Lead not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/contacts', async (c) => {
    const leadId = c.req.param('id');
    const settings = new SettingsRepo(db).get();
    const lead = new LeadsRepo(db).getById(leadId, settings.contactedCooldownDays);
    if (!lead) return c.json({ error: 'Lead not found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = addContactSchema.safeParse(body);
    if (!parsed.success || (!parsed.data.fullName && !parsed.data.email)) {
      return c.json({ error: 'Provide at least a name or email.' }, 400);
    }

    const email = parsed.data.email?.trim().toLowerCase() || null;
    const auth = scoreContactAuthority({
      fullName: parsed.data.fullName,
      roleTitle: parsed.data.roleTitle,
      email,
    });

    const contact = new ContactsRepo(db).addContact(leadId, {
      fullName: parsed.data.fullName ?? null,
      roleTitle: parsed.data.roleTitle ?? null,
      authorityTier: auth.tier as AuthorityTier,
      authorityScore: auth.score,
      email,
      isGenericEmail: email ? isGenericRoleEmail(email) : false,
      linkedinUrl: parsed.data.linkedinUrl ?? null,
      sourceType: 'manual',
      isPrimary: parsed.data.isPrimary ?? true,
    });

    if (lead.verdict === 'qualified' && email && lead.status === 'qualified') {
      new LeadsRepo(db).markStatus(leadId, 'contact_found');
    }

    const updatedLead = new LeadsRepo(db).getById(leadId, settings.contactedCooldownDays);
    return c.json({ contact, lead: updatedLead });
  });

  app.patch('/contacts/:contactId', async (c) => {
    const contactId = c.req.param('contactId');
    const body = await c.req.json().catch(() => null);
    const parsed = patchContactSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid contact payload' }, 400);

    const contactsRepo = new ContactsRepo(db);
    const email =
      parsed.data.email !== undefined
        ? parsed.data.email?.trim().toLowerCase() || null
        : undefined;

    let tierPatch: AuthorityTier | undefined;
    let scorePatch: number | undefined;
    if (parsed.data.roleTitle !== undefined || email !== undefined) {
      const auth = scoreContactAuthority({
        fullName: parsed.data.fullName,
        roleTitle: parsed.data.roleTitle,
        email: email ?? null,
      });
      tierPatch = auth.tier;
      scorePatch = auth.score;
    }

    const updated = contactsRepo.updateContact(contactId, {
      fullName: parsed.data.fullName,
      roleTitle: parsed.data.roleTitle,
      authorityTier: tierPatch,
      authorityScore: scorePatch,
      email,
      isGenericEmail: email !== undefined ? (email ? isGenericRoleEmail(email) : false) : undefined,
      linkedinUrl: parsed.data.linkedinUrl,
      isPrimary: parsed.data.isPrimary,
    });

    if (!updated) return c.json({ error: 'Contact not found' }, 404);
    return c.json({ contact: updated });
  });

  app.delete('/contacts/:contactId', (c) => {
    const ok = new ContactsRepo(db).deleteContact(c.req.param('contactId'));
    if (!ok) return c.json({ error: 'Contact not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/enrich', async (c) => {
    const id = c.req.param('id');
    const settings = new SettingsRepo(db).get();
    const leadsRepo = new LeadsRepo(db);
    const lead = leadsRepo.getById(id, settings.contactedCooldownDays);
    if (!lead) return c.json({ error: 'Lead not found' }, 404);

    if (
      !settings.hunterApiKey &&
      !settings.apolloApiKey &&
      (settings.llmProvider === 'none' || !settings.llmApiKey)
    ) {
      return c.json(
        {
          error:
            'No enrichment API keys configured. Add a Hunter.io, Apollo.io, or LLM key in Settings first.',
        },
        400,
      );
    }

    const enriched = await enrichDomainWithApis(lead.domain, lead.url, settings);
    const contactsRepo = new ContactsRepo(db);
    const existingEmails = new Set(
      lead.contacts.map((ct) => ct.email?.toLowerCase()).filter(Boolean),
    );

    let added = 0;
    for (const item of enriched.contacts) {
      if (item.email && existingEmails.has(item.email.toLowerCase())) continue;
      if (item.email) existingEmails.add(item.email.toLowerCase());
      contactsRepo.addContact(lead.id, {
        ...item,
        isPrimary: lead.contacts.length === 0 && added === 0,
      });
      added++;
    }

    if (added > 0 && lead.verdict === 'qualified' && lead.status === 'qualified') {
      leadsRepo.markStatus(lead.id, 'contact_found');
    }

    const updated = leadsRepo.getById(id, settings.contactedCooldownDays);
    return c.json({
      addedCount: added,
      providersUsed: enriched.providersUsed,
      notes: enriched.notes,
      lead: updated,
    });
  });

  return app;
}
