export type LlmProvider = 'none' | 'openai' | 'gemini';

export interface AppSettings {
  minMonthlyVisits: number;
  targetLanguages: string[];
  targetCountries: string[];
  requireArticles: boolean;
  requireAds: boolean;
  requireNoAudioPlayer: boolean;
  minArticleCount: number;
  maxDaysSinceLastArticle: number;
  contactedCooldownDays: number;
  excludeMegaPublishers: boolean;
  hunterApiKey: string;
  apolloApiKey: string;
  serperApiKey: string;
  braveApiKey: string;
  openPageRankApiKey: string;
  cloudflareRadarApiToken: string;
  googleCruxApiKey: string;
  llmProvider: LlmProvider;
  llmApiKey: string;
  llmModel: string;
}

export interface MaskedAppSettings {
  minMonthlyVisits: number;
  targetLanguages: string[];
  targetCountries: string[];
  requireArticles: boolean;
  requireAds: boolean;
  requireNoAudioPlayer: boolean;
  minArticleCount: number;
  maxDaysSinceLastArticle: number;
  contactedCooldownDays: number;
  excludeMegaPublishers: boolean;
  hunterApiKeySet: boolean;
  hunterApiKeyPreview: string;
  apolloApiKeySet: boolean;
  apolloApiKeyPreview: string;
  serperApiKeySet: boolean;
  serperApiKeyPreview: string;
  braveApiKeySet: boolean;
  braveApiKeyPreview: string;
  openPageRankApiKeySet: boolean;
  openPageRankApiKeyPreview: string;
  cloudflareRadarApiTokenSet: boolean;
  cloudflareRadarApiTokenPreview: string;
  googleCruxApiKeySet: boolean;
  googleCruxApiKeyPreview: string;
  llmProvider: LlmProvider;
  llmApiKeySet: boolean;
  llmApiKeyPreview: string;
  llmModel: string;
}

export interface UpdateSettingsPayload {
  minMonthlyVisits?: number;
  targetLanguages?: string[];
  targetCountries?: string[];
  requireArticles?: boolean;
  requireAds?: boolean;
  requireNoAudioPlayer?: boolean;
  minArticleCount?: number;
  maxDaysSinceLastArticle?: number;
  contactedCooldownDays?: number;
  excludeMegaPublishers?: boolean;
  hunterApiKey?: string;
  apolloApiKey?: string;
  serperApiKey?: string;
  braveApiKey?: string;
  openPageRankApiKey?: string;
  cloudflareRadarApiToken?: string;
  googleCruxApiKey?: string;
  llmProvider?: LlmProvider;
  llmApiKey?: string;
  llmModel?: string;
}

export type SuppressionType = 'contacted' | 'opt_out';
export type SuppressionLiveState = 'active_cooldown' | 'expired' | 'permanent';

export interface SuppressionRule {
  id: string;
  domain: string;
  type: SuppressionType;
  eventDate: string; // YYYY-MM-DD
  reason: string | null;
  source: 'import' | 'manual' | 'pipeline';
  createdAt: string;
  updatedAt: string;
  liveState: SuppressionLiveState;
  expiresAt: string | null;
  daysRemaining: number | null;
}

export interface ParentCompanySuppressionRule {
  id: string;
  companyName: string;
  normalizedName: string;
  type: SuppressionType;
  eventDate: string; // YYYY-MM-DD
  reason: string | null;
  source: 'import' | 'manual' | 'pipeline';
  createdAt: string;
  updatedAt: string;
  liveState: SuppressionLiveState;
  expiresAt: string | null;
  daysRemaining: number | null;
}

export interface SuppressionCheckResult {
  status: 'clear' | 'cooldown' | 'opted_out' | 'cooldown_expired';
  type: SuppressionType | null;
  eventDate: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  reason: string | null;
  matchedParentCompany?: string | null;
}

export interface SuppressionPreviewItem {
  rawInput: string;
  domain: string | null;
  eventDate: string;
  reason: string | null;
  action: 'new' | 'update' | 'skip_same_or_older' | 'protected_opt_out' | 'invalid';
  note: string | null;
}

export interface SuppressionImportPreview {
  type: SuppressionType;
  totalRows: number;
  newCount: number;
  updateCount: number;
  protectedOptOutCount: number;
  skipCount: number;
  invalidCount: number;
  items: SuppressionPreviewItem[];
}

export type LeadStatus =
  | 'pending'
  | 'scanning'
  | 'qualified'
  | 'review'
  | 'disqualified'
  | 'contact_found'
  | 'contacted'
  | 'opted_out'
  | 'exported';

export type QualificationVerdict = 'pending' | 'qualified' | 'review' | 'disqualified' | 'error';

export type AuthorityTier = 1 | 2 | 3 | 4;

export interface Contact {
  id: string;
  leadId: string;
  fullName: string | null;
  roleTitle: string | null;
  authorityTier: AuthorityTier;
  authorityScore: number;
  email: string | null;
  isGenericEmail: boolean;
  mxValid: boolean | null;
  linkedinUrl: string | null;
  sourceUrl: string | null;
  sourceType: 'crawled' | 'hunter' | 'apollo' | 'llm' | 'manual';
  isPrimary: boolean;
  createdAt: string;
}

export interface Lead {
  id: string;
  domain: string;
  url: string;
  siteTitle: string | null;
  description: string | null;
  parentCompany: string | null;
  discoverySource: string;
  status: LeadStatus;
  verdict: QualificationVerdict;
  qualificationScore: number;
  qualificationSummary: string | null;

  monthlyVisits: number | null;
  visitsSource:
    | 'manual'
    | 'similarweb_paste'
    | 'discovery'
    | 'tranco_estimate'
    | 'openpagerank_estimate'
    | 'cloudflare_radar_estimate'
    | 'crux_estimate'
    | null;
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
  notes: string | null;
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;

  suppression: SuppressionCheckResult;
  primaryContact: Contact | null;
  contactCount: number;
}

export interface LeadWithContacts extends Lead {
  contacts: Contact[];
}

export interface PipelineKpis {
  total: number;
  pending: number;
  qualified: number;
  review: number;
  contactsFound: number;
  disqualified: number;
  suppressed: number;
}

export type DiscoveryCandidateStatus =
  | 'fresh'
  | 'in_pipeline'
  | 'cooldown'
  | 'opted_out'
  | 'cooldown_expired';

export interface DiscoveryCandidate {
  domain: string;
  url: string;
  title: string | null;
  snippet: string | null;
  monthlyVisits: number | null;
  sourceName: string;
  status: DiscoveryCandidateStatus;
  suppression: SuppressionCheckResult;
}

export interface DiscoverySearchSummary {
  totalFound: number;
  freshCount: number;
  inPipelineCount: number;
  cooldownCount: number;
  optedOutCount: number;
  cooldownExpiredCount: number;
  usedProviders: string[];
  warnings: string[];
}

export interface DiscoverySearchResult {
  candidates: DiscoveryCandidate[];
  summary: DiscoverySearchSummary;
}

export interface DiscoverySuggestion {
  id: string;
  domain: string;
  sampleUrl: string;
  title: string | null;
  snippet: string | null;
  estimatedVisits: number | null;
  sourceType: 'outbound_mine' | 'find_similar' | 'niche_search';
  sourceLeadId: string | null;
  sourceDomain: string | null;
  sourceQuery: string | null;
  status: 'new' | 'queued' | 'dismissed';
  createdAt: string;
  suppression: SuppressionCheckResult;
}

export interface ScanProgressEvent {
  jobId: string;
  type: 'started' | 'lead_progress' | 'lead_done' | 'job_done' | 'error';
  total: number;
  completed: number;
  currentDomain?: string;
  stage?: string;
  lead?: Lead;
  message?: string;
}

export interface ScanJobSummary {
  jobId: string;
  total: number;
  completed: number;
  done: boolean;
}
