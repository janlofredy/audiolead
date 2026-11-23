import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type AppDatabase = Database.Database;

export function createDatabase(dbPath?: string): AppDatabase {
  const targetPath =
    dbPath || process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'audiolead.db');

  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  const db = new Database(targetPath);
  if (targetPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

function runMigrations(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      min_monthly_visits INTEGER NOT NULL DEFAULT 50000,
      target_languages_json TEXT NOT NULL DEFAULT '["en"]',
      target_countries_json TEXT NOT NULL DEFAULT '[]',
      require_articles INTEGER NOT NULL DEFAULT 1,
      require_ads INTEGER NOT NULL DEFAULT 1,
      require_no_audio_player INTEGER NOT NULL DEFAULT 1,
      min_article_count INTEGER NOT NULL DEFAULT 3,
      max_days_since_last_article INTEGER NOT NULL DEFAULT 180,
      contacted_cooldown_days INTEGER NOT NULL DEFAULT 90,
      exclude_mega_publishers INTEGER NOT NULL DEFAULT 1,
      hunter_api_key TEXT NOT NULL DEFAULT '',
      apollo_api_key TEXT NOT NULL DEFAULT '',
      serper_api_key TEXT NOT NULL DEFAULT '',
      brave_api_key TEXT NOT NULL DEFAULT '',
      llm_provider TEXT NOT NULL DEFAULT 'none',
      llm_api_key TEXT NOT NULL DEFAULT '',
      llm_model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO settings (id, updated_at)
    VALUES (1, datetime('now'));

    CREATE TABLE IF NOT EXISTS suppression_rules (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('contacted', 'opt_out')),
      event_date TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_suppression_type ON suppression_rules(type);
    CREATE INDEX IF NOT EXISTS idx_suppression_domain ON suppression_rules(domain);

    CREATE TABLE IF NOT EXISTS parent_company_suppression_rules (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('contacted', 'opt_out')),
      event_date TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_parent_company_sup_norm ON parent_company_suppression_rules(normalized_name);

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      site_title TEXT,
      description TEXT,
      parent_company TEXT,
      discovery_source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending',
      verdict TEXT NOT NULL DEFAULT 'pending',
      qualification_score INTEGER NOT NULL DEFAULT 0,
      qualification_summary TEXT,

      monthly_visits INTEGER,
      visits_source TEXT,
      tranco_rank INTEGER,

      has_articles INTEGER,
      article_count_found INTEGER NOT NULL DEFAULT 0,
      latest_article_date TEXT,
      avg_article_words INTEGER,
      sample_article_urls_json TEXT NOT NULL DEFAULT '[]',
      rss_feed_url TEXT,
      sitemap_url TEXT,

      has_ads INTEGER,
      has_ads_txt INTEGER,
      ads_txt_entries INTEGER NOT NULL DEFAULT 0,
      ad_networks_detected_json TEXT NOT NULL DEFAULT '[]',

      has_audio_player INTEGER,
      audio_providers_detected_json TEXT NOT NULL DEFAULT '[]',
      audio_evidence TEXT,

      detected_language TEXT,
      detected_country TEXT,
      keywords_json TEXT NOT NULL DEFAULT '[]',

      blocked_by_bot_protection INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      notes TEXT,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_verdict ON leads(verdict);
    CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      full_name TEXT,
      role_title TEXT,
      authority_tier INTEGER NOT NULL DEFAULT 4,
      authority_score INTEGER NOT NULL DEFAULT 0,
      email TEXT,
      is_generic_email INTEGER NOT NULL DEFAULT 0,
      mx_valid INTEGER,
      linkedin_url TEXT,
      source_url TEXT,
      source_type TEXT NOT NULL DEFAULT 'crawled',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_lead_id ON contacts(lead_id);

    CREATE TABLE IF NOT EXISTS discovery_suggestions (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      sample_url TEXT NOT NULL,
      title TEXT,
      snippet TEXT,
      estimated_visits INTEGER,
      source_type TEXT NOT NULL,
      source_lead_id TEXT,
      source_domain TEXT,
      source_query TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON discovery_suggestions(status);

    CREATE TABLE IF NOT EXISTS tranco_cache (
      domain TEXT PRIMARY KEY,
      rank INTEGER,
      fetched_at TEXT NOT NULL
    );
  `);

  const leadCols = db.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string }>;
  if (!leadCols.some((c) => c.name === 'parent_company')) {
    db.exec('ALTER TABLE leads ADD COLUMN parent_company TEXT;');
  }
}
