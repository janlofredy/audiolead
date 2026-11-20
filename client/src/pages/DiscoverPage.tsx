import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  CheckSquare,
  Compass,
  ExternalLink,
  Globe,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import type {
  DiscoveryCandidate,
  DiscoverySearchResult,
  DiscoverySuggestion,
  Lead,
} from '@audiolead/shared';
import { api } from '../api/client';
import { formatVisits, similarwebLink } from '../utils/formatters';

type DiscoverTab = 'niche' | 'similar' | 'similarweb' | 'suggestions';

interface DiscoverPageProps {
  seedLeadIdForSimilar: string | null;
  leads: Lead[];
  suggestionsCount: number;
  onSuggestionsChanged: () => void;
  onQueuedAndScan: (jobId: string | null, addedCount: number) => void;
  onNotify: (kind: 'success' | 'error', text: string) => void;
}

const STATUS_BADGE: Record<
  DiscoveryCandidate['status'],
  { label: string; classes: string; selectable: boolean }
> = {
  fresh: {
    label: 'Fresh',
    classes: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    selectable: true,
  },
  cooldown_expired: {
    label: 'Cooldown Expired · Eligible',
    classes: 'bg-sky-100 text-sky-800 border-sky-200',
    selectable: true,
  },
  in_pipeline: {
    label: 'Already in Pipeline',
    classes: 'bg-slate-100 text-slate-600 border-slate-200',
    selectable: false,
  },
  cooldown: {
    label: 'Already Contacted (Cooldown)',
    classes: 'bg-rose-50 text-rose-700 border-rose-200',
    selectable: false,
  },
  opted_out: {
    label: 'Opted Out (DNC)',
    classes: 'bg-rose-100 text-rose-800 border-rose-200',
    selectable: false,
  },
};

export function DiscoverPage({
  seedLeadIdForSimilar,
  leads,
  suggestionsCount,
  onSuggestionsChanged,
  onQueuedAndScan,
  onNotify,
}: DiscoverPageProps) {
  const [activeTab, setActiveTab] = useState<DiscoverTab>('niche');

  // Quick check single URL
  const [quickUrl, setQuickUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);

  // Niche search state
  const [topicQuery, setTopicQuery] = useState('');
  const [intent, setIntent] = useState<'news_articles' | 'independent_blogs' | 'guides_reviews'>(
    'news_articles',
  );
  const [language, setLanguage] = useState('en');
  const [country, setCountry] = useState('US');
  const [excludeMega, setExcludeMega] = useState(true);
  const [nicheLoading, setNicheLoading] = useState(false);
  const [nicheResult, setNicheResult] = useState<DiscoverySearchResult | null>(null);
  const [selectedNicheDomains, setSelectedNicheDomains] = useState<Set<string>>(new Set());

  // Find Similar state
  const [similarLeadId, setSimilarLeadId] = useState('');
  const [similarSeedUrl, setSimilarSeedUrl] = useState('');
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarResult, setSimilarResult] = useState<
    (DiscoverySearchResult & { seedDomain: string; derivedQuery: string }) | null
  >(null);
  const [selectedSimilarDomains, setSelectedSimilarDomains] = useState<Set<string>>(new Set());

  // Similarweb Paste state
  const [swRawText, setSwRawText] = useState('');
  const [swLoading, setSwLoading] = useState(false);
  const [swResult, setSwResult] = useState<DiscoverySearchResult | null>(null);
  const [selectedSwDomains, setSelectedSwDomains] = useState<Set<string>>(new Set());

  // Auto-mined suggestions state
  const [suggestions, setSuggestions] = useState<DiscoverySuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const [queueing, setQueueing] = useState(false);

  const loadSuggestions = async () => {
    setSuggestionsLoading(true);
    try {
      const res = await api.getSuggestions();
      setSuggestions(res.suggestions);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to load suggestions');
    } finally {
      setSuggestionsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'suggestions') {
      void loadSuggestions();
    }
  }, [activeTab]);

  // If navigated from "Find Similar" on a pipeline lead
  useEffect(() => {
    if (seedLeadIdForSimilar) {
      setActiveTab('similar');
      setSimilarLeadId(seedLeadIdForSimilar);
      setSimilarSeedUrl('');
      void runFindSimilar({ leadId: seedLeadIdForSimilar });
    }
  }, [seedLeadIdForSimilar]);

  const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order: DiscoverTab[] = ['niche', 'similar', 'similarweb', 'suggestions'];
    const idx = order.indexOf(activeTab);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setActiveTab(order[(idx + 1) % order.length]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setActiveTab(order[(idx - 1 + order.length) % order.length]);
    }
  };

  const handleQuickCheck = async (e: FormEvent) => {
    e.preventDefault();
    if (!quickUrl.trim()) return;
    setQuickAdding(true);
    try {
      const res = await api.queueDiscovered({
        items: [{ domain: quickUrl.trim(), discoverySource: 'Quick check' }],
        autoScan: true,
      });
      if (res.skippedSuppressed.length > 0) {
        onNotify(
          'error',
          `Blocked ${res.skippedSuppressed[0].domain}: ${res.skippedSuppressed[0].reason}`,
        );
      } else if (res.skippedExisting.length > 0) {
        onNotify('error', `${res.skippedExisting[0]} is already in your pipeline.`);
      } else if (res.invalidDomains.length > 0) {
        onNotify('error', 'Please enter a valid website URL or domain.');
      } else {
        setQuickUrl('');
        onQueuedAndScan(res.jobId, res.addedCount);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not queue site');
    } finally {
      setQuickAdding(false);
    }
  };

  const handleNicheSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!topicQuery.trim()) return;
    setNicheLoading(true);
    try {
      const res = await api.searchNiche({
        query: topicQuery.trim(),
        intent,
        language,
        country,
        excludeMegaPublishers: excludeMega,
      });
      setNicheResult(res);
      setSelectedNicheDomains(
        new Set(
          res.candidates
            .filter((c) => c.status === 'fresh' || c.status === 'cooldown_expired')
            .map((c) => c.domain),
        ),
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Niche search failed');
    } finally {
      setNicheLoading(false);
    }
  };

  const runFindSimilar = async (payload: { leadId?: string; seedUrl?: string }) => {
    setSimilarLoading(true);
    try {
      const res = await api.findSimilar(payload);
      setSimilarResult(res);
      setSelectedSimilarDomains(
        new Set(
          res.candidates
            .filter((c) => c.status === 'fresh' || c.status === 'cooldown_expired')
            .map((c) => c.domain),
        ),
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Find similar failed');
    } finally {
      setSimilarLoading(false);
    }
  };

  const handleSimilarSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!similarSeedUrl.trim() && !similarLeadId) {
      onNotify('error', 'Pick a lead or enter a seed website URL.');
      return;
    }
    await runFindSimilar(
      similarSeedUrl.trim() ? { seedUrl: similarSeedUrl.trim() } : { leadId: similarLeadId },
    );
  };

  const handleSwPreview = async (e: FormEvent) => {
    e.preventDefault();
    if (!swRawText.trim()) return;
    setSwLoading(true);
    try {
      const res = await api.previewSimilarwebPaste(swRawText);
      setSwResult(res);
      setSelectedSwDomains(
        new Set(
          res.candidates
            .filter((c) => c.status === 'fresh' || c.status === 'cooldown_expired')
            .map((c) => c.domain),
        ),
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to parse Similarweb paste');
    } finally {
      setSwLoading(false);
    }
  };

  const queueCandidates = async (
    candidates: DiscoveryCandidate[],
    selectedSet: Set<string>,
    sourceLabel: string,
    visitsSource: 'discovery' | 'similarweb_paste',
  ) => {
    const picked = candidates.filter((c) => selectedSet.has(c.domain));
    if (picked.length === 0) {
      onNotify('error', 'Select at least one eligible website first.');
      return;
    }

    setQueueing(true);
    try {
      const res = await api.queueDiscovered({
        items: picked.map((c) => ({
          domain: c.domain,
          url: c.url,
          title: c.title,
          description: c.snippet,
          monthlyVisits: c.monthlyVisits,
          visitsSource,
          discoverySource: `${sourceLabel} (${c.sourceName})`,
        })),
        autoScan: true,
      });
      onQueuedAndScan(res.jobId, res.addedCount);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to queue sites');
    } finally {
      setQueueing(false);
    }
  };

  const handleSuggestionAction = async (id: string, action: 'queue' | 'dismiss') => {
    try {
      const res = await api.actOnSuggestion(id, action, true);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
      onSuggestionsChanged();
      if (action === 'queue') {
        onQueuedAndScan(res.jobId ?? null, 1);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Action failed');
    }
  };

  const handleBulkQueueSuggestions = async () => {
    setQueueing(true);
    try {
      const res = await api.bulkQueueSuggestions();
      await loadSuggestions();
      onSuggestionsChanged();
      onQueuedAndScan(res.jobId, res.addedCount);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to queue suggestions');
    } finally {
      setQueueing(false);
    }
  };

  const renderCandidateList = (
    result: DiscoverySearchResult,
    selected: Set<string>,
    setSelected: (next: Set<string>) => void,
    sourceLabel: string,
    visitsSource: 'discovery' | 'similarweb_paste',
  ) => {
    const eligible = result.candidates.filter(
      (c) => c.status === 'fresh' || c.status === 'cooldown_expired',
    );
    const toggle = (domain: string) => {
      const next = new Set(selected);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      setSelected(next);
    };

    return (
      <div className="mt-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold text-slate-900">
              Found {result.summary.totalFound} sites ·{' '}
              <span className="text-emerald-700">
                {result.summary.freshCount + result.summary.cooldownExpiredCount} eligible
              </span>
            </p>
            <p className="text-xs text-slate-600">
              Auto-filtered: {result.summary.inPipelineCount} in pipeline ·{' '}
              {result.summary.cooldownCount} on contacted cooldown ·{' '}
              {result.summary.optedOutCount} opted out
              {result.summary.usedProviders.length > 0 &&
                ` · Sources: ${result.summary.usedProviders.join(', ')}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {eligible.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    selected.size === eligible.length
                      ? new Set()
                      : new Set(eligible.map((c) => c.domain)),
                  )
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                {selected.size === eligible.length ? 'Clear All' : `Select All Eligible (${eligible.length})`}
              </button>
            )}
            <button
              type="button"
              disabled={queueing || selected.size === 0}
              onClick={() => queueCandidates(result.candidates, selected, sourceLabel, visitsSource)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              Queue Selected ({selected.size}) &amp; Scan
            </button>
          </div>
        </div>

        {result.summary.warnings.length > 0 && (
          <p className="text-xs text-amber-700">{result.summary.warnings.join(' · ')}</p>
        )}

        {result.candidates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            No matching publisher domains found. Try a broader topic or paste competitors from Similarweb.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {result.candidates.map((cand) => {
              const meta = STATUS_BADGE[cand.status];
              const checked = selected.has(cand.domain);

              return (
                <li
                  key={cand.domain}
                  className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${
                    !meta.selectable ? 'bg-slate-50/70 opacity-75' : ''
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {meta.selectable ? (
                      <button
                        type="button"
                        onClick={() => toggle(cand.domain)}
                        className="mt-0.5 text-indigo-600 hover:text-indigo-500"
                        aria-label={checked ? `Deselect ${cand.domain}` : `Select ${cand.domain}`}
                      >
                        {checked ? (
                          <CheckSquare className="h-5 w-5" aria-hidden="true" />
                        ) : (
                          <Square className="h-5 w-5 text-slate-400" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className="mt-0.5 inline-block h-5 w-5" />
                    )}

                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{cand.domain}</span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.classes}`}>
                          {meta.label}
                          {cand.status === 'cooldown' && cand.suppression.daysRemaining
                            ? ` (${cand.suppression.daysRemaining}d left)`
                            : ''}
                        </span>
                        {cand.monthlyVisits !== null && (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                            ~{formatVisits(cand.monthlyVisits)}/mo
                          </span>
                        )}
                        <span className="text-xs text-slate-400">{cand.sourceName}</span>
                      </div>

                      {cand.title && cand.title !== cand.domain && (
                        <p className="text-sm font-medium text-slate-700">{cand.title}</p>
                      )}
                      {cand.snippet && (
                        <p className="line-clamp-2 text-xs text-slate-500">{cand.snippet}</p>
                      )}
                      {cand.status === 'cooldown_expired' && cand.suppression.eventDate && (
                        <p className="text-xs text-sky-700">
                          Last contacted {cand.suppression.eventDate} — cooldown expired, eligible again
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <a
                      href={cand.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                    >
                      Site <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                    <a
                      href={similarwebLink(cand.domain, 'overview')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                    >
                      Similarweb <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header + Quick single-site check */}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Discover Publisher Websites</h1>
          <p className="mt-1 text-sm text-slate-600">
            Find ad-monetized article sites without audio readers. Already-contacted cooldowns, opt-outs, and existing pipeline sites are filtered automatically.
          </p>
        </div>

        <form onSubmit={handleQuickCheck} className="flex w-full max-w-md items-end gap-2">
          <div className="flex-1">
            <label htmlFor="quick-url" className="block text-xs font-semibold text-slate-600">
              Quick check a single website
            </label>
            <input
              id="quick-url"
              type="text"
              value={quickUrl}
              onChange={(e) => setQuickUrl(e.target.value)}
              placeholder="e.g. nerdwallet.com or https://..."
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={quickAdding || !quickUrl.trim()}
            className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Check Site
          </button>
        </form>
      </div>

      {/* Discovery sub-tabs */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div
          role="tablist"
          aria-label="Discovery methods"
          onKeyDown={handleTabKeyDown}
          className="app-tablist"
        >
          <button
            type="button"
            role="tab"
            id="tab-niche"
            aria-selected={activeTab === 'niche'}
            onClick={() => setActiveTab('niche')}
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            Niche Search
          </button>
          <button
            type="button"
            role="tab"
            id="tab-similar"
            aria-selected={activeTab === 'similar'}
            onClick={() => setActiveTab('similar')}
          >
            <Compass className="h-4 w-4" aria-hidden="true" />
            Find Similar
          </button>
          <button
            type="button"
            role="tab"
            id="tab-similarweb"
            aria-selected={activeTab === 'similarweb'}
            onClick={() => setActiveTab('similarweb')}
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            Similarweb Paste
          </button>
          <button
            type="button"
            role="tab"
            id="tab-suggestions"
            aria-selected={activeTab === 'suggestions'}
            onClick={() => setActiveTab('suggestions')}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Suggestions
            {suggestionsCount > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                {suggestionsCount}
              </span>
            )}
          </button>
        </div>

        {/* Panel 1: Niche & Topic Search */}
        <div role="tabpanel" aria-labelledby="tab-niche" hidden={activeTab !== 'niche'} className="pt-5">
          <search>
            <form onSubmit={handleNicheSearch} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-12">
                <div className="md:col-span-6">
                  <label htmlFor="niche-topic" className="block text-sm font-medium text-slate-700">
                    Topic or publisher niche
                  </label>
                  <input
                    id="niche-topic"
                    type="search"
                    required
                    value={topicQuery}
                    onChange={(e) => setTopicQuery(e.target.value)}
                    placeholder="e.g. personal finance, home gardening, EV technology, cycling"
                    className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="md:col-span-3">
                  <label htmlFor="niche-lang" className="block text-sm font-medium text-slate-700">
                    Language
                  </label>
                  <select
                    id="niche-lang"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="en">English (en)</option>
                    <option value="es">Spanish (es)</option>
                    <option value="fr">French (fr)</option>
                    <option value="de">German (de)</option>
                    <option value="pt">Portuguese (pt)</option>
                    <option value="it">Italian (it)</option>
                  </select>
                </div>
                <div className="md:col-span-3">
                  <label htmlFor="niche-country" className="block text-sm font-medium text-slate-700">
                    Country Edition
                  </label>
                  <select
                    id="niche-country"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="US">United States (US)</option>
                    <option value="GB">United Kingdom (GB)</option>
                    <option value="CA">Canada (CA)</option>
                    <option value="AU">Australia (AU)</option>
                    <option value="PH">Philippines (PH)</option>
                    <option value="SG">Singapore (SG)</option>
                    <option value="DE">Germany (DE)</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4">
                <fieldset className="flex flex-wrap items-center gap-4">
                  <legend className="visually-hidden">Publisher type focus</legend>
                  {(
                    [
                      ['news_articles', 'News & Articles'],
                      ['independent_blogs', 'Independent Blogs'],
                      ['guides_reviews', 'Guides & Reviews'],
                    ] as const
                  ).map(([val, label]) => (
                    <label key={val} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="radio"
                        name="niche-intent"
                        value={val}
                        checked={intent === val}
                        onChange={() => setIntent(val)}
                        className="accent-indigo-600"
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>

                <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={excludeMega}
                    onChange={(e) => setExcludeMega(e.target.checked)}
                    className="h-4 w-4 rounded accent-indigo-600"
                  />
                  Exclude mega-publishers (CNN, BBC, Forbes...)
                </label>

                <button
                  type="submit"
                  disabled={nicheLoading || !topicQuery.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  <Search className="h-4 w-4" aria-hidden="true" />
                  {nicheLoading ? 'Discovering Publishers...' : 'Discover Websites'}
                </button>
              </div>
            </form>
          </search>

          {nicheResult &&
            renderCandidateList(
              nicheResult,
              selectedNicheDomains,
              setSelectedNicheDomains,
              `Topic: ${topicQuery}`,
              'discovery',
            )}
        </div>

        {/* Panel 2: Find Similar */}
        <div role="tabpanel" aria-labelledby="tab-similar" hidden={activeTab !== 'similar'} className="pt-5">
          <form onSubmit={handleSimilarSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="similar-lead" className="block text-sm font-medium text-slate-700">
                  Pick a winning site from your pipeline
                </label>
                <select
                  id="similar-lead"
                  value={similarLeadId}
                  onChange={(e) => {
                    setSimilarLeadId(e.target.value);
                    if (e.target.value) setSimilarSeedUrl('');
                  }}
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">-- Choose a scanned website --</option>
                  {leads
                    .filter((l) => l.verdict === 'qualified' || l.verdict === 'review')
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.domain} {l.siteTitle ? `(${l.siteTitle})` : ''}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label htmlFor="similar-url" className="block text-sm font-medium text-slate-700">
                  Or enter any seed website URL
                </label>
                <input
                  id="similar-url"
                  type="text"
                  value={similarSeedUrl}
                  onChange={(e) => {
                    setSimilarSeedUrl(e.target.value);
                    if (e.target.value) setSimilarLeadId('');
                  }}
                  placeholder="e.g. maketecheasier.com"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              {(similarSeedUrl.trim() || similarLeadId) && (
                <a
                  href={similarwebLink(
                    similarSeedUrl.trim() ||
                      leads.find((l) => l.id === similarLeadId)?.domain ||
                      '',
                    'competitors',
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open Similarweb Competitors Tab <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
              <button
                type="submit"
                disabled={similarLoading || (!similarSeedUrl.trim() && !similarLeadId)}
                className="ml-auto inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Compass className="h-4 w-4" aria-hidden="true" />
                {similarLoading ? 'Finding Similar Publishers...' : 'Find Similar Sites'}
              </button>
            </div>
          </form>

          {similarResult && (
            <div className="mt-4">
              <p className="text-xs text-slate-500">
                Seed: <strong>{similarResult.seedDomain}</strong> · Derived topic:{' '}
                <span className="font-mono">{similarResult.derivedQuery}</span>
              </p>
              {renderCandidateList(
                similarResult,
                selectedSimilarDomains,
                setSelectedSimilarDomains,
                `Similar to ${similarResult.seedDomain}`,
                'discovery',
              )}
            </div>
          )}
        </div>

        {/* Panel 3: Similarweb Paste-In */}
        <div role="tabpanel" aria-labelledby="tab-similarweb" hidden={activeTab !== 'similarweb'} className="pt-5">
          <form onSubmit={handleSwPreview} className="space-y-3">
            <div>
              <label htmlFor="sw-paste" className="block text-sm font-medium text-slate-700">
                Paste raw text or table copied from Similarweb &ldquo;Competitors &amp; Similar Sites&rdquo;
              </label>
              <p className="mt-0.5 text-xs text-slate-500">
                Copy any section straight from Similarweb — domains and visitor counts (e.g. 420.5K, 1.2M) are extracted automatically and checked against your cooldown &amp; opt-out lists.
              </p>
              <textarea
                id="sw-paste"
                rows={6}
                value={swRawText}
                onChange={(e) => setSwRawText(e.target.value)}
                placeholder={'exampleblog.com\t340.2K\nanothernews.co.uk\t1.1M'}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="app-input mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={swLoading || !swRawText.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {swLoading ? 'Parsing...' : 'Parse & Check Suppression'}
              </button>
            </div>
          </form>

          {swResult &&
            renderCandidateList(
              swResult,
              selectedSwDomains,
              setSelectedSwDomains,
              'Similarweb Competitors',
              'similarweb_paste',
            )}
        </div>

        {/* Panel 4: Auto-Mined Suggestions */}
        <div role="tabpanel" aria-labelledby="tab-suggestions" hidden={activeTab !== 'suggestions'} className="pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Auto-Mined Publisher Suggestions
              </h2>
              <p className="text-xs text-slate-500">
                Independent websites discovered passively from outbound links inside articles you already scanned.
              </p>
            </div>
            {suggestions.length > 0 && (
              <button
                type="button"
                disabled={queueing}
                onClick={handleBulkQueueSuggestions}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Queue Top 10 &amp; Scan
              </button>
            )}
          </div>

          {suggestionsLoading ? (
            <p className="py-8 text-center text-sm text-slate-500">Loading suggestions...</p>
          ) : suggestions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
              No mined suggestions waiting yet. As you discover and scan publishers, new outbound publisher links appear here automatically.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {suggestions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900">{s.domain}</span>
                      {s.sourceDomain && (
                        <span className="text-xs text-slate-500">
                          linked from {s.sourceDomain}
                        </span>
                      )}
                      {s.suppression.status === 'cooldown_expired' && (
                        <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                          Cooldown expired
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-slate-400">{s.sampleUrl}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSuggestionAction(s.id, 'queue')}
                      className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      Queue &amp; Scan
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSuggestionAction(s.id, 'dismiss')}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                      aria-label={`Dismiss ${s.domain}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
