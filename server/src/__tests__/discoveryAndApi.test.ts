import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { createApp } from '../app.js';
import { parseSimilarwebPaste } from '../services/discovery/similarwebParser.js';
import { addDaysToIsoDate, todayIsoDate } from '../services/scanner/domainUtils.js';

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
});
