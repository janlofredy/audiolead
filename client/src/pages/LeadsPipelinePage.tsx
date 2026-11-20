import { useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Ban,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Megaphone,
  Play,
  RefreshCw,
  Trash2,
  UserCheck,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { Lead, LeadStatus, PipelineKpis, ScanProgressEvent } from '@audiolead/shared';
import { api } from '../api/client';
import {
  LEAD_STATUS_OPTIONS,
  formatVisits,
  similarwebLink,
  verdictMeta,
} from '../utils/formatters';

type SortKey = 'domain' | 'score' | 'visits' | 'contact' | 'status';

interface LeadsPipelinePageProps {
  leads: Lead[];
  kpis: PipelineKpis;
  activeScan: ScanProgressEvent | null;
  onStartPendingScan: () => void;
  onRescanLead: (leadId: string) => void;
  onInspectLead: (leadId: string) => void;
  onRefresh: () => Promise<void>;
  onNotify: (kind: 'success' | 'error', text: string) => void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function LeadsPipelinePage({
  leads,
  kpis,
  activeScan,
  onStartPendingScan,
  onRescanLead,
  onInspectLead,
  onRefresh,
  onNotify,
}: LeadsPipelinePageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [verdictFilter, setVerdictFilter] = useState<string>('all');
  const [adsFilter, setAdsFilter] = useState<'all' | 'yes' | 'no'>('all');
  const [audioFilter, setAudioFilter] = useState<'all' | 'yes' | 'no'>('all');

  const [sortBy, setSortBy] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<'ascending' | 'descending'>('descending');
  const [sortAnnouncement, setSortAnnouncement] = useState('');

  const [editingVisitsId, setEditingVisitsId] = useState<string | null>(null);
  const [editingVisitsValue, setEditingVisitsValue] = useState('');
  const [copiedLeadId, setCopiedLeadId] = useState<string | null>(null);

  const handleSort = (key: SortKey, label: string) => {
    const nextDir: 'ascending' | 'descending' =
      sortBy === key && sortDir === 'ascending' ? 'descending' : 'ascending';
    setSortBy(key);
    setSortDir(nextDir);
    setSortAnnouncement(`Sorted by ${label}, ${nextDir}, ${filteredLeads.length} rows`);
  };

  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = leads.filter((l) => {
      const isSuppressed =
        l.suppression.status === 'opted_out' || l.suppression.status === 'cooldown';

      if (verdictFilter !== 'all') {
        if (verdictFilter === 'suppressed' && !isSuppressed) return false;
        if (verdictFilter === 'contacts_found' && (!l.primaryContact?.email || isSuppressed)) {
          return false;
        }
        if (verdictFilter === 'disqualified' && l.verdict !== 'disqualified' && !isSuppressed) {
          return false;
        }
        if (
          (verdictFilter === 'qualified' || verdictFilter === 'review') &&
          (l.verdict !== verdictFilter || isSuppressed)
        ) {
          return false;
        }
      }

      if (adsFilter === 'yes' && l.hasAds !== true) return false;
      if (adsFilter === 'no' && l.hasAds !== false) return false;
      if (audioFilter === 'yes' && l.hasAudioPlayer !== true) return false;
      if (audioFilter === 'no' && l.hasAudioPlayer !== false) return false;

      if (q) {
        const hay = [
          l.domain,
          l.siteTitle,
          l.qualificationSummary,
          l.primaryContact?.fullName,
          l.primaryContact?.email,
          l.primaryContact?.roleTitle,
          ...l.adNetworksDetected,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });

    const factor = sortDir === 'ascending' ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'domain':
          return factor * collator.compare(a.domain, b.domain);
        case 'score':
          return factor * (a.qualificationScore - b.qualificationScore);
        case 'visits':
          return factor * ((a.monthlyVisits ?? -1) - (b.monthlyVisits ?? -1));
        case 'contact':
          return (
            factor *
            collator.compare(
              a.primaryContact?.email || a.primaryContact?.fullName || '',
              b.primaryContact?.email || b.primaryContact?.fullName || '',
            )
          );
        case 'status':
          return factor * collator.compare(a.status, b.status);
      }
    });
  }, [leads, searchQuery, verdictFilter, adsFilter, audioFilter, sortBy, sortDir]);

  const handleSaveInlineVisits = async (lead: Lead) => {
    setEditingVisitsId(null);
    const trimmed = editingVisitsValue.trim();
    const currentStr = lead.monthlyVisits !== null ? String(lead.monthlyVisits) : '';
    if (trimmed === currentStr) return;
    try {
      await api.updateLead(lead.id, { monthlyVisits: trimmed === '' ? null : trimmed });
      await onRefresh();
      onNotify('success', `Updated monthly visits for ${lead.domain}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not update visits');
    }
  };

  const handleStatusChange = async (lead: Lead, nextStatus: LeadStatus) => {
    try {
      await api.updateLead(lead.id, { status: nextStatus });
      await onRefresh();
      if (nextStatus === 'contacted') {
        onNotify('success', `${lead.domain} marked Contacted — cooldown started`);
      } else if (nextStatus === 'opted_out') {
        onNotify('success', `${lead.domain} added permanently to Opt-Out list`);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Status update failed');
    }
  };

  const handleDeleteLead = async (lead: Lead) => {
    try {
      await api.deleteLead(lead.id);
      await onRefresh();
      onNotify('success', `Removed ${lead.domain}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleCopySheets = async () => {
    try {
      const { tsv, exportedCount, excludedSuppressed } = await api.exportTsv(verdictFilter);
      await navigator.clipboard.writeText(tsv);
      const extra =
        excludedSuppressed > 0
          ? ` (excluded ${excludedSuppressed} opted-out / cooldown site(s))`
          : '';
      onNotify('success', `Copied ${exportedCount} lead(s) for Google Sheets${extra}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Copy failed');
    }
  };

  const handleCopyEmail = async (leadId: string, email: string) => {
    await navigator.clipboard.writeText(email);
    setCopiedLeadId(leadId);
    setTimeout(() => setCopiedLeadId(null), 1500);
  };

  const exportCsvUrl = `/api/leads/export?format=csv${verdictFilter !== 'all' ? `&verdict=${encodeURIComponent(verdictFilter)}` : ''}`;

  const kpiCards = [
    { key: 'all', label: 'All Sites', count: kpis.total, accent: 'border-slate-200 bg-white' },
    { key: 'qualified', label: 'Qualified', count: kpis.qualified, accent: 'border-emerald-200 bg-emerald-50/60' },
    { key: 'review', label: 'Needs Review', count: kpis.review, accent: 'border-amber-200 bg-amber-50/60' },
    { key: 'contacts_found', label: 'Contacts Found', count: kpis.contactsFound, accent: 'border-indigo-200 bg-indigo-50/60' },
    { key: 'disqualified', label: 'Disqualified', count: kpis.disqualified, accent: 'border-rose-200 bg-rose-50/50' },
  ];

  return (
    <div className="space-y-5">
      {/* KPI Filter Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {kpiCards.map((card) => {
          const active = verdictFilter === card.key;
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => setVerdictFilter(card.key)}
              aria-pressed={active}
              className={`flex flex-col justify-between rounded-xl border p-3.5 text-left transition ${card.accent} ${
                active ? 'ring-2 ring-indigo-600' : 'hover:border-slate-300'
              }`}
            >
              <span className="block text-xs font-medium text-slate-600">{card.label}</span>
              <span className="mt-1 block text-2xl font-bold text-slate-900">{card.count}</span>
            </button>
          );
        })}
      </div>

      {/* Live Scan Progress Banner */}
      {activeScan && activeScan.type !== 'job_done' && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">
              Scanning {activeScan.currentDomain || 'sites'}... ({activeScan.completed}/
              {activeScan.total}) {activeScan.stage ? `· ${activeScan.stage}` : ''}
            </span>
            <span className="text-xs font-semibold">
              {activeScan.total > 0
                ? `${Math.round((activeScan.completed / activeScan.total) * 100)}%`
                : ''}
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-indigo-200">
            <div
              className="h-full bg-indigo-600 transition-all duration-300"
              style={{
                width: `${activeScan.total > 0 ? (activeScan.completed / activeScan.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Search & Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <search className="flex flex-1 flex-wrap items-center gap-2.5">
          <label htmlFor="pipeline-search" className="visually-hidden">
            Filter websites and contacts
          </label>
          <input
            id="pipeline-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by domain, ad network, contact name or email..."
            className="app-input min-w-[230px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />

          <label htmlFor="filter-ads" className="visually-hidden">
            Filter by ads
          </label>
          <select
            id="filter-ads"
            value={adsFilter}
            onChange={(e) => setAdsFilter(e.target.value as 'all' | 'yes' | 'no')}
            className="app-input rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm"
          >
            <option value="all">Ads: Any</option>
            <option value="yes">Has Ads</option>
            <option value="no">No Ads</option>
          </select>

          <label htmlFor="filter-audio" className="visually-hidden">
            Filter by existing audio player
          </label>
          <select
            id="filter-audio"
            value={audioFilter}
            onChange={(e) => setAudioFilter(e.target.value as 'all' | 'yes' | 'no')}
            className="app-input rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm"
          >
            <option value="all">Audio Player: Any</option>
            <option value="no">No Audio Player (Target)</option>
            <option value="yes">Has Audio Player</option>
          </select>
        </search>

        <div className="flex flex-wrap items-center gap-2">
          {kpis.pending > 0 && (
            <button
              type="button"
              onClick={onStartPendingScan}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              Scan Pending ({kpis.pending})
            </button>
          )}
          <button
            type="button"
            onClick={handleCopySheets}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copy for Sheets
          </button>
          <a
            href={exportCsvUrl}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Export CSV
          </a>
        </div>
      </div>

      {/* Single screen-reader announcement for sort */}
      <div role="status" className="visually-hidden">
        {sortAnnouncement}
      </div>

      {/* Responsive Sortable Table */}
      <div
        tabIndex={0}
        role="region"
        aria-labelledby="leads-table-caption"
        className="table-wrapper"
      >
        <table className="leads-table">
          <caption id="leads-table-caption" className="visually-hidden">
            Discovered publisher leads pipeline ({filteredLeads.length} sites)
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                data-type="text"
                aria-sort={sortBy === 'domain' ? sortDir : undefined}
              >
                <button type="button" onClick={() => handleSort('domain', 'Website')}>
                  Website
                  <ArrowUpDown className="sort-indicator h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </th>
              <th
                scope="col"
                data-type="number"
                aria-sort={sortBy === 'score' ? sortDir : undefined}
              >
                <button type="button" onClick={() => handleSort('score', 'Verdict')}>
                  Verdict
                  <ArrowUpDown className="sort-indicator h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </th>
              <th scope="col">Qualification Checks</th>
              <th
                scope="col"
                data-type="number"
                aria-sort={sortBy === 'visits' ? sortDir : undefined}
              >
                <button type="button" onClick={() => handleSort('visits', 'Monthly Visits')}>
                  Monthly Visits
                  <ArrowUpDown className="sort-indicator h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </th>
              <th
                scope="col"
                data-type="text"
                aria-sort={sortBy === 'contact' ? sortDir : undefined}
              >
                <button type="button" onClick={() => handleSort('contact', 'Decision Maker')}>
                  Best Decision Maker
                  <ArrowUpDown className="sort-indicator h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </th>
              <th
                scope="col"
                data-type="text"
                aria-sort={sortBy === 'status' ? sortDir : undefined}
              >
                <button type="button" onClick={() => handleSort('status', 'Status')}>
                  Status
                  <ArrowUpDown className="sort-indicator h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>

          <tbody>
            {filteredLeads.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-sm text-slate-500">
                  No websites match this filter yet. Use the <strong>Discover</strong> tab to search a topic or paste competitors from Similarweb.
                </td>
              </tr>
            ) : (
              filteredLeads.map((lead) => {
                const vMeta = verdictMeta(lead.verdict, lead.suppression);
                const isEditing = editingVisitsId === lead.id;

                return (
                  <tr key={lead.id}>
                    <th scope="row">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onInspectLead(lead.id)}
                            className="font-semibold text-slate-900 hover:text-indigo-600 text-left"
                          >
                            {lead.domain}
                          </button>
                          <a
                            href={lead.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-400 hover:text-slate-700"
                            aria-label={`Open ${lead.domain}`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        </div>
                        {lead.siteTitle && (
                          <p className="max-w-[200px] truncate text-xs text-slate-500">
                            {lead.siteTitle}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <a
                            href={similarwebLink(lead.domain, 'overview')}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo-600 hover:underline"
                          >
                            Similarweb
                          </a>
                          <span className="text-slate-300">·</span>
                          <span className="max-w-[130px] truncate text-slate-400">
                            {lead.discoverySource}
                          </span>
                        </div>
                      </div>
                    </th>

                    <td data-value={lead.qualificationScore}>
                      <div className="space-y-1">
                        <span
                          className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${vMeta.classes}`}
                        >
                          {vMeta.label} · {lead.qualificationScore}
                        </span>
                        {lead.suppression.status === 'cooldown_expired' && (
                          <p className="text-[11px] font-medium text-sky-700">
                            Contacted {lead.suppression.eventDate} (expired)
                          </p>
                        )}
                        {lead.qualificationSummary && (
                          <p className="max-w-[210px] text-xs text-slate-500 line-clamp-2">
                            {lead.qualificationSummary}
                          </p>
                        )}
                      </div>
                    </td>

                    <td>
                      <div className="flex max-w-[240px] flex-wrap gap-1.5 text-xs">
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${
                            lead.hasArticles === true
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : lead.hasArticles === false
                                ? 'border-rose-200 bg-rose-50 text-rose-700'
                                : 'border-slate-200 bg-slate-50 text-slate-500'
                          }`}
                        >
                          <FileText className="h-3 w-3" aria-hidden="true" />
                          {lead.hasArticles === null
                            ? 'Articles ?'
                            : lead.hasArticles
                              ? `${lead.articleCountFound} Articles`
                              : 'No Articles'}
                        </span>

                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${
                            lead.hasAds === true
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : lead.hasAds === false
                                ? 'border-rose-200 bg-rose-50 text-rose-700'
                                : 'border-slate-200 bg-slate-50 text-slate-500'
                          }`}
                          title={lead.adNetworksDetected.join(', ')}
                        >
                          <Megaphone className="h-3 w-3" aria-hidden="true" />
                          {lead.hasAds === null
                            ? 'Ads ?'
                            : lead.hasAds
                              ? `Ads (${lead.adNetworksDetected.length || (lead.hasAdsTxt ? 'ads.txt' : 'Active')})`
                              : 'No Ads'}
                        </span>

                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${
                            lead.hasAudioPlayer === false
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : lead.hasAudioPlayer === true
                                ? 'border-rose-200 bg-rose-50 text-rose-700'
                                : 'border-slate-200 bg-slate-50 text-slate-500'
                          }`}
                        >
                          {lead.hasAudioPlayer ? (
                            <Volume2 className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <VolumeX className="h-3 w-3" aria-hidden="true" />
                          )}
                          {lead.hasAudioPlayer === null
                            ? 'Audio ?'
                            : lead.hasAudioPlayer
                              ? lead.audioProvidersDetected[0] || 'Has Audio'
                              : 'No Audio'}
                        </span>

                        {lead.detectedLanguage && (
                          <span className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-medium text-slate-700">
                            {lead.detectedLanguage.toUpperCase()}
                            {lead.detectedCountry ? `/${lead.detectedCountry}` : ''}
                          </span>
                        )}
                      </div>
                    </td>

                    <td data-value={lead.monthlyVisits ?? -1}>
                      {isEditing ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingVisitsValue}
                          onChange={(e) => setEditingVisitsValue(e.target.value)}
                          onBlur={() => handleSaveInlineVisits(lead)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveInlineVisits(lead);
                            if (e.key === 'Escape') setEditingVisitsId(null);
                          }}
                          placeholder="e.g. 120K"
                          aria-label={`Monthly visits for ${lead.domain}`}
                          className="app-input w-24 rounded border border-indigo-400 px-2 py-1 text-xs"
                        />
                      ) : (
                        <div className="space-y-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingVisitsId(lead.id);
                              setEditingVisitsValue(
                                lead.monthlyVisits !== null ? String(lead.monthlyVisits) : '',
                              );
                            }}
                            className="rounded border border-dashed border-slate-300 px-2 py-1 text-xs font-semibold text-slate-800 hover:border-indigo-400 hover:text-indigo-700"
                            title="Click to enter monthly visits from Similarweb"
                          >
                            {formatVisits(lead.monthlyVisits)}
                          </button>
                          {lead.trancoRank && (
                            <p className="text-[11px] text-slate-400">
                              Tranco #{lead.trancoRank.toLocaleString()}
                            </p>
                          )}
                        </div>
                      )}
                    </td>

                    <td>
                      {lead.primaryContact ? (
                        <div className="max-w-[230px] space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-semibold text-slate-900">
                              {lead.primaryContact.fullName ||
                                (lead.primaryContact.isGenericEmail
                                  ? 'Generic Fallback'
                                  : 'Contact')}
                            </span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                              T{lead.primaryContact.authorityTier}
                            </span>
                          </div>
                          {lead.primaryContact.roleTitle && (
                            <p className="truncate text-[11px] text-slate-500">
                              {lead.primaryContact.roleTitle}
                            </p>
                          )}
                          {lead.primaryContact.email && (
                            <div className="flex items-center gap-1">
                              <span className="truncate font-mono text-xs text-indigo-700">
                                {lead.primaryContact.email}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyEmail(lead.id, lead.primaryContact!.email!)
                                }
                                className="rounded p-0.5 text-slate-400 hover:text-slate-700"
                                aria-label={`Copy ${lead.primaryContact.email}`}
                              >
                                {copiedLeadId === lead.id ? (
                                  <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">None found yet</span>
                      )}
                    </td>

                    <td>
                      <select
                        value={lead.status}
                        aria-label={`Lead status for ${lead.domain}`}
                        onChange={(e) => handleStatusChange(lead, e.target.value as LeadStatus)}
                        className="app-input rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-800"
                      >
                        {LEAD_STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onInspectLead(lead.id)}
                          className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                          title="Inspect details & contacts"
                          aria-label={`Inspect ${lead.domain}`}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRescanLead(lead.id)}
                          className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                          title="Rescan website"
                          aria-label={`Rescan ${lead.domain}`}
                        >
                          <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStatusChange(lead, 'contacted')}
                          className="rounded-lg border border-slate-200 p-1.5 text-indigo-600 hover:bg-indigo-50"
                          title="Mark Contacted (starts cooldown)"
                          aria-label={`Mark ${lead.domain} contacted`}
                        >
                          <UserCheck className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStatusChange(lead, 'opted_out')}
                          className="rounded-lg border border-slate-200 p-1.5 text-rose-600 hover:bg-rose-50"
                          title="Mark Opt-Out (permanent DNC)"
                          aria-label={`Mark ${lead.domain} opted out`}
                        >
                          <Ban className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteLead(lead)}
                          className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Delete from pipeline"
                          aria-label={`Delete ${lead.domain}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
