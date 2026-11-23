import { useEffect, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  Ban,
  Building2,
  Clock,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  ParentCompanySuppressionRule,
  SuppressionImportPreview,
  SuppressionRule,
  SuppressionType,
} from '@audiolead/shared';
import { api } from '../api/client';

interface SuppressionPageProps {
  onGoToSettings: () => void;
  onSuppressionChanged: () => void;
  onNotify: (kind: 'success' | 'error', text: string) => void;
}

export function SuppressionPage({
  onGoToSettings,
  onSuppressionChanged,
  onNotify,
}: SuppressionPageProps) {
  const [activeTab, setActiveTab] = useState<SuppressionType | 'companies'>('contacted');
  const [rules, setRules] = useState<SuppressionRule[]>([]);
  const [companyRules, setCompanyRules] = useState<ParentCompanySuppressionRule[]>([]);
  const [cooldownDays, setCooldownDays] = useState(90);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);

  // Single add
  const [singleDomain, setSingleDomain] = useState('');
  const [singleDate, setSingleDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [singleReason, setSingleReason] = useState('');

  // Parent company add
  const [companyName, setCompanyName] = useState('');
  const [companyType, setCompanyType] = useState<SuppressionType>('opt_out');
  const [companyDate, setCompanyDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [companyReason, setCompanyReason] = useState('');

  // Bulk import
  const [rawPaste, setRawPaste] = useState('');
  const [preview, setPreview] = useState<SuppressionImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  const loadRules = async () => {
    setLoading(true);
    try {
      if (activeTab === 'companies') {
        const res = await api.getParentCompanySuppressions({ q: searchQuery });
        setCompanyRules(res.rules);
        setCooldownDays(res.contactedCooldownDays);
      } else {
        const res = await api.getSuppressionRules({ type: activeTab, q: searchQuery });
        setRules(res.rules);
        setCooldownDays(res.contactedCooldownDays);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to load suppression list');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPreview(null);
    setSingleDate(new Date().toISOString().slice(0, 10));
    void loadRules();
  }, [activeTab]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadRules();
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order: Array<SuppressionType | 'companies'> = ['contacted', 'opt_out', 'companies'];
    const idx = order.indexOf(activeTab);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setActiveTab(order[(idx + 1) % order.length]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setActiveTab(order[(idx - 1 + order.length) % order.length]);
    }
  };

  const handleSingleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (activeTab === 'companies' || !singleDomain.trim()) return;
    try {
      const res = await api.addSingleSuppression({
        domain: singleDomain.trim(),
        type: activeTab,
        eventDate: singleDate,
        reason: singleReason.trim() || null,
      });
      if (res.status === 'protected_opt_out') {
        onNotify('error', `${singleDomain} is permanently Opted Out and cannot be downgraded to Contacted.`);
      } else {
        onNotify('success', `Saved ${res.rule.domain} to ${activeTab === 'opt_out' ? 'Opt-Out' : 'Already Contacted'} list`);
      }
      setSingleDomain('');
      setSingleReason('');
      await loadRules();
      onSuppressionChanged();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not add domain');
    }
  };

  const handlePreviewPaste = async (e: FormEvent) => {
    e.preventDefault();
    if (activeTab === 'companies' || !rawPaste.trim()) return;
    try {
      const res = await api.previewSuppressionText(activeTab, rawPaste);
      setPreview(res);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Preview failed');
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || activeTab === 'companies') return;
    try {
      const res = await api.previewSuppressionFile(activeTab, file);
      setPreview(res);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not parse uploaded file');
    } finally {
      e.target.value = '';
    }
  };

  const handleCommitImport = async () => {
    if (!preview) return;
    const actionable = preview.items.filter(
      (i) => i.domain && (i.action === 'new' || i.action === 'update'),
    );
    if (actionable.length === 0) {
      onNotify('error', 'No new or updated domains to import.');
      return;
    }

    setImporting(true);
    try {
      const res = await api.commitSuppression({
        type: preview.type,
        items: actionable.map((i) => ({
          domain: i.domain!,
          eventDate: i.eventDate,
          reason: i.reason,
        })),
      });
      setPreview(null);
      setRawPaste('');
      await loadRules();
      onSuppressionChanged();
      onNotify(
        'success',
        `Imported ${res.inserted} new & ${res.updated} updated rules (${res.leadsAffected} pipeline lead(s) synced)`,
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleUpdateDate = async (rule: SuppressionRule, nextDate: string) => {
    if (!nextDate || nextDate === rule.eventDate) return;
    try {
      await api.updateSuppressionRule(rule.id, { eventDate: nextDate });
      await loadRules();
      onSuppressionChanged();
      onNotify('success', `Updated date for ${rule.domain}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Update failed');
    }
  };

  const handleDelete = async (rule: SuppressionRule) => {
    try {
      await api.deleteSuppressionRule(rule.id);
      await loadRules();
      onSuppressionChanged();
      onNotify('success', `Removed ${rule.domain} from suppression list`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleAddCompany = async (e: FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) return;
    try {
      const res = await api.addParentCompanySuppression({
        companyName: companyName.trim(),
        type: companyType,
        eventDate: companyDate,
        reason: companyReason.trim() || null,
      });
      if (res.status === 'protected_opt_out') {
        onNotify('error', `${companyName} is permanently Opted Out and cannot be downgraded to Contacted.`);
      } else {
        onNotify(
          'success',
          `Saved ${res.rule.companyName} (${res.leadsAffected} pipeline lead(s) synced)`,
        );
      }
      setCompanyName('');
      setCompanyReason('');
      await loadRules();
      onSuppressionChanged();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not add parent company');
    }
  };

  const handleUpdateCompanyDate = async (rule: ParentCompanySuppressionRule, nextDate: string) => {
    if (!nextDate || nextDate === rule.eventDate) return;
    try {
      await api.updateParentCompanySuppression(rule.id, { eventDate: nextDate });
      await loadRules();
      onSuppressionChanged();
      onNotify('success', `Updated date for ${rule.companyName}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Update failed');
    }
  };

  const handleDeleteCompany = async (rule: ParentCompanySuppressionRule) => {
    try {
      await api.deleteParentCompanySuppression(rule.id);
      await loadRules();
      onSuppressionChanged();
      onNotify('success', `Removed ${rule.companyName} from parent company suppression`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Suppression &amp; Do-Not-Contact Lists</h1>
          <p className="mt-1 text-sm text-slate-600">
            Websites here are automatically blocked across Discovery, Scanning, and Exports.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-900">
          <Clock className="h-4 w-4 text-indigo-600" aria-hidden="true" />
          <span>
            Active contacted cooldown: <strong>{cooldownDays} days</strong>
          </span>
          <button
            type="button"
            onClick={onGoToSettings}
            className="text-xs font-semibold text-indigo-700 underline hover:text-indigo-900"
          >
            Change in Settings
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-5">
        <div
          role="tablist"
          aria-label="Suppression lists"
          onKeyDown={handleTabKeyDown}
          className="app-tablist"
        >
          <button
            type="button"
            role="tab"
            id="tab-contacted"
            aria-selected={activeTab === 'contacted'}
            onClick={() => setActiveTab('contacted')}
          >
            <Clock className="h-4 w-4" aria-hidden="true" />
            Already Contacted ({cooldownDays}d Cooldown)
          </button>
          <button
            type="button"
            role="tab"
            id="tab-optout"
            aria-selected={activeTab === 'opt_out'}
            onClick={() => setActiveTab('opt_out')}
          >
            <Ban className="h-4 w-4" aria-hidden="true" />
            Opted Out (Permanent DNC)
          </button>
          <button
            type="button"
            role="tab"
            id="tab-companies"
            aria-selected={activeTab === 'companies'}
            onClick={() => setActiveTab('companies')}
          >
            <Building2 className="h-4 w-4" aria-hidden="true" />
            Parent Companies
          </button>
        </div>

        <p className="text-sm text-slate-600">
          {activeTab === 'contacted'
            ? `Sites marked as contacted are disqualified until ${cooldownDays} days after their contacted date. Once the cooldown expires, they become eligible for discovery again.`
            : activeTab === 'opt_out'
              ? 'Sites that replied asking to opt out are permanently disqualified. They never expire and cannot be overwritten by future contacted imports.'
              : 'Suppress entire publisher networks or parent companies (e.g. Valnet, Static Media, Future plc). Any scanned site owned by a listed parent company is automatically suppressed.'}
        </p>

        {activeTab === 'companies' ? (
          <>
            <form
              onSubmit={handleAddCompany}
              className="grid items-end gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-12"
            >
              <div className="lg:col-span-3">
                <label htmlFor="sup-company-name" className="block text-xs font-semibold text-slate-700">
                  Parent Company Name
                </label>
                <input
                  id="sup-company-name"
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="e.g. Valnet, Static Media"
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div className="lg:col-span-2">
                <label htmlFor="sup-company-type" className="block text-xs font-semibold text-slate-700">
                  Rule Type
                </label>
                <select
                  id="sup-company-type"
                  value={companyType}
                  onChange={(e) => setCompanyType(e.target.value as SuppressionType)}
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm"
                >
                  <option value="opt_out">Opt-Out (DNC)</option>
                  <option value="contacted">Contacted ({cooldownDays}d)</option>
                </select>
              </div>
              <div className="lg:col-span-2">
                <label htmlFor="sup-company-date" className="block text-xs font-semibold text-slate-700">
                  Date
                </label>
                <input
                  id="sup-company-date"
                  type="date"
                  required
                  value={companyDate}
                  onChange={(e) => setCompanyDate(e.target.value)}
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div className="lg:col-span-3">
                <label htmlFor="sup-company-reason" className="block text-xs font-semibold text-slate-700">
                  Notes / Reason
                </label>
                <input
                  id="sup-company-reason"
                  type="text"
                  value={companyReason}
                  onChange={(e) => setCompanyReason(e.target.value)}
                  placeholder="e.g. Portfolio-wide DNC"
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div className="lg:col-span-2">
                <button
                  type="submit"
                  className="inline-flex h-[42px] w-full items-center justify-center gap-1 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add
                </button>
              </div>
            </form>

            <div className="space-y-3">
              <search className="flex flex-wrap items-center justify-between gap-3">
                <label htmlFor="sup-company-search" className="visually-hidden">
                  Search suppressed parent companies
                </label>
                <input
                  id="sup-company-search"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search parent companies..."
                  className="app-input max-w-sm flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <span className="text-xs font-medium text-slate-500">
                  {companyRules.length} parent company rule(s)
                </span>
              </search>

              {loading ? (
                <p className="py-6 text-center text-sm text-slate-500">Loading parent company rules...</p>
              ) : companyRules.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                  No parent company suppression rules yet.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2.5">Parent Company</th>
                        <th className="px-3 py-2.5">Rule Date</th>
                        <th className="px-3 py-2.5">Status</th>
                        <th className="px-3 py-2.5">Reason / Notes</th>
                        <th className="px-3 py-2.5 text-right">Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {companyRules.map((rule) => (
                        <tr key={rule.id}>
                          <td className="px-3 py-2.5 font-semibold text-slate-900 whitespace-nowrap">
                            {rule.companyName}
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="date"
                              defaultValue={rule.eventDate}
                              onBlur={(e) => handleUpdateCompanyDate(rule, e.target.value)}
                              aria-label={`Event date for ${rule.companyName}`}
                              className="app-input rounded border border-slate-300 px-2 py-1 text-xs"
                            />
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {rule.liveState === 'permanent' ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-800">
                                <Ban className="h-3 w-3 shrink-0" aria-hidden="true" />
                                Permanent DNC
                              </span>
                            ) : rule.liveState === 'active_cooldown' ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                Cooldown ({rule.daysRemaining}d left · {rule.expiresAt})
                              </span>
                            ) : (
                              <span className="inline-flex items-center whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                                Cooldown Expired (Eligible)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">
                            {rule.reason || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteCompany(rule)}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              aria-label={`Delete rule for ${rule.companyName}`}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : (
          <>

        {/* Quick Single Add */}
        <form
          onSubmit={handleSingleAdd}
          className="grid items-end gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-12"
        >
          <div className="lg:col-span-4">
            <label htmlFor="sup-single-domain" className="block text-xs font-semibold text-slate-700">
              Website / Domain
            </label>
            <input
              id="sup-single-domain"
              type="text"
              required
              value={singleDomain}
              onChange={(e) => setSingleDomain(e.target.value)}
              placeholder="e.g. site.com"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div className="lg:col-span-3">
            <label htmlFor="sup-single-date" className="block text-xs font-semibold text-slate-700">
              {activeTab === 'contacted' ? 'Contacted Date' : 'Opt-Out Date'}
            </label>
            <input
              id="sup-single-date"
              type="date"
              required
              value={singleDate}
              onChange={(e) => setSingleDate(e.target.value)}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div className="lg:col-span-3">
            <label htmlFor="sup-single-reason" className="block text-xs font-semibold text-slate-700">
              Notes / Reason
            </label>
            <input
              id="sup-single-reason"
              type="text"
              value={singleReason}
              onChange={(e) => setSingleReason(e.target.value)}
              placeholder={activeTab === 'contacted' ? 'e.g. Q4 outreach' : 'e.g. Replied stop'}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div className="lg:col-span-2">
            <button
              type="submit"
              className="inline-flex h-[42px] w-full items-center justify-center gap-1 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </button>
          </div>
        </form>

        {/* Bulk Import Panel */}
        <div className="rounded-xl border border-slate-200 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Bulk Import {activeTab === 'contacted' ? 'Already Contacted' : 'Opt-Out'} List
              </h2>
              <p className="text-xs text-slate-500">
                Paste from Google Sheets / Excel (supports columns like domain, date, reason) or upload a .csv / .xlsx file. Missing dates default to today.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Upload className="h-4 w-4" aria-hidden="true" />
              Upload CSV / XLSX
              <input
                type="file"
                accept=".csv,.xlsx,.txt"
                onChange={handleFileChange}
                className="visually-hidden"
              />
            </label>
          </div>

          <form onSubmit={handlePreviewPaste} className="space-y-3">
            <label htmlFor="sup-bulk-paste" className="visually-hidden">
              Paste domains and optional dates
            </label>
            <textarea
              id="sup-bulk-paste"
              rows={4}
              value={rawPaste}
              onChange={(e) => setRawPaste(e.target.value)}
              placeholder={
                activeTab === 'contacted'
                  ? 'domain\tdate\nexample.com\t2026-11-01\nanotherblog.org\t2026-06-15'
                  : 'domain\treason\noptoutsite.com\tReplied stop\nnoemailblog.net\tUnsubscribed'
              }
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="app-input w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!rawPaste.trim()}
                className="rounded-lg border border-indigo-300 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              >
                Preview Import
              </button>
            </div>
          </form>

          {preview && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-slate-800">
                  <strong>{preview.newCount}</strong> new ·{' '}
                  <strong>{preview.updateCount}</strong> updates ·{' '}
                  {preview.protectedOptOutCount > 0 && (
                    <span className="text-rose-700">
                      <strong>{preview.protectedOptOutCount}</strong> protected by Opt-Out ·{' '}
                    </span>
                  )}
                  <strong>{preview.skipCount}</strong> older/unchanged ·{' '}
                  <strong>{preview.invalidCount}</strong> invalid
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={importing || preview.newCount + preview.updateCount === 0}
                    onClick={handleCommitImport}
                    className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {importing
                      ? 'Saving...'
                      : `Confirm & Sync (${preview.newCount + preview.updateCount})`}
                  </button>
                </div>
              </div>

              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Domain</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Action</th>
                      <th className="px-3 py-2">Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.items.slice(0, 60).map((item, idx) => (
                      <tr key={`${item.rawInput}-${idx}`}>
                        <td className="px-3 py-1.5 font-medium text-slate-900">
                          {item.domain || item.rawInput}
                        </td>
                        <td className="px-3 py-1.5 text-slate-600">{item.eventDate}</td>
                        <td className="px-3 py-1.5">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium">
                            {item.action}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-slate-500">
                          {item.note || item.reason || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Existing Rules Search & Table */}
        <div className="space-y-3">
          <search className="flex items-center justify-between gap-3">
            <label htmlFor="sup-search" className="visually-hidden">
              Search suppression rules
            </label>
            <input
              id="sup-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search suppressed domains..."
              className="app-input max-w-sm flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <span className="text-xs font-medium text-slate-500">
              {rules.length} {activeTab === 'contacted' ? 'contacted' : 'opted-out'} record(s)
            </span>
          </search>

          {loading ? (
            <p className="py-6 text-center text-sm text-slate-500">Loading rules...</p>
          ) : rules.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
              No domains in this list yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5">Domain</th>
                    <th className="px-3 py-2.5">
                      {activeTab === 'contacted' ? 'Contacted Date' : 'Opt-Out Date'}
                    </th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Reason / Notes</th>
                    <th className="px-3 py-2.5 text-right">Remove</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td className="px-3 py-2.5 font-semibold text-slate-900 whitespace-nowrap">{rule.domain}</td>
                      <td className="px-3 py-2.5">
                        <input
                          type="date"
                          defaultValue={rule.eventDate}
                          onBlur={(e) => handleUpdateDate(rule, e.target.value)}
                          aria-label={`Event date for ${rule.domain}`}
                          className="app-input rounded border border-slate-300 px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {rule.liveState === 'permanent' ? (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-800">
                            <Ban className="h-3 w-3 shrink-0" aria-hidden="true" />
                            Permanent DNC
                          </span>
                        ) : rule.liveState === 'active_cooldown' ? (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                            Cooldown ({rule.daysRemaining}d left · {rule.expiresAt})
                          </span>
                        ) : (
                          <span className="inline-flex items-center whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                            Cooldown Expired (Eligible)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        {rule.reason || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => handleDelete(rule)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`Delete rule for ${rule.domain}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}
