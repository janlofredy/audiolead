import { nanoid } from 'nanoid';
import type {
  AppSettings,
  AuthorityTier,
  Contact,
  DiscoverySuggestion,
  Lead,
  LeadStatus,
  LeadWithContacts,
  LlmProvider,
  MaskedAppSettings,
  ParentCompanySuppressionRule,
  PipelineKpis,
  QualificationVerdict,
  SuppressionCheckResult,
  SuppressionRule,
  SuppressionType,
  UpdateSettingsPayload,
} from '@audiolead/shared';
import type { AppDatabase } from './index.js';
import {
  addDaysToIsoDate,
  daysBetweenIsoDates,
  todayIsoDate,
} from '../services/scanner/domainUtils.js';
import {
  doesCompanyMatchRule,
  normalizeCompanyName,
} from '../services/scanner/parentCompanyDetector.js';

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function maskSecret(secret: string): { set: boolean; preview: string } {
  if (!secret) return { set: false, preview: '' };
  if (secret.length <= 4) return { set: true, preview: '••••' };
  return { set: true, preview: `••••${secret.slice(-4)}` };
}

function isMaskedSentinel(value: string | undefined): boolean {
  return value !== undefined && value.startsWith('••••');
}

export function evaluateSuppressionRule(
  rule: { type: SuppressionType; event_date: string; reason: string | null } | undefined,
  cooldownDays: number,
  today = todayIsoDate(),
): SuppressionCheckResult {
  if (!rule) {
    return {
      status: 'clear',
      type: null,
      eventDate: null,
      expiresAt: null,
      daysRemaining: null,
      reason: null,
    };
  }

  if (rule.type === 'opt_out') {
    return {
      status: 'opted_out',
      type: 'opt_out',
      eventDate: rule.event_date,
      expiresAt: null,
      daysRemaining: null,
      reason: rule.reason,
    };
  }

  const expiresAt = addDaysToIsoDate(rule.event_date, Math.max(0, cooldownDays));
  const daysRemaining = daysBetweenIsoDates(today, expiresAt);
  if (daysRemaining > 0) {
    return {
      status: 'cooldown',
      type: 'contacted',
      eventDate: rule.event_date,
      expiresAt,
      daysRemaining,
      reason: rule.reason,
    };
  }

  return {
    status: 'cooldown_expired',
    type: 'contacted',
    eventDate: rule.event_date,
    expiresAt,
    daysRemaining: 0,
    reason: rule.reason,
  };
}

interface RawSettingsRow {
  min_monthly_visits: number;
  target_languages_json: string;
  target_countries_json: string;
  require_articles: number;
  require_ads: number;
  require_no_audio_player: number;
  min_article_count: number;
  max_days_since_last_article: number;
  contacted_cooldown_days: number;
  exclude_mega_publishers: number;
  hunter_api_key: string;
  apollo_api_key: string;
  serper_api_key: string;
  brave_api_key: string;
  open_pagerank_api_key: string;
  cloudflare_radar_api_token: string;
  google_crux_api_key: string;
  llm_provider: string;
  llm_api_key: string;
  llm_model: string;
}

export class SettingsRepo {
  constructor(private db: AppDatabase) {}

  get(): AppSettings {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as RawSettingsRow;
    return {
      minMonthlyVisits: row.min_monthly_visits,
      targetLanguages: safeJsonParse<string[]>(row.target_languages_json, ['en']),
      targetCountries: safeJsonParse<string[]>(row.target_countries_json, []),
      requireArticles: Boolean(row.require_articles),
      requireAds: Boolean(row.require_ads),
      requireNoAudioPlayer: Boolean(row.require_no_audio_player),
      minArticleCount: row.min_article_count,
      maxDaysSinceLastArticle: row.max_days_since_last_article,
      contactedCooldownDays: row.contacted_cooldown_days,
      excludeMegaPublishers: Boolean(row.exclude_mega_publishers),
      hunterApiKey: row.hunter_api_key,
      apolloApiKey: row.apollo_api_key,
      serperApiKey: row.serper_api_key,
      braveApiKey: row.brave_api_key,
      openPageRankApiKey: row.open_pagerank_api_key ?? '',
      cloudflareRadarApiToken: row.cloudflare_radar_api_token ?? '',
      googleCruxApiKey: row.google_crux_api_key ?? '',
      llmProvider: (row.llm_provider || 'none') as LlmProvider,
      llmApiKey: row.llm_api_key,
      llmModel: row.llm_model,
    };
  }

  getMasked(): MaskedAppSettings {
    const s = this.get();
    const hunter = maskSecret(s.hunterApiKey);
    const apollo = maskSecret(s.apolloApiKey);
    const serper = maskSecret(s.serperApiKey);
    const brave = maskSecret(s.braveApiKey);
    const openPageRank = maskSecret(s.openPageRankApiKey);
    const cloudflareRadar = maskSecret(s.cloudflareRadarApiToken);
    const googleCrux = maskSecret(s.googleCruxApiKey);
    const llm = maskSecret(s.llmApiKey);

    return {
      minMonthlyVisits: s.minMonthlyVisits,
      targetLanguages: s.targetLanguages,
      targetCountries: s.targetCountries,
      requireArticles: s.requireArticles,
      requireAds: s.requireAds,
      requireNoAudioPlayer: s.requireNoAudioPlayer,
      minArticleCount: s.minArticleCount,
      maxDaysSinceLastArticle: s.maxDaysSinceLastArticle,
      contactedCooldownDays: s.contactedCooldownDays,
      excludeMegaPublishers: s.excludeMegaPublishers,
      hunterApiKeySet: hunter.set,
      hunterApiKeyPreview: hunter.preview,
      apolloApiKeySet: apollo.set,
      apolloApiKeyPreview: apollo.preview,
      serperApiKeySet: serper.set,
      serperApiKeyPreview: serper.preview,
      braveApiKeySet: brave.set,
      braveApiKeyPreview: brave.preview,
      openPageRankApiKeySet: openPageRank.set,
      openPageRankApiKeyPreview: openPageRank.preview,
      cloudflareRadarApiTokenSet: cloudflareRadar.set,
      cloudflareRadarApiTokenPreview: cloudflareRadar.preview,
      googleCruxApiKeySet: googleCrux.set,
      googleCruxApiKeyPreview: googleCrux.preview,
      llmProvider: s.llmProvider,
      llmApiKeySet: llm.set,
      llmApiKeyPreview: llm.preview,
      llmModel: s.llmModel,
    };
  }

  update(patch: UpdateSettingsPayload): MaskedAppSettings {
    const current = this.get();

    const resolveKey = (incoming: string | undefined, prev: string): string => {
      if (incoming === undefined || isMaskedSentinel(incoming)) return prev;
      return incoming.trim();
    };

    const next: AppSettings = {
      minMonthlyVisits:
        patch.minMonthlyVisits !== undefined
          ? Math.max(0, Math.round(patch.minMonthlyVisits))
          : current.minMonthlyVisits,
      targetLanguages:
        patch.targetLanguages !== undefined
          ? patch.targetLanguages.map((l) => l.trim().toLowerCase()).filter(Boolean)
          : current.targetLanguages,
      targetCountries:
        patch.targetCountries !== undefined
          ? patch.targetCountries.map((c) => c.trim().toUpperCase()).filter(Boolean)
          : current.targetCountries,
      requireArticles: patch.requireArticles ?? current.requireArticles,
      requireAds: patch.requireAds ?? current.requireAds,
      requireNoAudioPlayer: patch.requireNoAudioPlayer ?? current.requireNoAudioPlayer,
      minArticleCount:
        patch.minArticleCount !== undefined
          ? Math.max(1, Math.round(patch.minArticleCount))
          : current.minArticleCount,
      maxDaysSinceLastArticle:
        patch.maxDaysSinceLastArticle !== undefined
          ? Math.max(1, Math.round(patch.maxDaysSinceLastArticle))
          : current.maxDaysSinceLastArticle,
      contactedCooldownDays:
        patch.contactedCooldownDays !== undefined
          ? Math.max(0, Math.round(patch.contactedCooldownDays))
          : current.contactedCooldownDays,
      excludeMegaPublishers: patch.excludeMegaPublishers ?? current.excludeMegaPublishers,
      hunterApiKey: resolveKey(patch.hunterApiKey, current.hunterApiKey),
      apolloApiKey: resolveKey(patch.apolloApiKey, current.apolloApiKey),
      serperApiKey: resolveKey(patch.serperApiKey, current.serperApiKey),
      braveApiKey: resolveKey(patch.braveApiKey, current.braveApiKey),
      openPageRankApiKey: resolveKey(patch.openPageRankApiKey, current.openPageRankApiKey),
      cloudflareRadarApiToken: resolveKey(
        patch.cloudflareRadarApiToken,
        current.cloudflareRadarApiToken,
      ),
      googleCruxApiKey: resolveKey(patch.googleCruxApiKey, current.googleCruxApiKey),
      llmProvider: patch.llmProvider ?? current.llmProvider,
      llmApiKey: resolveKey(patch.llmApiKey, current.llmApiKey),
      llmModel: patch.llmModel !== undefined ? patch.llmModel.trim() : current.llmModel,
    };

    this.db
      .prepare(
        `UPDATE settings SET
          min_monthly_visits = ?,
          target_languages_json = ?,
          target_countries_json = ?,
          require_articles = ?,
          require_ads = ?,
          require_no_audio_player = ?,
          min_article_count = ?,
          max_days_since_last_article = ?,
          contacted_cooldown_days = ?,
          exclude_mega_publishers = ?,
          hunter_api_key = ?,
          apollo_api_key = ?,
          serper_api_key = ?,
          brave_api_key = ?,
          open_pagerank_api_key = ?,
          cloudflare_radar_api_token = ?,
          google_crux_api_key = ?,
          llm_provider = ?,
          llm_api_key = ?,
          llm_model = ?,
          updated_at = datetime('now')
         WHERE id = 1`,
      )
      .run(
        next.minMonthlyVisits,
        JSON.stringify(next.targetLanguages),
        JSON.stringify(next.targetCountries),
        next.requireArticles ? 1 : 0,
        next.requireAds ? 1 : 0,
        next.requireNoAudioPlayer ? 1 : 0,
        next.minArticleCount,
        next.maxDaysSinceLastArticle,
        next.contactedCooldownDays,
        next.excludeMegaPublishers ? 1 : 0,
        next.hunterApiKey,
        next.apolloApiKey,
        next.serperApiKey,
        next.braveApiKey,
        next.openPageRankApiKey,
        next.cloudflareRadarApiToken,
        next.googleCruxApiKey,
        next.llmProvider,
        next.llmApiKey,
        next.llmModel,
      );

    return this.getMasked();
  }
}

interface RawSuppressionRow {
  id: string;
  domain: string;
  type: SuppressionType;
  event_date: string;
  reason: string | null;
  source: 'import' | 'manual' | 'pipeline';
  created_at: string;
  updated_at: string;
}

export interface RawParentCompanySuppressionRow {
  id: string;
  company_name: string;
  normalized_name: string;
  type: SuppressionType;
  event_date: string;
  reason: string | null;
  source: 'import' | 'manual' | 'pipeline';
  created_at: string;
  updated_at: string;
}

const SUPPRESSION_PRIORITY: Record<SuppressionCheckResult['status'], number> = {
  clear: 0,
  cooldown_expired: 1,
  cooldown: 2,
  opted_out: 3,
};

export function evaluateDomainAndCompany(
  domainRow: { type: SuppressionType; event_date: string; reason: string | null } | undefined,
  parentCompany: string | null | undefined,
  companyRows: RawParentCompanySuppressionRow[],
  cooldownDays: number,
  today = todayIsoDate(),
): SuppressionCheckResult {
  let best = evaluateSuppressionRule(domainRow, cooldownDays, today);
  if (!parentCompany || companyRows.length === 0) {
    return best;
  }

  for (const companyRule of companyRows) {
    if (!doesCompanyMatchRule(parentCompany, companyRule.normalized_name)) {
      continue;
    }
    const candidate = evaluateSuppressionRule(companyRule, cooldownDays, today);
    if (SUPPRESSION_PRIORITY[candidate.status] > SUPPRESSION_PRIORITY[best.status]) {
      best = {
        ...candidate,
        matchedParentCompany: companyRule.company_name,
        reason: candidate.reason
          ? `${candidate.reason} (Parent company: ${companyRule.company_name})`
          : `Parent company: ${companyRule.company_name}`,
      };
    }
  }

  return best;
}

export class SuppressionRepo {
  constructor(private db: AppDatabase) {}

  private toRule(row: RawSuppressionRow, cooldownDays: number, today = todayIsoDate()): SuppressionRule {
    const evaluated = evaluateSuppressionRule(row, cooldownDays, today);
    let liveState: SuppressionRule['liveState'] = 'permanent';
    if (row.type === 'contacted') {
      liveState = evaluated.status === 'cooldown' ? 'active_cooldown' : 'expired';
    }
    return {
      id: row.id,
      domain: row.domain,
      type: row.type,
      eventDate: row.event_date,
      reason: row.reason,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      liveState,
      expiresAt: evaluated.expiresAt,
      daysRemaining: evaluated.daysRemaining,
    };
  }

  list(
    cooldownDays: number,
    filters?: { type?: SuppressionType | 'all'; q?: string },
  ): SuppressionRule[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.type && filters.type !== 'all') {
      clauses.push('type = ?');
      params.push(filters.type);
    }
    if (filters?.q?.trim()) {
      clauses.push('(domain LIKE ? OR reason LIKE ?)');
      const pat = `%${filters.q.trim().toLowerCase()}%`;
      params.push(pat, pat);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM suppression_rules ${where} ORDER BY event_date DESC, updated_at DESC`)
      .all(...params) as RawSuppressionRow[];
    const today = todayIsoDate();
    return rows.map((r) => this.toRule(r, cooldownDays, today));
  }

  getById(id: string, cooldownDays: number): SuppressionRule | null {
    const row = this.db.prepare('SELECT * FROM suppression_rules WHERE id = ?').get(id) as
      | RawSuppressionRow
      | undefined;
    return row ? this.toRule(row, cooldownDays) : null;
  }

  getRawMapByDomains(domains: string[]): Map<string, RawSuppressionRow> {
    const unique = Array.from(new Set(domains.map((d) => d.toLowerCase())));
    const map = new Map<string, RawSuppressionRow>();
    if (unique.length === 0) return map;

    const chunkSize = 400;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM suppression_rules WHERE domain IN (${placeholders})`)
        .all(...chunk) as RawSuppressionRow[];
      for (const r of rows) {
        map.set(r.domain, r);
      }
    }
    return map;
  }

  checkDomain(domain: string, cooldownDays: number): SuppressionCheckResult {
    const row = this.db
      .prepare('SELECT type, event_date, reason FROM suppression_rules WHERE domain = ?')
      .get(domain.toLowerCase()) as
      | { type: SuppressionType; event_date: string; reason: string | null }
      | undefined;
    return evaluateSuppressionRule(row, cooldownDays);
  }

  upsertRule(input: {
    domain: string;
    type: SuppressionType;
    eventDate: string;
    reason?: string | null;
    source?: 'import' | 'manual' | 'pipeline';
  }): { status: 'inserted' | 'updated' | 'protected_opt_out' | 'skipped_older'; id: string } {
    const domain = input.domain.toLowerCase();
    const existing = this.db
      .prepare('SELECT * FROM suppression_rules WHERE domain = ?')
      .get(domain) as RawSuppressionRow | undefined;

    if (!existing) {
      const id = nanoid();
      this.db
        .prepare(
          `INSERT INTO suppression_rules (id, domain, type, event_date, reason, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run(
          id,
          domain,
          input.type,
          input.eventDate,
          input.reason ?? null,
          input.source ?? 'manual',
        );
      return { status: 'inserted', id };
    }

    // Opt-out permanently protects against being downgraded to contacted
    if (existing.type === 'opt_out' && input.type === 'contacted') {
      return { status: 'protected_opt_out', id: existing.id };
    }

    // For contacted -> contacted, keep the newer date
    if (existing.type === 'contacted' && input.type === 'contacted') {
      if (input.eventDate < existing.event_date) {
        return { status: 'skipped_older', id: existing.id };
      }
      if (input.eventDate === existing.event_date && !input.reason) {
        return { status: 'skipped_older', id: existing.id };
      }
    }

    const nextReason = input.reason !== undefined && input.reason !== null && input.reason !== ''
      ? input.reason
      : existing.reason;

    this.db
      .prepare(
        `UPDATE suppression_rules
         SET type = ?, event_date = ?, reason = ?, source = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.type,
        input.eventDate,
        nextReason,
        input.source ?? existing.source,
        existing.id,
      );

    return { status: 'updated', id: existing.id };
  }

  updateById(
    id: string,
    patch: { type?: SuppressionType; eventDate?: string; reason?: string | null },
    cooldownDays: number,
  ): SuppressionRule | null {
    const existing = this.db.prepare('SELECT * FROM suppression_rules WHERE id = ?').get(id) as
      | RawSuppressionRow
      | undefined;
    if (!existing) return null;

    this.db
      .prepare(
        `UPDATE suppression_rules
         SET type = ?, event_date = ?, reason = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        patch.type ?? existing.type,
        patch.eventDate ?? existing.event_date,
        patch.reason !== undefined ? patch.reason : existing.reason,
        id,
      );

    return this.getById(id, cooldownDays);
  }

  deleteById(id: string): { deletedDomain: string | null } {
    const existing = this.db.prepare('SELECT domain FROM suppression_rules WHERE id = ?').get(id) as
      | { domain: string }
      | undefined;
    if (!existing) return { deletedDomain: null };
    this.db.prepare('DELETE FROM suppression_rules WHERE id = ?').run(id);
    return { deletedDomain: existing.domain };
  }

  private toParentCompanyRule(
    row: RawParentCompanySuppressionRow,
    cooldownDays: number,
    today = todayIsoDate(),
  ): ParentCompanySuppressionRule {
    const evaluated = evaluateSuppressionRule(row, cooldownDays, today);
    let liveState: SuppressionRule['liveState'] = 'permanent';
    if (row.type === 'contacted') {
      liveState = evaluated.status === 'cooldown' ? 'active_cooldown' : 'expired';
    }
    return {
      id: row.id,
      companyName: row.company_name,
      normalizedName: row.normalized_name,
      type: row.type,
      eventDate: row.event_date,
      reason: row.reason,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      liveState,
      expiresAt: evaluated.expiresAt,
      daysRemaining: evaluated.daysRemaining,
    };
  }

  getAllParentCompanyRows(): RawParentCompanySuppressionRow[] {
    return this.db
      .prepare('SELECT * FROM parent_company_suppression_rules ORDER BY event_date DESC, updated_at DESC')
      .all() as RawParentCompanySuppressionRow[];
  }

  listParentCompanies(
    cooldownDays: number,
    filters?: { type?: SuppressionType | 'all'; q?: string },
  ): ParentCompanySuppressionRule[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.type && filters.type !== 'all') {
      clauses.push('type = ?');
      params.push(filters.type);
    }
    if (filters?.q?.trim()) {
      clauses.push('(LOWER(company_name) LIKE ? OR normalized_name LIKE ? OR LOWER(COALESCE(reason, \'\')) LIKE ?)');
      const pat = `%${filters.q.trim().toLowerCase()}%`;
      params.push(pat, pat, pat);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM parent_company_suppression_rules ${where} ORDER BY event_date DESC, updated_at DESC`)
      .all(...params) as RawParentCompanySuppressionRow[];
    const today = todayIsoDate();
    return rows.map((r) => this.toParentCompanyRule(r, cooldownDays, today));
  }

  getParentCompanyById(id: string, cooldownDays: number): ParentCompanySuppressionRule | null {
    const row = this.db
      .prepare('SELECT * FROM parent_company_suppression_rules WHERE id = ?')
      .get(id) as RawParentCompanySuppressionRow | undefined;
    return row ? this.toParentCompanyRule(row, cooldownDays) : null;
  }

  checkDomainAndCompany(
    domain: string,
    parentCompany: string | null | undefined,
    cooldownDays: number,
  ): SuppressionCheckResult {
    const row = this.db
      .prepare('SELECT type, event_date, reason FROM suppression_rules WHERE domain = ?')
      .get(domain.toLowerCase()) as
      | { type: SuppressionType; event_date: string; reason: string | null }
      | undefined;
    const companyRows = parentCompany ? this.getAllParentCompanyRows() : [];
    return evaluateDomainAndCompany(row, parentCompany, companyRows, cooldownDays);
  }

  upsertParentCompanyRule(input: {
    companyName: string;
    type: SuppressionType;
    eventDate: string;
    reason?: string | null;
    source?: 'import' | 'manual' | 'pipeline';
  }): { status: 'inserted' | 'updated' | 'protected_opt_out' | 'skipped_older'; id: string } {
    const trimmedName = input.companyName.trim();
    const normalizedName = normalizeCompanyName(trimmedName);
    const existing = this.db
      .prepare('SELECT * FROM parent_company_suppression_rules WHERE normalized_name = ?')
      .get(normalizedName) as RawParentCompanySuppressionRow | undefined;

    if (!existing) {
      const id = nanoid();
      this.db
        .prepare(
          `INSERT INTO parent_company_suppression_rules
           (id, company_name, normalized_name, type, event_date, reason, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run(
          id,
          trimmedName,
          normalizedName,
          input.type,
          input.eventDate,
          input.reason ?? null,
          input.source ?? 'manual',
        );
      return { status: 'inserted', id };
    }

    if (existing.type === 'opt_out' && input.type === 'contacted') {
      return { status: 'protected_opt_out', id: existing.id };
    }

    if (existing.type === 'contacted' && input.type === 'contacted') {
      if (input.eventDate < existing.event_date) {
        return { status: 'skipped_older', id: existing.id };
      }
      if (input.eventDate === existing.event_date && !input.reason) {
        return { status: 'skipped_older', id: existing.id };
      }
    }

    const nextReason =
      input.reason !== undefined && input.reason !== null && input.reason !== ''
        ? input.reason
        : existing.reason;

    this.db
      .prepare(
        `UPDATE parent_company_suppression_rules
         SET company_name = ?, type = ?, event_date = ?, reason = ?, source = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        trimmedName || existing.company_name,
        input.type,
        input.eventDate,
        nextReason,
        input.source ?? existing.source,
        existing.id,
      );

    return { status: 'updated', id: existing.id };
  }

  updateParentCompanyById(
    id: string,
    patch: { type?: SuppressionType; eventDate?: string; reason?: string | null },
    cooldownDays: number,
  ): ParentCompanySuppressionRule | null {
    const existing = this.db
      .prepare('SELECT * FROM parent_company_suppression_rules WHERE id = ?')
      .get(id) as RawParentCompanySuppressionRow | undefined;
    if (!existing) return null;

    this.db
      .prepare(
        `UPDATE parent_company_suppression_rules
         SET type = ?, event_date = ?, reason = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        patch.type ?? existing.type,
        patch.eventDate ?? existing.event_date,
        patch.reason !== undefined ? patch.reason : existing.reason,
        id,
      );

    return this.getParentCompanyById(id, cooldownDays);
  }

  deleteParentCompanyById(id: string): { deletedCompany: string | null } {
    const existing = this.db
      .prepare('SELECT company_name FROM parent_company_suppression_rules WHERE id = ?')
      .get(id) as { company_name: string } | undefined;
    if (!existing) return { deletedCompany: null };
    this.db.prepare('DELETE FROM parent_company_suppression_rules WHERE id = ?').run(id);
    return { deletedCompany: existing.company_name };
  }
}

interface RawContactRow {
  id: string;
  lead_id: string;
  full_name: string | null;
  role_title: string | null;
  authority_tier: number;
  authority_score: number;
  email: string | null;
  is_generic_email: number;
  mx_valid: number | null;
  linkedin_url: string | null;
  source_url: string | null;
  source_type: Contact['sourceType'];
  is_primary: number;
  created_at: string;
}

interface RawLeadRow {
  id: string;
  domain: string;
  url: string;
  site_title: string | null;
  description: string | null;
  parent_company: string | null;
  discovery_source: string;
  status: LeadStatus;
  verdict: QualificationVerdict;
  qualification_score: number;
  qualification_summary: string | null;
  monthly_visits: number | null;
  visits_source: Lead['visitsSource'];
  tranco_rank: number | null;
  has_articles: number | null;
  article_count_found: number;
  latest_article_date: string | null;
  avg_article_words: number | null;
  sample_article_urls_json: string;
  rss_feed_url: string | null;
  sitemap_url: string | null;
  has_ads: number | null;
  has_ads_txt: number | null;
  ads_txt_entries: number;
  ad_networks_detected_json: string;
  has_audio_player: number | null;
  audio_providers_detected_json: string;
  audio_evidence: string | null;
  detected_language: string | null;
  detected_country: string | null;
  keywords_json: string;
  blocked_by_bot_protection: number;
  last_error: string | null;
  notes: string | null;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapContactRow(row: RawContactRow): Contact {
  return {
    id: row.id,
    leadId: row.lead_id,
    fullName: row.full_name,
    roleTitle: row.role_title,
    authorityTier: Math.min(4, Math.max(1, row.authority_tier)) as AuthorityTier,
    authorityScore: row.authority_score,
    email: row.email,
    isGenericEmail: Boolean(row.is_generic_email),
    mxValid: row.mx_valid === null ? null : Boolean(row.mx_valid),
    linkedinUrl: row.linkedin_url,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    isPrimary: Boolean(row.is_primary),
    createdAt: row.created_at,
  };
}

function nullableBool(val: number | null): boolean | null {
  if (val === null || val === undefined) return null;
  return Boolean(val);
}

export class ContactsRepo {
  constructor(private db: AppDatabase) {}

  listByLeadId(leadId: string): Contact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM contacts
         WHERE lead_id = ?
         ORDER BY is_primary DESC,
                  CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END ASC,
                  is_generic_email ASC,
                  authority_tier ASC, authority_score DESC, created_at ASC`,
      )
      .all(leadId) as RawContactRow[];
    return rows.map(mapContactRow);
  }

  replaceCrawledContacts(
    leadId: string,
    contacts: Array<{
      fullName: string | null;
      roleTitle: string | null;
      authorityTier: AuthorityTier;
      authorityScore: number;
      email: string | null;
      isGenericEmail: boolean;
      mxValid: boolean | null;
      linkedinUrl: string | null;
      sourceUrl: string | null;
      sourceType: Contact['sourceType'];
    }>,
  ): Contact[] {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM contacts WHERE lead_id = ? AND source_type = 'crawled'")
        .run(leadId);

      const existingRemaining = this.db
        .prepare('SELECT id, email, full_name, is_primary FROM contacts WHERE lead_id = ?')
        .all(leadId) as Array<{
        id: string;
        email: string | null;
        full_name: string | null;
        is_primary: number;
      }>;

      const existingEmails = new Set(
        existingRemaining.map((c) => c.email?.toLowerCase()).filter(Boolean),
      );
      let hasPrimary = existingRemaining.some((c) => c.is_primary === 1);

      const insertStmt = this.db.prepare(
        `INSERT INTO contacts (
          id, lead_id, full_name, role_title, authority_tier, authority_score,
          email, is_generic_email, mx_valid, linkedin_url, source_url, source_type, is_primary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      );

      contacts.forEach((c, idx) => {
        if (c.email && existingEmails.has(c.email.toLowerCase())) {
          return;
        }
        const shouldBePrimary = !hasPrimary && idx === 0;
        if (shouldBePrimary) hasPrimary = true;

        insertStmt.run(
          nanoid(),
          leadId,
          c.fullName,
          c.roleTitle,
          c.authorityTier,
          c.authorityScore,
          c.email,
          c.isGenericEmail ? 1 : 0,
          c.mxValid === null ? null : c.mxValid ? 1 : 0,
          c.linkedinUrl,
          c.sourceUrl,
          c.sourceType,
          shouldBePrimary ? 1 : 0,
        );
      });
    });

    tx();
    return this.listByLeadId(leadId);
  }

  addContact(
    leadId: string,
    input: {
      fullName?: string | null;
      roleTitle?: string | null;
      authorityTier?: AuthorityTier;
      authorityScore?: number;
      email?: string | null;
      isGenericEmail?: boolean;
      mxValid?: boolean | null;
      linkedinUrl?: string | null;
      sourceUrl?: string | null;
      sourceType?: Contact['sourceType'];
      isPrimary?: boolean;
    },
  ): Contact {
    const id = nanoid();
    const tx = this.db.transaction(() => {
      const existingCount = (
        this.db.prepare('SELECT COUNT(*) as cnt FROM contacts WHERE lead_id = ?').get(leadId) as {
          cnt: number;
        }
      ).cnt;
      const makePrimary = input.isPrimary || existingCount === 0;
      if (makePrimary) {
        this.db.prepare('UPDATE contacts SET is_primary = 0 WHERE lead_id = ?').run(leadId);
      }
      this.db
        .prepare(
          `INSERT INTO contacts (
            id, lead_id, full_name, role_title, authority_tier, authority_score,
            email, is_generic_email, mx_valid, linkedin_url, source_url, source_type, is_primary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run(
          id,
          leadId,
          input.fullName ?? null,
          input.roleTitle ?? null,
          input.authorityTier ?? 1,
          input.authorityScore ?? 85,
          input.email ? input.email.trim().toLowerCase() : null,
          input.isGenericEmail ? 1 : 0,
          input.mxValid === undefined || input.mxValid === null ? null : input.mxValid ? 1 : 0,
          input.linkedinUrl ?? null,
          input.sourceUrl ?? null,
          input.sourceType ?? 'manual',
          makePrimary ? 1 : 0,
        );
    });
    tx();
    const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as RawContactRow;
    return mapContactRow(row);
  }

  updateContact(
    contactId: string,
    patch: {
      fullName?: string | null;
      roleTitle?: string | null;
      authorityTier?: AuthorityTier;
      authorityScore?: number;
      email?: string | null;
      isGenericEmail?: boolean;
      linkedinUrl?: string | null;
      isPrimary?: boolean;
    },
  ): Contact | null {
    const existing = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as
      | RawContactRow
      | undefined;
    if (!existing) return null;

    const tx = this.db.transaction(() => {
      if (patch.isPrimary) {
        this.db
          .prepare('UPDATE contacts SET is_primary = 0 WHERE lead_id = ?')
          .run(existing.lead_id);
      }
      this.db
        .prepare(
          `UPDATE contacts SET
            full_name = ?,
            role_title = ?,
            authority_tier = ?,
            authority_score = ?,
            email = ?,
            is_generic_email = ?,
            linkedin_url = ?,
            is_primary = ?
           WHERE id = ?`,
        )
        .run(
          patch.fullName !== undefined ? patch.fullName : existing.full_name,
          patch.roleTitle !== undefined ? patch.roleTitle : existing.role_title,
          patch.authorityTier ?? existing.authority_tier,
          patch.authorityScore ?? existing.authority_score,
          patch.email !== undefined
            ? patch.email
              ? patch.email.trim().toLowerCase()
              : null
            : existing.email,
          patch.isGenericEmail !== undefined
            ? patch.isGenericEmail
              ? 1
              : 0
            : existing.is_generic_email,
          patch.linkedinUrl !== undefined ? patch.linkedinUrl : existing.linkedin_url,
          patch.isPrimary !== undefined ? (patch.isPrimary ? 1 : 0) : existing.is_primary,
          contactId,
        );
    });
    tx();

    const updated = this.db
      .prepare('SELECT * FROM contacts WHERE id = ?')
      .get(contactId) as RawContactRow;
    return mapContactRow(updated);
  }

  deleteContact(contactId: string): boolean {
    const existing = this.db
      .prepare('SELECT lead_id, is_primary FROM contacts WHERE id = ?')
      .get(contactId) as { lead_id: string; is_primary: number } | undefined;
    if (!existing) return false;

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
      if (existing.is_primary === 1) {
        const nextBest = this.db
          .prepare(
            `SELECT id FROM contacts WHERE lead_id = ?
             ORDER BY authority_tier ASC, authority_score DESC LIMIT 1`,
          )
          .get(existing.lead_id) as { id: string } | undefined;
        if (nextBest) {
          this.db.prepare('UPDATE contacts SET is_primary = 1 WHERE id = ?').run(nextBest.id);
        }
      }
    });
    tx();
    return true;
  }
}

export class LeadsRepo {
  private suppressionRepo: SuppressionRepo;
  private contactsRepo: ContactsRepo;

  constructor(private db: AppDatabase) {
    this.suppressionRepo = new SuppressionRepo(db);
    this.contactsRepo = new ContactsRepo(db);
  }

  private mapLeadRow(
    row: RawLeadRow,
    suppressionMap: Map<string, RawSuppressionRow>,
    companyRows: RawParentCompanySuppressionRow[],
    cooldownDays: number,
    today: string,
    primaryContact: Contact | null,
    contactCount: number,
  ): Lead {
    const supRow = suppressionMap.get(row.domain);
    const suppression = evaluateDomainAndCompany(
      supRow,
      row.parent_company,
      companyRows,
      cooldownDays,
      today,
    );

    return {
      id: row.id,
      domain: row.domain,
      url: row.url,
      siteTitle: row.site_title,
      description: row.description,
      parentCompany: row.parent_company ?? null,
      discoverySource: row.discovery_source,
      status: row.status,
      verdict: row.verdict,
      qualificationScore: row.qualification_score,
      qualificationSummary: row.qualification_summary,
      monthlyVisits: row.monthly_visits,
      visitsSource: row.visits_source,
      trancoRank: row.tranco_rank,
      hasArticles: nullableBool(row.has_articles),
      articleCountFound: row.article_count_found,
      latestArticleDate: row.latest_article_date,
      avgArticleWords: row.avg_article_words,
      sampleArticleUrls: safeJsonParse<string[]>(row.sample_article_urls_json, []),
      rssFeedUrl: row.rss_feed_url,
      sitemapUrl: row.sitemap_url,
      hasAds: nullableBool(row.has_ads),
      hasAdsTxt: nullableBool(row.has_ads_txt),
      adsTxtEntries: row.ads_txt_entries,
      adNetworksDetected: safeJsonParse<string[]>(row.ad_networks_detected_json, []),
      hasAudioPlayer: nullableBool(row.has_audio_player),
      audioProvidersDetected: safeJsonParse<string[]>(row.audio_providers_detected_json, []),
      audioEvidence: row.audio_evidence,
      detectedLanguage: row.detected_language,
      detectedCountry: row.detected_country,
      keywords: safeJsonParse<string[]>(row.keywords_json, []),
      blockedByBotProtection: Boolean(row.blocked_by_bot_protection),
      lastError: row.last_error,
      notes: row.notes,
      lastScannedAt: row.last_scanned_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      suppression,
      primaryContact,
      contactCount,
    };
  }

  getExistingDomains(domains: string[]): Set<string> {
    const unique = Array.from(new Set(domains.map((d) => d.toLowerCase())));
    const set = new Set<string>();
    const chunkSize = 400;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT domain FROM leads WHERE domain IN (${placeholders})`)
        .all(...chunk) as Array<{ domain: string }>;
      for (const r of rows) set.add(r.domain);
    }
    return set;
  }

  list(
    cooldownDays: number,
    filters?: {
      q?: string;
      verdict?: string;
      status?: string;
      hasAds?: 'yes' | 'no' | 'all';
      hasAudio?: 'yes' | 'no' | 'all';
      excludeSuppressed?: boolean;
    },
  ): { leads: Lead[]; kpis: PipelineKpis } {
    const allRows = this.db
      .prepare('SELECT * FROM leads ORDER BY created_at DESC')
      .all() as RawLeadRow[];

    const domains = allRows.map((r) => r.domain);
    const suppressionMap = this.suppressionRepo.getRawMapByDomains(domains);
    const companyRows = this.suppressionRepo.getAllParentCompanyRows();
    const today = todayIsoDate();

    const contactsRows = this.db
      .prepare(
        `SELECT * FROM contacts
         ORDER BY is_primary DESC,
                  CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END ASC,
                  is_generic_email ASC,
                  authority_tier ASC, authority_score DESC, created_at ASC`,
      )
      .all() as RawContactRow[];

    const primaryByLead = new Map<string, Contact>();
    const countByLead = new Map<string, number>();
    for (const cRow of contactsRows) {
      countByLead.set(cRow.lead_id, (countByLead.get(cRow.lead_id) ?? 0) + 1);
      if (!primaryByLead.has(cRow.lead_id)) {
        primaryByLead.set(cRow.lead_id, mapContactRow(cRow));
      }
    }

    const mappedAll = allRows.map((r) =>
      this.mapLeadRow(
        r,
        suppressionMap,
        companyRows,
        cooldownDays,
        today,
        primaryByLead.get(r.id) ?? null,
        countByLead.get(r.id) ?? 0,
      ),
    );

    const kpis: PipelineKpis = {
      total: mappedAll.length,
      pending: 0,
      qualified: 0,
      review: 0,
      contactsFound: 0,
      disqualified: 0,
      suppressed: 0,
    };

    for (const lead of mappedAll) {
      const isSuppressed =
        lead.suppression.status === 'opted_out' || lead.suppression.status === 'cooldown';
      if (isSuppressed) kpis.suppressed++;
      if (lead.status === 'pending' || lead.status === 'scanning') kpis.pending++;
      if (lead.verdict === 'qualified' && !isSuppressed) kpis.qualified++;
      if (lead.verdict === 'review' && !isSuppressed) kpis.review++;
      if (lead.verdict === 'disqualified' || isSuppressed) kpis.disqualified++;
      if (lead.primaryContact?.email && !isSuppressed) kpis.contactsFound++;
    }

    const q = filters?.q?.trim().toLowerCase() ?? '';
    const filtered = mappedAll.filter((lead) => {
      const isSuppressed =
        lead.suppression.status === 'opted_out' || lead.suppression.status === 'cooldown';

      if (filters?.excludeSuppressed && isSuppressed) return false;

      if (q) {
        const hay = [
          lead.domain,
          lead.siteTitle,
          lead.discoverySource,
          lead.qualificationSummary,
          lead.primaryContact?.fullName,
          lead.primaryContact?.email,
          lead.primaryContact?.roleTitle,
          ...lead.adNetworksDetected,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (filters?.verdict && filters.verdict !== 'all') {
        if (filters.verdict === 'suppressed') {
          if (!isSuppressed) return false;
        } else if (filters.verdict === 'contacts_found') {
          if (!lead.primaryContact?.email || isSuppressed) return false;
        } else if (filters.verdict === 'disqualified') {
          if (lead.verdict !== 'disqualified' && !isSuppressed) return false;
        } else {
          if (lead.verdict !== filters.verdict || isSuppressed) return false;
        }
      }

      if (filters?.status && filters.status !== 'all') {
        if (lead.status !== filters.status) return false;
      }

      if (filters?.hasAds === 'yes' && lead.hasAds !== true) return false;
      if (filters?.hasAds === 'no' && lead.hasAds !== false) return false;

      if (filters?.hasAudio === 'yes' && lead.hasAudioPlayer !== true) return false;
      if (filters?.hasAudio === 'no' && lead.hasAudioPlayer !== false) return false;

      return true;
    });

    return { leads: filtered, kpis };
  }

  getById(id: string, cooldownDays: number): LeadWithContacts | null {
    const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as
      | RawLeadRow
      | undefined;
    if (!row) return null;

    const contacts = this.contactsRepo.listByLeadId(id);
    const suppressionMap = this.suppressionRepo.getRawMapByDomains([row.domain]);
    const companyRows = row.parent_company ? this.suppressionRepo.getAllParentCompanyRows() : [];
    const lead = this.mapLeadRow(
      row,
      suppressionMap,
      companyRows,
      cooldownDays,
      todayIsoDate(),
      contacts[0] ?? null,
      contacts.length,
    );
    return { ...lead, contacts };
  }

  getByDomain(domain: string, cooldownDays: number): LeadWithContacts | null {
    const row = this.db
      .prepare('SELECT * FROM leads WHERE domain = ?')
      .get(domain.toLowerCase()) as RawLeadRow | undefined;
    if (!row) return null;
    return this.getById(row.id, cooldownDays);
  }

  createPending(
    items: Array<{
      domain: string;
      url?: string;
      monthlyVisits?: number | null;
      visitsSource?: Lead['visitsSource'];
      discoverySource?: string;
      title?: string | null;
      description?: string | null;
    }>,
  ): { createdIds: string[]; skippedExisting: string[] } {
    const createdIds: string[] = [];
    const skippedExisting: string[] = [];

    const existingStmt = this.db.prepare('SELECT id FROM leads WHERE domain = ?');
    const insertStmt = this.db.prepare(
      `INSERT INTO leads (
        id, domain, url, site_title, description, discovery_source, status, verdict,
        monthly_visits, visits_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, datetime('now'), datetime('now'))`,
    );

    const tx = this.db.transaction(() => {
      for (const item of items) {
        const domain = item.domain.toLowerCase();
        const found = existingStmt.get(domain) as { id: string } | undefined;
        if (found) {
          skippedExisting.push(domain);
          continue;
        }
        const id = nanoid();
        insertStmt.run(
          id,
          domain,
          item.url || `https://${domain}`,
          item.title ?? null,
          item.description ?? null,
          item.discoverySource || 'discovery',
          item.monthlyVisits ?? null,
          item.monthlyVisits !== null && item.monthlyVisits !== undefined
            ? item.visitsSource ?? 'discovery'
            : null,
        );
        createdIds.push(id);
      }
    });
    tx();

    return { createdIds, skippedExisting };
  }

  markStatus(id: string, status: LeadStatus): void {
    this.db
      .prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  updateScanResult(
    id: string,
    data: {
      url: string;
      siteTitle: string | null;
      description: string | null;
      parentCompany?: string | null;
      status: LeadStatus;
      verdict: QualificationVerdict;
      qualificationScore: number;
      qualificationSummary: string;
      monthlyVisits: number | null;
      visitsSource: Lead['visitsSource'];
      trancoRank: number | null;
      hasArticles: boolean | null;
      articleCountFound: number;
      latestArticleDate: string | null;
      avgArticleWords: number | null;
      sampleArticleUrls: string[];
      rssFeedUrl: string | null;
      sitemapUrl: string | null;
      hasAds: boolean | null;
      hasAdsTxt: boolean | null;
      adsTxtEntries: number;
      adNetworksDetected: string[];
      hasAudioPlayer: boolean | null;
      audioProvidersDetected: string[];
      audioEvidence: string | null;
      detectedLanguage: string | null;
      detectedCountry: string | null;
      keywords: string[];
      blockedByBotProtection: boolean;
      lastError: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE leads SET
          url = ?,
          site_title = COALESCE(?, site_title),
          description = COALESCE(?, description),
          parent_company = COALESCE(?, parent_company),
          status = ?,
          verdict = ?,
          qualification_score = ?,
          qualification_summary = ?,
          monthly_visits = ?,
          visits_source = ?,
          tranco_rank = COALESCE(?, tranco_rank),
          has_articles = ?,
          article_count_found = ?,
          latest_article_date = ?,
          avg_article_words = ?,
          sample_article_urls_json = ?,
          rss_feed_url = ?,
          sitemap_url = ?,
          has_ads = ?,
          has_ads_txt = ?,
          ads_txt_entries = ?,
          ad_networks_detected_json = ?,
          has_audio_player = ?,
          audio_providers_detected_json = ?,
          audio_evidence = ?,
          detected_language = ?,
          detected_country = ?,
          keywords_json = ?,
          blocked_by_bot_protection = ?,
          last_error = ?,
          last_scanned_at = datetime('now'),
          updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        data.url,
        data.siteTitle,
        data.description,
        data.parentCompany ?? null,
        data.status,
        data.verdict,
        data.qualificationScore,
        data.qualificationSummary,
        data.monthlyVisits,
        data.visitsSource,
        data.trancoRank,
        data.hasArticles === null ? null : data.hasArticles ? 1 : 0,
        data.articleCountFound,
        data.latestArticleDate,
        data.avgArticleWords,
        JSON.stringify(data.sampleArticleUrls),
        data.rssFeedUrl,
        data.sitemapUrl,
        data.hasAds === null ? null : data.hasAds ? 1 : 0,
        data.hasAdsTxt === null ? null : data.hasAdsTxt ? 1 : 0,
        data.adsTxtEntries,
        JSON.stringify(data.adNetworksDetected),
        data.hasAudioPlayer === null ? null : data.hasAudioPlayer ? 1 : 0,
        JSON.stringify(data.audioProvidersDetected),
        data.audioEvidence,
        data.detectedLanguage,
        data.detectedCountry,
        JSON.stringify(data.keywords),
        data.blockedByBotProtection ? 1 : 0,
        data.lastError,
        id,
      );
  }

  updateLeadFields(
    id: string,
    patch: {
      monthlyVisits?: number | null;
      visitsSource?: Lead['visitsSource'];
      parentCompany?: string | null;
      status?: LeadStatus;
      verdict?: QualificationVerdict;
      qualificationScore?: number;
      qualificationSummary?: string | null;
      notes?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.monthlyVisits !== undefined) {
      sets.push('monthly_visits = ?');
      params.push(patch.monthlyVisits);
    }
    if (patch.visitsSource !== undefined) {
      sets.push('visits_source = ?');
      params.push(patch.visitsSource);
    }
    if (patch.parentCompany !== undefined) {
      sets.push('parent_company = ?');
      params.push(patch.parentCompany);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.verdict !== undefined) {
      sets.push('verdict = ?');
      params.push(patch.verdict);
    }
    if (patch.qualificationScore !== undefined) {
      sets.push('qualification_score = ?');
      params.push(patch.qualificationScore);
    }
    if (patch.qualificationSummary !== undefined) {
      sets.push('qualification_summary = ?');
      params.push(patch.qualificationSummary);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      params.push(patch.notes);
    }

    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(id);

    this.db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  applyRetroactiveSuppression(domains: string[], cooldownDays: number): number {
    if (domains.length === 0) return 0;
    const unique = Array.from(new Set(domains.map((d) => d.toLowerCase())));
    const map = this.suppressionRepo.getRawMapByDomains(unique);
    const today = todayIsoDate();

    let updated = 0;
    const updateStmt = this.db.prepare(
      `UPDATE leads
       SET status = ?, verdict = 'disqualified', qualification_score = 0,
           qualification_summary = ?, updated_at = datetime('now')
       WHERE domain = ?`,
    );

    const tx = this.db.transaction(() => {
      for (const domain of unique) {
        const res = evaluateSuppressionRule(map.get(domain), cooldownDays, today);
        if (res.status === 'opted_out') {
          const summary = `Opted out / Do Not Contact (${res.eventDate}${res.reason ? `: ${res.reason}` : ''})`;
          const info = updateStmt.run('opted_out', summary, domain);
          updated += info.changes;
        } else if (res.status === 'cooldown') {
          const summary = `Already contacted on ${res.eventDate} (${res.daysRemaining}d cooldown remaining until ${res.expiresAt})`;
          const info = updateStmt.run('disqualified', summary, domain);
          updated += info.changes;
        }
      }
    });
    tx();
    return updated;
  }

  deleteLead(id: string): boolean {
    const info = this.db.prepare('DELETE FROM leads WHERE id = ?').run(id);
    return info.changes > 0;
  }

  getPendingLeadIds(limit = 100): string[] {
    const rows = this.db
      .prepare("SELECT id FROM leads WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
      .all(limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  resetInterruptedScans(): number {
    const info = this.db
      .prepare("UPDATE leads SET status = 'pending', updated_at = datetime('now') WHERE status = 'scanning'")
      .run();
    return info.changes;
  }

  getRetryableFailedLeadIds(limit = 250): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM leads
         WHERE verdict = 'error'
           AND blocked_by_bot_protection = 0
           AND (
             LOWER(COALESCE(last_error, '')) LIKE '%timed out%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%429%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%502%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%503%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%504%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%econnreset%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%etimedout%'
             OR LOWER(COALESCE(last_error, '')) LIKE '%fetch failed%'
           )
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}

interface RawSuggestionRow {
  id: string;
  domain: string;
  sample_url: string;
  title: string | null;
  snippet: string | null;
  estimated_visits: number | null;
  source_type: DiscoverySuggestion['sourceType'];
  source_lead_id: string | null;
  source_domain: string | null;
  source_query: string | null;
  status: DiscoverySuggestion['status'];
  created_at: string;
}

export class SuggestionsRepo {
  private suppressionRepo: SuppressionRepo;

  constructor(private db: AppDatabase) {
    this.suppressionRepo = new SuppressionRepo(db);
  }

  list(cooldownDays: number, status: DiscoverySuggestion['status'] = 'new'): DiscoverySuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM discovery_suggestions s
         LEFT JOIN leads l ON l.domain = s.domain
         WHERE s.status = ? AND l.id IS NULL
         ORDER BY COALESCE(s.estimated_visits, 0) DESC, s.created_at DESC
         LIMIT 500`,
      )
      .all(status) as RawSuggestionRow[];

    const suppressionMap = this.suppressionRepo.getRawMapByDomains(rows.map((r) => r.domain));
    const today = todayIsoDate();

    return rows
      .map((r) => {
        const sup = evaluateSuppressionRule(suppressionMap.get(r.domain), cooldownDays, today);
        return {
          id: r.id,
          domain: r.domain,
          sampleUrl: r.sample_url,
          title: r.title,
          snippet: r.snippet,
          estimatedVisits: r.estimated_visits,
          sourceType: r.source_type,
          sourceLeadId: r.source_lead_id,
          sourceDomain: r.source_domain,
          sourceQuery: r.source_query,
          status: r.status,
          createdAt: r.created_at,
          suppression: sup,
        };
      })
      .filter((s) => s.suppression.status !== 'opted_out' && s.suppression.status !== 'cooldown');
  }

  addMany(
    items: Array<{
      domain: string;
      sampleUrl: string;
      title?: string | null;
      snippet?: string | null;
      estimatedVisits?: number | null;
      sourceType: DiscoverySuggestion['sourceType'];
      sourceLeadId?: string | null;
      sourceDomain?: string | null;
      sourceQuery?: string | null;
    }>,
    cooldownDays: number,
  ): number {
    if (items.length === 0) return 0;

    const existingLeads = new LeadsRepo(this.db).getExistingDomains(items.map((i) => i.domain));
    const supMap = this.suppressionRepo.getRawMapByDomains(items.map((i) => i.domain));
    const today = todayIsoDate();

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO discovery_suggestions (
        id, domain, sample_url, title, snippet, estimated_visits,
        source_type, source_lead_id, source_domain, source_query, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'))`,
    );

    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const item of items) {
        const domain = item.domain.toLowerCase();
        if (existingLeads.has(domain)) continue;
        const sup = evaluateSuppressionRule(supMap.get(domain), cooldownDays, today);
        if (sup.status === 'opted_out' || sup.status === 'cooldown') continue;

        const info = insertStmt.run(
          nanoid(),
          domain,
          item.sampleUrl,
          item.title ?? null,
          item.snippet ?? null,
          item.estimatedVisits ?? null,
          item.sourceType,
          item.sourceLeadId ?? null,
          item.sourceDomain ?? null,
          item.sourceQuery ?? null,
        );
        inserted += info.changes;
      }
    });
    tx();
    return inserted;
  }

  getById(id: string): RawSuggestionRow | null {
    const row = this.db
      .prepare('SELECT * FROM discovery_suggestions WHERE id = ?')
      .get(id) as RawSuggestionRow | undefined;
    return row ?? null;
  }

  updateStatus(id: string, status: DiscoverySuggestion['status']): void {
    this.db.prepare('UPDATE discovery_suggestions SET status = ? WHERE id = ?').run(status, id);
  }

  dismissMatchingDomains(domains: string[]): void {
    if (domains.length === 0) return;
    const unique = Array.from(new Set(domains.map((d) => d.toLowerCase())));
    const chunkSize = 400;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      this.db
        .prepare(
          `UPDATE discovery_suggestions SET status = 'dismissed'
           WHERE domain IN (${placeholders}) AND status = 'new'`,
        )
        .run(...chunk);
    }
  }
}

export class TrancoRepo {
  constructor(private db: AppDatabase) {}

  getCached(domain: string): { found: boolean; rank: number | null } {
    const row = this.db
      .prepare(
        `SELECT rank FROM tranco_cache
         WHERE domain = ? AND datetime(fetched_at) > datetime('now', '-30 days')`,
      )
      .get(domain.toLowerCase()) as { rank: number | null } | undefined;
    if (!row) return { found: false, rank: null };
    return { found: true, rank: row.rank };
  }

  setCached(domain: string, rank: number | null): void {
    this.db
      .prepare(
        `INSERT INTO tranco_cache (domain, rank, fetched_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(domain) DO UPDATE SET rank = excluded.rank, fetched_at = datetime('now')`,
      )
      .run(domain.toLowerCase(), rank);
  }
}

export class TrafficCacheRepo {
  constructor(private db: AppDatabase) {}

  getCached(
    domain: string,
    provider: string,
  ): { found: boolean; estimatedVisits: number | null; rawRank: number | null } {
    const row = this.db
      .prepare(
        `SELECT estimated_visits, raw_rank FROM traffic_cache
         WHERE domain = ? AND provider = ? AND datetime(fetched_at) > datetime('now', '-30 days')`,
      )
      .get(domain.toLowerCase(), provider) as
      | { estimated_visits: number | null; raw_rank: number | null }
      | undefined;
    if (!row) return { found: false, estimatedVisits: null, rawRank: null };
    return {
      found: true,
      estimatedVisits: row.estimated_visits,
      rawRank: row.raw_rank,
    };
  }

  setCached(
    domain: string,
    provider: string,
    estimatedVisits: number | null,
    rawRank: number | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO traffic_cache (domain, provider, estimated_visits, raw_rank, fetched_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(domain, provider) DO UPDATE SET
           estimated_visits = excluded.estimated_visits,
           raw_rank = excluded.raw_rank,
           fetched_at = datetime('now')`,
      )
      .run(domain.toLowerCase(), provider, estimatedVisits, rawRank);
  }
}
