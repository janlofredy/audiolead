import type {
  DiscoverySearchResult,
  DiscoverySuggestion,
  Lead,
  LeadStatus,
  LeadWithContacts,
  MaskedAppSettings,
  PipelineKpis,
  ScanJobSummary,
  ScanProgressEvent,
  SuppressionImportPreview,
  SuppressionRule,
  SuppressionType,
  UpdateSettingsPayload,
} from '@audiolead/shared';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  // Discovery
  searchNiche(payload: {
    query: string;
    intent: 'news_articles' | 'independent_blogs' | 'guides_reviews';
    language?: string;
    country?: string;
    excludeMegaPublishers?: boolean;
  }): Promise<DiscoverySearchResult> {
    return requestJson('/api/discovery/niche', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  findSimilar(payload: {
    leadId?: string;
    seedUrl?: string;
  }): Promise<DiscoverySearchResult & { seedDomain: string; derivedQuery: string }> {
    return requestJson('/api/discovery/similar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  previewSimilarwebPaste(rawText: string): Promise<DiscoverySearchResult> {
    return requestJson('/api/discovery/similarweb/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText }),
    });
  },

  queueDiscovered(payload: {
    items: Array<{
      domain: string;
      url?: string;
      title?: string | null;
      description?: string | null;
      monthlyVisits?: number | string | null;
      visitsSource?: 'manual' | 'similarweb_paste' | 'discovery';
      discoverySource?: string;
    }>;
    autoScan?: boolean;
  }): Promise<{
    addedCount: number;
    createdIds: string[];
    skippedExisting: string[];
    skippedSuppressed: Array<{ domain: string; reason: string }>;
    invalidDomains: string[];
    jobId: string | null;
  }> {
    return requestJson('/api/discovery/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  getSuggestions(): Promise<{ suggestions: DiscoverySuggestion[] }> {
    return requestJson('/api/discovery/suggestions');
  },

  actOnSuggestion(
    id: string,
    action: 'queue' | 'dismiss',
    autoScan = true,
  ): Promise<{ ok: boolean; jobId?: string | null }> {
    return requestJson(`/api/discovery/suggestions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, autoScan }),
    });
  },

  bulkQueueSuggestions(ids?: string[]): Promise<{
    addedCount: number;
    jobId: string | null;
  }> {
    return requestJson('/api/discovery/suggestions/bulk-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, autoScan: true }),
    });
  },

  // Leads & Contacts
  getLeads(params?: {
    q?: string;
    verdict?: string;
    status?: string;
    hasAds?: 'yes' | 'no' | 'all';
    hasAudio?: 'yes' | 'no' | 'all';
  }): Promise<{ leads: Lead[]; kpis: PipelineKpis }> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.verdict && params.verdict !== 'all') qs.set('verdict', params.verdict);
    if (params?.status && params.status !== 'all') qs.set('status', params.status);
    if (params?.hasAds && params.hasAds !== 'all') qs.set('hasAds', params.hasAds);
    if (params?.hasAudio && params.hasAudio !== 'all') qs.set('hasAudio', params.hasAudio);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return requestJson(`/api/leads${suffix}`);
  },

  getLead(id: string): Promise<{ lead: LeadWithContacts }> {
    return requestJson(`/api/leads/${encodeURIComponent(id)}`);
  },

  updateLead(
    id: string,
    patch: {
      monthlyVisits?: number | string | null;
      status?: LeadStatus;
      notes?: string | null;
    },
  ): Promise<{ lead: LeadWithContacts }> {
    return requestJson(`/api/leads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  deleteLead(id: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/leads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  addContact(
    leadId: string,
    payload: {
      fullName?: string | null;
      roleTitle?: string | null;
      email?: string | null;
      linkedinUrl?: string | null;
      isPrimary?: boolean;
    },
  ): Promise<{ lead: LeadWithContacts }> {
    return requestJson(`/api/leads/${encodeURIComponent(leadId)}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  updateContact(
    contactId: string,
    patch: {
      fullName?: string | null;
      roleTitle?: string | null;
      email?: string | null;
      linkedinUrl?: string | null;
      isPrimary?: boolean;
    },
  ): Promise<{ ok: boolean }> {
    return requestJson(`/api/leads/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  deleteContact(contactId: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/leads/contacts/${encodeURIComponent(contactId)}`, {
      method: 'DELETE',
    });
  },

  enrichLead(leadId: string): Promise<{
    addedCount: number;
    providersUsed: string[];
    notes: string[];
    lead: LeadWithContacts;
  }> {
    return requestJson(`/api/leads/${encodeURIComponent(leadId)}/enrich`, {
      method: 'POST',
    });
  },

  async exportTsv(verdict?: string): Promise<{
    tsv: string;
    exportedCount: number;
    excludedSuppressed: number;
  }> {
    const qs = new URLSearchParams({ format: 'tsv' });
    if (verdict && verdict !== 'all') qs.set('verdict', verdict);
    const res = await fetch(`/api/leads/export?${qs.toString()}`);
    if (!res.ok) throw new Error('Failed to export leads');
    const tsv = await res.text();
    const exportedCount = Number(res.headers.get('X-Exported-Count') || '0');
    const excludedSuppressed = Number(res.headers.get('X-Excluded-Suppressed') || '0');
    return { tsv, exportedCount, excludedSuppressed };
  },

  // Scans
  startScan(payload: {
    leadIds?: string[];
    scanPending?: boolean;
    forceRescan?: boolean;
  }): Promise<ScanJobSummary> {
    return requestJson('/api/scans/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  subscribeToScan(
    jobId: string,
    onEvent: (ev: ScanProgressEvent) => void,
    onDone?: () => void,
  ): () => void {
    const es = new EventSource(`/api/scans/${encodeURIComponent(jobId)}/events`);
    const handle = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as ScanProgressEvent;
        onEvent(parsed);
        if (parsed.type === 'job_done' || parsed.type === 'error') {
          es.close();
          onDone?.();
        }
      } catch {
        // ignore parse errors
      }
    };
    for (const evType of ['started', 'lead_progress', 'lead_done', 'job_done', 'error']) {
      es.addEventListener(evType, handle);
    }
    es.onerror = () => {
      es.close();
      onDone?.();
    };
    return () => es.close();
  },

  // Suppression
  getSuppressionRules(params?: {
    type?: SuppressionType | 'all';
    q?: string;
  }): Promise<{ rules: SuppressionRule[]; contactedCooldownDays: number }> {
    const qs = new URLSearchParams();
    if (params?.type) qs.set('type', params.type);
    if (params?.q) qs.set('q', params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return requestJson(`/api/suppression${suffix}`);
  },

  previewSuppressionText(
    type: SuppressionType,
    rawText: string,
  ): Promise<SuppressionImportPreview> {
    return requestJson('/api/suppression/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, rawText }),
    });
  },

  previewSuppressionFile(
    type: SuppressionType,
    file: File,
  ): Promise<SuppressionImportPreview> {
    const fd = new FormData();
    fd.set('type', type);
    fd.set('file', file);
    return requestJson('/api/suppression/preview', {
      method: 'POST',
      body: fd,
    });
  },

  commitSuppression(payload: {
    type: SuppressionType;
    items: Array<{ domain: string; eventDate: string; reason: string | null }>;
  }): Promise<{
    inserted: number;
    updated: number;
    protectedOptOut: number;
    skippedOlder: number;
    leadsAffected: number;
  }> {
    return requestJson('/api/suppression/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  addSingleSuppression(payload: {
    domain: string;
    type: SuppressionType;
    eventDate?: string;
    reason?: string | null;
  }): Promise<{ status: string; rule: SuppressionRule }> {
    return requestJson('/api/suppression/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  updateSuppressionRule(
    id: string,
    patch: { type?: SuppressionType; eventDate?: string; reason?: string | null },
  ): Promise<{ rule: SuppressionRule }> {
    return requestJson(`/api/suppression/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  deleteSuppressionRule(id: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/suppression/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // Settings
  getSettings(): Promise<{ settings: MaskedAppSettings }> {
    return requestJson('/api/settings');
  },

  updateSettings(patch: UpdateSettingsPayload): Promise<{ settings: MaskedAppSettings }> {
    return requestJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
};
