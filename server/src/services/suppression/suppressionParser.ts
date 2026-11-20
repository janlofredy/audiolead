import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type {
  SuppressionImportPreview,
  SuppressionPreviewItem,
  SuppressionType,
} from '@audiolead/shared';
import type { AppDatabase } from '../../db/index.js';
import { SuppressionRepo } from '../../db/repositories.js';
import {
  normalizeDomain,
  parseFlexibleDate,
  todayIsoDate,
} from '../scanner/domainUtils.js';

interface ParsedRawRow {
  rawInput: string;
  rawDomain: string;
  rawDate: unknown;
  rawReason: string | null;
}

const DOMAIN_HEADER_HINT = /^(domain|website|site|url|host|publisher|company_domain)$/i;
const DATE_HEADER_HINT = /^(date|contacted_at|contacted_date|last_contacted|opted_out_at|opt_out_date|sent_at|timestamp)$/i;
const REASON_HEADER_HINT = /^(reason|notes|note|comment|details|reply)$/i;

function rowsToParsedRaw(rows: unknown[][]): ParsedRawRow[] {
  if (rows.length === 0) return [];
  const firstRow = rows[0].map((v) => String(v ?? '').trim());

  let domainCol = firstRow.findIndex((h) => DOMAIN_HEADER_HINT.test(h));
  let dateCol = firstRow.findIndex((h) => DATE_HEADER_HINT.test(h));
  let reasonCol = firstRow.findIndex((h) => REASON_HEADER_HINT.test(h));

  const hasHeaderRow = domainCol !== -1 || dateCol !== -1 || reasonCol !== -1;
  const startIndex = hasHeaderRow ? 1 : 0;

  if (domainCol === -1) domainCol = 0;

  const out: ParsedRawRow[] = [];
  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === '')) {
      continue;
    }

    const rawDomainCell = String(row[domainCol] ?? '').trim();
    let rawDateVal: unknown = dateCol >= 0 ? row[dateCol] : undefined;
    let rawReasonVal: string | null =
      reasonCol >= 0 && row[reasonCol] !== undefined ? String(row[reasonCol]).trim() || null : null;

    // Positional fallback for headerless multi-column rows: [domain, date_or_reason, reason]
    if (!hasHeaderRow && row.length >= 2) {
      const col1 = row[1];
      const parsedAsDate = parseFlexibleDate(col1);
      if (parsedAsDate) {
        rawDateVal = col1;
        if (row.length >= 3 && row[2] !== undefined) {
          rawReasonVal = String(row[2]).trim() || null;
        }
      } else {
        rawReasonVal = col1 !== undefined ? String(col1).trim() || null : null;
        if (row.length >= 3 && parseFlexibleDate(row[2])) {
          rawDateVal = row[2];
        }
      }
    }

    out.push({
      rawInput: row.map((v) => String(v ?? '')).join(' | ').trim(),
      rawDomain: rawDomainCell,
      rawDate: rawDateVal,
      rawReason: rawReasonVal,
    });
  }

  return out;
}

export function parseRawSuppressionText(rawText: string): ParsedRawRow[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Detect tab or comma-separated table structure
  const matrix: string[][] = lines.map((line) => {
    if (line.includes('\t')) {
      return line.split('\t').map((c) => c.trim());
    }
    if (line.includes(',')) {
      const parsed = Papa.parse<string[]>(line, { header: false });
      return (parsed.data[0] ?? [line]).map((c) => String(c ?? '').trim());
    }
    // Single line: check if whitespace separates domain and date/note
    const parts = line.split(/\s{2,}|\s+(?=\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/);
    return parts.map((p) => p.trim()).filter(Boolean);
  });

  return rowsToParsedRaw(matrix);
}

export function parseCsvSuppressionBuffer(buffer: Buffer): ParsedRawRow[] {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: true,
  });
  return rowsToParsedRaw(parsed.data);
}

function extractExcelCellValue(val: ExcelJS.CellValue): unknown {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val;
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
  if (typeof val === 'object') {
    if ('text' in val && typeof val.text === 'string') return val.text;
    if ('hyperlink' in val && typeof val.hyperlink === 'string') return val.hyperlink;
    if ('result' in val && val.result !== undefined) return val.result;
  }
  return String(val);
}

export async function parseXlsxSuppressionBuffer(buffer: Buffer): Promise<ParsedRawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];

  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(extractExcelCellValue);
    rows.push(vals);
  });

  return rowsToParsedRaw(rows);
}

export function previewSuppressionRows(
  db: AppDatabase,
  rawRows: ParsedRawRow[],
  type: SuppressionType,
): SuppressionImportPreview {
  const today = todayIsoDate();
  const deduped = new Map<
    string,
    { rawInput: string; domain: string; eventDate: string; reason: string | null }
  >();
  const invalidItems: SuppressionPreviewItem[] = [];

  for (const row of rawRows) {
    const domain = normalizeDomain(row.rawDomain);
    if (!domain) {
      invalidItems.push({
        rawInput: row.rawInput || row.rawDomain,
        domain: null,
        eventDate: today,
        reason: row.rawReason,
        action: 'invalid',
        note: 'Could not extract a valid domain',
      });
      continue;
    }

    const parsedDate = parseFlexibleDate(row.rawDate) ?? today;
    const prev = deduped.get(domain);
    if (!prev) {
      deduped.set(domain, {
        rawInput: row.rawInput,
        domain,
        eventDate: parsedDate,
        reason: row.rawReason,
      });
    } else {
      // Keep the newer date within the same upload
      const useIncomingDate = parsedDate > prev.eventDate;
      deduped.set(domain, {
        rawInput: row.rawInput,
        domain,
        eventDate: useIncomingDate ? parsedDate : prev.eventDate,
        reason: row.rawReason || prev.reason,
      });
    }
  }

  const repo = new SuppressionRepo(db);
  const existingMap = repo.getRawMapByDomains(Array.from(deduped.keys()));

  const items: SuppressionPreviewItem[] = [];
  let newCount = 0;
  let updateCount = 0;
  let protectedOptOutCount = 0;
  let skipCount = 0;

  for (const entry of deduped.values()) {
    const existing = existingMap.get(entry.domain);
    if (!existing) {
      newCount++;
      items.push({
        rawInput: entry.rawInput,
        domain: entry.domain,
        eventDate: entry.eventDate,
        reason: entry.reason,
        action: 'new',
        note: null,
      });
      continue;
    }

    if (existing.type === 'opt_out' && type === 'contacted') {
      protectedOptOutCount++;
      items.push({
        rawInput: entry.rawInput,
        domain: entry.domain,
        eventDate: entry.eventDate,
        reason: entry.reason,
        action: 'protected_opt_out',
        note: `Kept permanent Opt-Out (${existing.event_date})`,
      });
      continue;
    }

    if (existing.type === 'contacted' && type === 'contacted') {
      if (entry.eventDate < existing.event_date || (entry.eventDate === existing.event_date && !entry.reason)) {
        skipCount++;
        items.push({
          rawInput: entry.rawInput,
          domain: entry.domain,
          eventDate: entry.eventDate,
          reason: entry.reason,
          action: 'skip_same_or_older',
          note: `Existing date ${existing.event_date} is newer or identical`,
        });
        continue;
      }
    }

    updateCount++;
    items.push({
      rawInput: entry.rawInput,
      domain: entry.domain,
      eventDate: entry.eventDate,
      reason: entry.reason,
      action: 'update',
      note:
        existing.type === 'contacted' && type === 'opt_out'
          ? 'Upgrading from Contacted to Permanent Opt-Out'
          : `Updating existing date (${existing.event_date} → ${entry.eventDate})`,
    });
  }

  items.push(...invalidItems);

  return {
    type,
    totalRows: rawRows.length,
    newCount,
    updateCount,
    protectedOptOutCount,
    skipCount,
    invalidCount: invalidItems.length,
    items,
  };
}
