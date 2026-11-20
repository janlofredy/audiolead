import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createDatabase } from '../db/index.js';
import {
  evaluateSuppressionRule,
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
import { addDaysToIsoDate, todayIsoDate } from '../services/scanner/domainUtils.js';

describe('suppression & cooldown rules', () => {
  it('enforces configurable contacted cooldown and expires automatically', () => {
    const today = todayIsoDate();
    const recent = addDaysToIsoDate(today, -20);
    const old = addDaysToIsoDate(today, -120);

    const active = evaluateSuppressionRule(
      { type: 'contacted', event_date: recent, reason: null },
      90,
      today,
    );
    expect(active.status).toBe('cooldown');
    expect(active.daysRemaining).toBe(70);

    // Changing cooldown to 15 days makes the 20-day-old contact expired
    const shortened = evaluateSuppressionRule(
      { type: 'contacted', event_date: recent, reason: null },
      15,
      today,
    );
    expect(shortened.status).toBe('cooldown_expired');
    expect(shortened.daysRemaining).toBe(0);

    const expired = evaluateSuppressionRule(
      { type: 'contacted', event_date: old, reason: null },
      90,
      today,
    );
    expect(expired.status).toBe('cooldown_expired');
  });

  it('never lets contacted overwrite an existing permanent opt-out', () => {
    const db = createDatabase(':memory:');
    const supRepo = new SuppressionRepo(db);
    const today = todayIsoDate();

    supRepo.upsertRule({
      domain: 'optedoutsite.com',
      type: 'opt_out',
      eventDate: '2026-01-10',
      reason: 'Replied please remove',
    });

    const attempt = supRepo.upsertRule({
      domain: 'optedoutsite.com',
      type: 'contacted',
      eventDate: today,
      reason: 'New upload',
    });
    expect(attempt.status).toBe('protected_opt_out');

    const checked = supRepo.checkDomain('optedoutsite.com', 90);
    expect(checked.status).toBe('opted_out');
    expect(checked.type).toBe('opt_out');
  });

  it('parses paste, CSV, and XLSX uploads and applies retroactive pipeline suppression', async () => {
    const db = createDatabase(':memory:');
    const leadsRepo = new LeadsRepo(db);
    const suggestionsRepo = new SuggestionsRepo(db);
    const today = todayIsoDate();
    const tenDaysAgo = addDaysToIsoDate(today, -10);

    leadsRepo.createPending([
      { domain: 'blogone.com', discoverySource: 'test' },
      { domain: 'blogtwo.com', discoverySource: 'test' },
    ]);
    suggestionsRepo.addMany(
      [
        { domain: 'blogthree.com', sampleUrl: 'https://blogthree.com', sourceType: 'outbound_mine' },
      ],
      90,
    );

    // Raw text paste
    const rawRows = parseRawSuppressionText(
      `https://www.blogone.com/contact\t${tenDaysAgo}\nblogthree.com\t${today}`,
    );
    const preview = previewSuppressionRows(db, rawRows, 'contacted');
    expect(preview.newCount).toBe(2);

    const supRepo = new SuppressionRepo(db);
    for (const item of preview.items) {
      if (item.domain) {
        supRepo.upsertRule({
          domain: item.domain,
          type: 'contacted',
          eventDate: item.eventDate,
        });
      }
    }
    const affected = leadsRepo.applyRetroactiveSuppression(['blogone.com', 'blogthree.com'], 90);
    suggestionsRepo.dismissMatchingDomains(['blogone.com', 'blogthree.com']);
    expect(affected).toBe(1);

    const leadOne = leadsRepo.getByDomain('blogone.com', 90)!;
    expect(leadOne.verdict).toBe('disqualified');
    expect(leadOne.suppression.status).toBe('cooldown');
    expect(suggestionsRepo.list(90, 'new')).toHaveLength(0);

    // Changing cooldown to 5 days restores blogone.com
    new SettingsRepo(db).update({ contactedCooldownDays: 5 });
    reconcileLeadsWithSuppression(db);
    const restored = leadsRepo.getByDomain('blogone.com', 5)!;
    expect(restored.suppression.status).toBe('cooldown_expired');
    expect(restored.status).toBe('pending');

    // CSV parsing
    const csvRows = parseCsvSuppressionBuffer(
      Buffer.from('website,date,reason\ncsvsite.org,2026-10-01,Replied opt out\n'),
    );
    expect(csvRows).toHaveLength(1);
    expect(csvRows[0].rawDomain).toBe('csvsite.org');
    expect(csvRows[0].rawReason).toBe('Replied opt out');

    // XLSX parsing
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('OptOuts');
    ws.addRow(['domain', 'date', 'reason']);
    ws.addRow(['xlsxsite.net', '2026-11-01', 'Unsubscribed']);
    const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());
    const xlsxRows = await parseXlsxSuppressionBuffer(xlsxBuf);
    expect(xlsxRows).toHaveLength(1);
    expect(xlsxRows[0].rawDomain).toBe('xlsxsite.net');
    expect(xlsxRows[0].rawReason).toBe('Unsubscribed');
  });
});
