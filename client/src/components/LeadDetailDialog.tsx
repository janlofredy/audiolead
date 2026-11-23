import { useEffect, useState, type FormEvent } from 'react';
import {
  Ban,
  Check,
  Copy,
  ExternalLink,
  MailCheck,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  UserCheck,
} from 'lucide-react';
import type { LeadWithContacts } from '@audiolead/shared';
import { api } from '../api/client';
import { NativeDialog } from './NativeDialog';
import {
  authorityTierLabel,
  formatVisits,
  similarwebLink,
  verdictMeta,
  visitsSourceLabel,
} from '../utils/formatters';

interface LeadDetailDialogProps {
  leadId: string | null;
  onClose: () => void;
  onLeadChanged: () => void;
  onFindSimilar: (leadId: string) => void;
  onRescanLead: (leadId: string) => void;
  onNotify: (kind: 'success' | 'error', text: string) => void;
}

export function LeadDetailDialog({
  leadId,
  onClose,
  onLeadChanged,
  onFindSimilar,
  onRescanLead,
  onNotify,
}: LeadDetailDialogProps) {
  const [lead, setLead] = useState<LeadWithContacts | null>(null);
  const [loading, setLoading] = useState(false);
  const [visitsInput, setVisitsInput] = useState('');
  const [parentCompanyInput, setParentCompanyInput] = useState('');
  const [notesInput, setNotesInput] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [suppressingCompany, setSuppressingCompany] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Add manual contact form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newLinkedin, setNewLinkedin] = useState('');
  const [addingContact, setAddingContact] = useState(false);

  const loadLead = async (id: string) => {
    setLoading(true);
    try {
      const res = await api.getLead(id);
      setLead(res.lead);
      setVisitsInput(res.lead.monthlyVisits !== null ? String(res.lead.monthlyVisits) : '');
      setParentCompanyInput(res.lead.parentCompany ?? '');
      setNotesInput(res.lead.notes ?? '');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to load lead');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (leadId) {
      void loadLead(leadId);
    } else {
      setLead(null);
    }
  }, [leadId]);

  const handleSaveMeta = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead) return;
    setSavingMeta(true);
    try {
      const res = await api.updateLead(lead.id, {
        monthlyVisits: visitsInput.trim() === '' ? null : visitsInput.trim(),
        parentCompany: parentCompanyInput.trim() || null,
        notes: notesInput,
      });
      setLead(res.lead);
      onLeadChanged();
      onNotify('success', `Updated ${lead.domain}`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not update lead');
    } finally {
      setSavingMeta(false);
    }
  };

  const handleSuppressParentCompany = async () => {
    if (!lead) return;
    const company = parentCompanyInput.trim() || lead.parentCompany?.trim() || '';
    if (!company) {
      onNotify('error', 'Enter or detect a Parent Company name first.');
      return;
    }

    setSuppressingCompany(true);
    try {
      if (parentCompanyInput.trim() !== (lead.parentCompany ?? '')) {
        await api.updateLead(lead.id, { parentCompany: company });
      }
      const res = await api.addParentCompanySuppression({
        companyName: company,
        type: 'opt_out',
        reason: `Suppressed from ${lead.domain}`,
      });
      await loadLead(lead.id);
      onLeadChanged();
      onNotify(
        'success',
        `Suppressed parent company "${company}" (${res.leadsAffected} lead(s) synced)`,
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not suppress parent company');
    } finally {
      setSuppressingCompany(false);
    }
  };

  const handleAddContact = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead) return;
    if (!newName.trim() && !newEmail.trim()) {
      onNotify('error', 'Enter at least a name or email');
      return;
    }
    setAddingContact(true);
    try {
      const res = await api.addContact(lead.id, {
        fullName: newName.trim() || null,
        roleTitle: newRole.trim() || null,
        email: newEmail.trim() || null,
        linkedinUrl: newLinkedin.trim() || null,
        isPrimary: lead.contacts.length === 0,
      });
      setLead(res.lead);
      setNewName('');
      setNewRole('');
      setNewEmail('');
      setNewLinkedin('');
      onLeadChanged();
      onNotify('success', 'Contact added');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to add contact');
    } finally {
      setAddingContact(false);
    }
  };

  const handleSetPrimary = async (contactId: string) => {
    if (!lead) return;
    try {
      await api.updateContact(contactId, { isPrimary: true });
      await loadLead(lead.id);
      onLeadChanged();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to update contact');
    }
  };

  const handleDeleteContact = async (contactId: string) => {
    if (!lead) return;
    try {
      await api.deleteContact(contactId);
      await loadLead(lead.id);
      onLeadChanged();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to delete contact');
    }
  };

  const handleEnrich = async () => {
    if (!lead) return;
    setEnriching(true);
    try {
      const res = await api.enrichLead(lead.id);
      setLead(res.lead);
      onLeadChanged();
      onNotify(
        'success',
        res.addedCount > 0
          ? `Added ${res.addedCount} contact(s) via ${res.providersUsed.join(', ')}`
          : `Enrichment finished (${res.providersUsed.join(', ')}) — no new emails found`,
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  };

  const handleQuickSuppression = async (status: 'contacted' | 'opted_out') => {
    if (!lead) return;
    try {
      const res = await api.updateLead(lead.id, { status });
      setLead(res.lead);
      onLeadChanged();
      onNotify(
        'success',
        status === 'opted_out'
          ? `${lead.domain} permanently added to Opt-Out list`
          : `${lead.domain} marked Contacted (cooldown started)`,
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  const copyEmail = async (id: string, email: string) => {
    await navigator.clipboard.writeText(email);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const vMeta = lead ? verdictMeta(lead.verdict, lead.suppression) : null;

  return (
    <NativeDialog
      open={Boolean(leadId)}
      onClose={onClose}
      title={lead ? lead.domain : 'Loading website...'}
      subtitle={lead?.siteTitle || lead?.url}
      footer={
        lead && (
          <>
            <button
              type="button"
              onClick={() => {
                onClose();
                onFindSimilar(lead.id);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              Find Similar Sites
            </button>
            <button
              type="button"
              onClick={() => onRescanLead(lead.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Rescan
            </button>
            <button
              type="button"
              onClick={() => handleQuickSuppression('contacted')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
            >
              <UserCheck className="h-4 w-4" aria-hidden="true" />
              Mark Contacted
            </button>
            <button
              type="button"
              onClick={() => handleQuickSuppression('opted_out')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
            >
              <Ban className="h-4 w-4" aria-hidden="true" />
              Mark Opt-Out
            </button>
          </>
        )
      }
    >
      {loading || !lead ? (
        <p className="py-8 text-center text-sm text-slate-500">Loading site details...</p>
      ) : (
        <div className="space-y-6">
          {/* Header status & external shortcuts */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {vMeta && (
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${vMeta.classes}`}>
                    {vMeta.label} · {lead.qualificationScore}/100
                  </span>
                )}
                {lead.suppression.status === 'cooldown_expired' && (
                  <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-800">
                    Previously contacted {lead.suppression.eventDate} (cooldown expired)
                  </span>
                )}
                {lead.trancoRank && (
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    Tranco #{lead.trancoRank.toLocaleString()}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-700">{lead.qualificationSummary || 'Not scanned yet.'}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <a
                href={lead.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Open Site <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
              <a
                href={similarwebLink(lead.domain, 'overview')}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Similarweb <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
              <a
                href={similarwebLink(lead.domain, 'competitors')}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Similar Sites <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>

          {/* Qualification evidence grid */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-3.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Articles &amp; Publishing
              </h3>
              <p className="mt-1 text-sm font-medium text-slate-900">
                {lead.hasArticles === null
                  ? 'Not scanned'
                  : lead.hasArticles
                    ? `Active (${lead.articleCountFound} detected${lead.avgArticleWords ? `, ~${lead.avgArticleWords} words` : ''})`
                    : 'No active article structure detected'}
              </p>
              {lead.latestArticleDate && (
                <p className="text-xs text-slate-500">Latest article: {lead.latestArticleDate}</p>
              )}
              {lead.sampleArticleUrls.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {lead.sampleArticleUrls.map((u) => (
                    <li key={u} className="truncate text-xs">
                      <a
                        href={u}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 hover:underline"
                      >
                        {u}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 p-3.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Ads &amp; Audio Reader Check
              </h3>
              <p className="mt-1 text-sm font-medium text-slate-900">
                Ads:{' '}
                {lead.hasAds === null
                  ? 'Unknown'
                  : lead.hasAds
                    ? `Active${lead.hasAdsTxt ? ` (/ads.txt: ${lead.adsTxtEntries} lines)` : ''}`
                    : 'None detected'}
              </p>
              {lead.adNetworksDetected.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {lead.adNetworksDetected.map((n) => (
                    <span
                      key={n}
                      className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700"
                    >
                      {n}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2.5 text-sm font-medium text-slate-900">
                Audio Player:{' '}
                {lead.hasAudioPlayer === null
                  ? 'Unknown'
                  : lead.hasAudioPlayer
                    ? `Present (${lead.audioProvidersDetected.join(', ')})`
                    : 'None detected (Open opportunity)'}
              </p>
              {lead.audioEvidence && (
                <p className="text-xs text-rose-600">{lead.audioEvidence}</p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                Language: {lead.detectedLanguage?.toUpperCase() || 'Unknown'}
                {lead.detectedCountry ? ` · Region: ${lead.detectedCountry}` : ''}
              </p>
            </div>
          </div>

          {/* Traffic & Notes form */}
          <form onSubmit={handleSaveMeta} className="rounded-xl border border-slate-200 p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="detail-visits" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Monthly Visits (from Similarweb)
                </label>
                <input
                  id="detail-visits"
                  type="text"
                  value={visitsInput}
                  onChange={(e) => setVisitsInput(e.target.value)}
                  placeholder="e.g. 120K or 1.4M"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Current:{' '}
                  {lead.monthlyVisits !== null && visitsSourceLabel(lead.visitsSource)
                    ? `~${formatVisits(lead.monthlyVisits)} (${visitsSourceLabel(lead.visitsSource)} estimate)`
                    : formatVisits(lead.monthlyVisits)}{' '}
                  · Updates qualification automatically
                </p>
              </div>
              <div>
                <label htmlFor="detail-parent-company" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Parent Company
                </label>
                <input
                  id="detail-parent-company"
                  type="text"
                  value={parentCompanyInput}
                  onChange={(e) => setParentCompanyInput(e.target.value)}
                  placeholder="e.g. Valnet, Static Media"
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Used for Parent Company suppression matching
                </p>
                <button
                  type="button"
                  onClick={handleSuppressParentCompany}
                  disabled={suppressingCompany || !(parentCompanyInput.trim() || lead.parentCompany)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                >
                  <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                  {suppressingCompany ? 'Suppressing...' : 'Suppress Parent Co. (DNC)'}
                </button>
              </div>
              <div>
                <label htmlFor="detail-notes" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Outreach Notes
                </label>
                <input
                  id="detail-notes"
                  type="text"
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  placeholder="e.g. Uses Mediavine, pitch CTO or Editor-in-Chief"
                  className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingMeta}
                className="rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {savingMeta ? 'Saving...' : 'Save Visits & Notes'}
              </button>
            </div>
          </form>

          {/* Decision-Maker Contacts */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Decision-Maker Contacts ({lead.contacts.length})
                </h3>
                <p className="text-xs text-slate-500">
                  Ranked by authority to authorize site changes. Generic editorial/business emails are separated as fallbacks.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in "${lead.domain.split('.')[0]}" ("Founder" OR "Publisher" OR "Editor in Chief" OR "Head of Digital")`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  LinkedIn Search <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
                <button
                  type="button"
                  onClick={handleEnrich}
                  disabled={enriching}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {enriching ? 'Enriching...' : 'Enrich via API'}
                </button>
              </div>
            </div>

            {lead.contacts.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
                No contacts extracted directly from public pages. Try LinkedIn Search above, add one manually, or connect Hunter/Apollo in Settings.
              </p>
            ) : (
              <ul className="space-y-2">
                {lead.contacts.map((contact) => {
                  const tier = authorityTierLabel(contact.authorityTier);
                  return (
                    <li
                      key={contact.id}
                      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${
                        contact.isPrimary
                          ? 'border-indigo-300 bg-indigo-50/40'
                          : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            {contact.fullName || (contact.isGenericEmail ? 'Generic Role Inbox' : 'Site Contact')}
                          </span>
                          {contact.roleTitle && (
                            <span className="text-xs font-medium text-slate-600">
                              · {contact.roleTitle}
                            </span>
                          )}
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tier.classes}`}>
                            {tier.text}
                          </span>
                          {contact.isPrimary && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                              Primary
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                          {contact.email && (
                            <span className="inline-flex items-center gap-1 font-mono text-slate-900">
                              {contact.email}
                              {contact.mxValid && (
                                <MailCheck className="h-3.5 w-3.5 text-emerald-600" aria-label="Valid MX" />
                              )}
                              {contact.isGenericEmail && (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-800">
                                  Generic fallback
                                </span>
                              )}
                            </span>
                          )}
                          {contact.sourceUrl && (
                            <a
                              href={contact.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-600 hover:underline"
                            >
                              Source ({contact.sourceType})
                            </a>
                          )}
                          {contact.linkedinUrl && (
                            <a
                              href={contact.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-700 hover:underline"
                            >
                              LinkedIn
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {contact.email && (
                          <button
                            type="button"
                            onClick={() => copyEmail(contact.id, contact.email!)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            {copiedId === contact.id ? (
                              <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            {copiedId === contact.id ? 'Copied' : 'Copy'}
                          </button>
                        )}
                        {!contact.isPrimary && (
                          <button
                            type="button"
                            onClick={() => handleSetPrimary(contact.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            title="Set as primary export contact"
                          >
                            <Star className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteContact(contact.id)}
                          className="inline-flex items-center rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                          aria-label="Delete contact"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Quick Add Manual Contact */}
            <form
              onSubmit={handleAddContact}
              className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-5"
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Full name"
                aria-label="Contact full name"
                className="app-input rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              />
              <input
                type="text"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                placeholder="Role (e.g. Publisher)"
                aria-label="Contact role"
                className="app-input rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              />
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="email@site.com"
                aria-label="Contact email"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="app-input rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              />
              <input
                type="url"
                value={newLinkedin}
                onChange={(e) => setNewLinkedin(e.target.value)}
                placeholder="LinkedIn URL (optional)"
                aria-label="LinkedIn URL"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="app-input rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              />
              <button
                type="submit"
                disabled={addingContact}
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add
              </button>
            </form>
          </div>
        </div>
      )}
    </NativeDialog>
  );
}
