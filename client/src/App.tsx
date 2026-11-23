import { useCallback, useEffect, useRef, useState } from 'react';
import { Compass, Headphones, ListChecks, Settings, ShieldBan } from 'lucide-react';
import type { Lead, PipelineKpis, ScanProgressEvent } from '@audiolead/shared';
import { api } from './api/client';
import { DiscoverPage } from './pages/DiscoverPage';
import { LeadsPipelinePage } from './pages/LeadsPipelinePage';
import { SuppressionPage } from './pages/SuppressionPage';
import { SettingsPage } from './pages/SettingsPage';
import { LeadDetailDialog } from './components/LeadDetailDialog';
import { ToastBanner, type ToastMessage } from './components/ToastBanner';

type PageRoute = 'discover' | 'pipeline' | 'suppression' | 'settings';

const EMPTY_KPIS: PipelineKpis = {
  total: 0,
  pending: 0,
  qualified: 0,
  review: 0,
  contactsFound: 0,
  disqualified: 0,
  suppressed: 0,
};

export function App() {
  const [page, setPage] = useState<PageRoute>('discover');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [kpis, setKpis] = useState<PipelineKpis>(EMPTY_KPIS);
  const [suggestionsCount, setSuggestionsCount] = useState(0);

  const [activeScan, setActiveScan] = useState<ScanProgressEvent | null>(null);
  const scanUnsubRef = useRef<(() => void) | null>(null);

  const [inspectLeadId, setInspectLeadId] = useState<string | null>(null);
  const [seedLeadForSimilar, setSeedLeadForSimilar] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const notify = useCallback((kind: 'success' | 'error', text: string) => {
    const id = String(Date.now());
    setToast({ id, kind, text });
    setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 4500);
  }, []);

  const refreshPipeline = useCallback(async () => {
    try {
      const [leadsRes, sugRes] = await Promise.all([
        api.getLeads(),
        api.getSuggestions(),
      ]);
      setLeads(leadsRes.leads);
      setKpis(leadsRes.kpis);
      setSuggestionsCount(sugRes.suggestions.length);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to refresh pipeline');
    }
  }, [notify]);

  useEffect(() => {
    void refreshPipeline();
    return () => {
      scanUnsubRef.current?.();
    };
  }, [refreshPipeline]);

  const attachScanJob = useCallback(
    (jobId: string) => {
      scanUnsubRef.current?.();
      scanUnsubRef.current = api.subscribeToScan(
        jobId,
        (ev) => {
          setActiveScan(ev);
          if (ev.type === 'lead_done') {
            void refreshPipeline();
          }
          if (ev.type === 'job_done') {
            void refreshPipeline();
            notify('success', ev.message || 'Scan completed');
            setTimeout(() => setActiveScan(null), 1500);
          }
        },
        () => {
          void refreshPipeline();
        },
      );
    },
    [notify, refreshPipeline],
  );

  const handleQueuedAndScan = async (jobId: string | null, addedCount: number) => {
    await refreshPipeline();
    if (addedCount > 0) {
      setPage('pipeline');
      notify('success', `Queued ${addedCount} site(s) and started scanning`);
    } else {
      notify('error', 'No new eligible sites were queued (already in pipeline or suppressed).');
    }
    if (jobId) {
      attachScanJob(jobId);
    }
  };

  const handleStartPendingScan = async () => {
    try {
      const summary = await api.startScan({ scanPending: true });
      if (summary.total === 0) {
        notify('error', 'No pending sites to scan.');
        return;
      }
      attachScanJob(summary.jobId);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to start scan');
    }
  };

  const handleRetryFailedScan = async () => {
    try {
      const summary = await api.startScan({ retryFailed: true });
      if (summary.total === 0) {
        notify('error', 'No timed-out or rate-limited sites to retry.');
        return;
      }
      attachScanJob(summary.jobId);
      notify('success', `Retrying ${summary.total} timed-out / rate-limited site(s)...`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to retry failed scans');
    }
  };

  const handleRescanLead = async (leadId: string) => {
    try {
      const summary = await api.startScan({ leadIds: [leadId], forceRescan: true });
      attachScanJob(summary.jobId);
      notify('success', 'Rescanning site...');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Rescan failed');
    }
  };

  const navItems: Array<{
    id: PageRoute;
    label: string;
    icon: typeof Compass;
    badge?: number;
  }> = [
    { id: 'discover', label: 'Discover', icon: Compass, badge: suggestionsCount || undefined },
    { id: 'pipeline', label: 'Pipeline', icon: ListChecks, badge: kpis.qualified || undefined },
    { id: 'suppression', label: 'Suppression', icon: ShieldBan },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
              <Headphones className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <span className="block text-base font-bold tracking-tight text-slate-900">
                AudioLead
              </span>
              <span className="block text-[11px] text-slate-500">
                Publisher Discovery &amp; Contact Finder
              </span>
            </div>
          </div>

          <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const current = page === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    if (item.id !== 'discover') setSeedLeadForSimilar(null);
                    setPage(item.id);
                  }}
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
                    current
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {item.label}
                  {item.badge !== undefined && item.badge > 0 && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                        current ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {page === 'discover' && (
          <DiscoverPage
            seedLeadIdForSimilar={seedLeadForSimilar}
            leads={leads}
            suggestionsCount={suggestionsCount}
            onSuggestionsChanged={() => void refreshPipeline()}
            onQueuedAndScan={handleQueuedAndScan}
            onNotify={notify}
          />
        )}

        {page === 'pipeline' && (
          <LeadsPipelinePage
            leads={leads}
            kpis={kpis}
            activeScan={activeScan}
            onStartPendingScan={handleStartPendingScan}
            onRetryFailedScan={handleRetryFailedScan}
            onRescanLead={handleRescanLead}
            onInspectLead={(id) => setInspectLeadId(id)}
            onRefresh={refreshPipeline}
            onNotify={notify}
          />
        )}

        {page === 'suppression' && (
          <SuppressionPage
            onGoToSettings={() => setPage('settings')}
            onSuppressionChanged={() => void refreshPipeline()}
            onNotify={notify}
          />
        )}

        {page === 'settings' && (
          <SettingsPage
            onSettingsSaved={() => void refreshPipeline()}
            onNotify={notify}
          />
        )}
      </main>

      <LeadDetailDialog
        leadId={inspectLeadId}
        onClose={() => setInspectLeadId(null)}
        onLeadChanged={() => void refreshPipeline()}
        onFindSimilar={(leadId) => {
          setSeedLeadForSimilar(leadId);
          setPage('discover');
        }}
        onRescanLead={handleRescanLead}
        onNotify={notify}
      />

      <ToastBanner toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default App;
