import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Save } from 'lucide-react';
import type { LlmProvider, MaskedAppSettings } from '@audiolead/shared';
import { api } from '../api/client';

interface SettingsPageProps {
  onSettingsSaved: () => void;
  onNotify: (kind: 'success' | 'error', text: string) => void;
}

export function SettingsPage({ onSettingsSaved, onNotify }: SettingsPageProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [minMonthlyVisits, setMinMonthlyVisits] = useState('50000');
  const [targetLanguages, setTargetLanguages] = useState('en');
  const [targetCountries, setTargetCountries] = useState('');
  const [requireArticles, setRequireArticles] = useState(true);
  const [requireAds, setRequireAds] = useState(true);
  const [requireNoAudioPlayer, setRequireNoAudioPlayer] = useState(true);
  const [minArticleCount, setMinArticleCount] = useState('3');
  const [maxDaysSinceLastArticle, setMaxDaysSinceLastArticle] = useState('180');

  const [contactedCooldownDays, setContactedCooldownDays] = useState('90');
  const [excludeMegaPublishers, setExcludeMegaPublishers] = useState(true);

  const [hunterApiKey, setHunterApiKey] = useState('');
  const [apolloApiKey, setApolloApiKey] = useState('');
  const [serperApiKey, setSerperApiKey] = useState('');
  const [braveApiKey, setBraveApiKey] = useState('');
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('none');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('');

  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

  const applyLoaded = (s: MaskedAppSettings) => {
    setMinMonthlyVisits(String(s.minMonthlyVisits));
    setTargetLanguages(s.targetLanguages.join(', '));
    setTargetCountries(s.targetCountries.join(', '));
    setRequireArticles(s.requireArticles);
    setRequireAds(s.requireAds);
    setRequireNoAudioPlayer(s.requireNoAudioPlayer);
    setMinArticleCount(String(s.minArticleCount));
    setMaxDaysSinceLastArticle(String(s.maxDaysSinceLastArticle));
    setContactedCooldownDays(String(s.contactedCooldownDays));
    setExcludeMegaPublishers(s.excludeMegaPublishers);
    setHunterApiKey(s.hunterApiKeyPreview);
    setApolloApiKey(s.apolloApiKeyPreview);
    setSerperApiKey(s.serperApiKeyPreview);
    setBraveApiKey(s.braveApiKeyPreview);
    setLlmProvider(s.llmProvider);
    setLlmApiKey(s.llmApiKeyPreview);
    setLlmModel(s.llmModel);
  };

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.getSettings();
        applyLoaded(res.settings);
      } catch (err) {
        onNotify('error', err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.updateSettings({
        minMonthlyVisits: Number(minMonthlyVisits) || 0,
        targetLanguages: targetLanguages
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
        targetCountries: targetCountries
          .split(',')
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean),
        requireArticles,
        requireAds,
        requireNoAudioPlayer,
        minArticleCount: Math.max(1, Number(minArticleCount) || 3),
        maxDaysSinceLastArticle: Math.max(1, Number(maxDaysSinceLastArticle) || 180),
        contactedCooldownDays: Math.max(0, Number(contactedCooldownDays) || 0),
        excludeMegaPublishers,
        hunterApiKey,
        apolloApiKey,
        serperApiKey,
        braveApiKey,
        llmProvider,
        llmApiKey,
        llmModel,
      });
      applyLoaded(res.settings);
      onSettingsSaved();
      onNotify('success', 'Settings saved');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const renderSecretField = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => {
    const visible = Boolean(showSecret[id]);
    return (
      <div className="flex flex-col justify-end min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          {label}
        </label>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <input
            id={id}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className="app-input min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            aria-pressed={visible}
            aria-label={visible ? `Hide ${label}` : `Show ${label}`}
            onClick={() => setShowSecret((prev) => ({ ...prev, [id]: !prev[id] }))}
            className="inline-flex h-[42px] w-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
          >
            {visible ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return <p className="py-12 text-center text-sm text-slate-500">Loading settings...</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Qualification &amp; Cooldown Settings</h1>
          <p className="mt-1 text-sm text-slate-600">
            Configure target publisher thresholds, outreach cooldowns, and optional API keys.
          </p>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* Group 1: Qualification Criteria */}
      <fieldset className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
        <legend className="px-2 text-sm font-bold text-slate-900">
          Website Qualification Criteria
        </legend>

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="set-visits" className="block text-sm font-medium text-slate-700">
              Minimum Monthly Visitors
            </label>
            <input
              id="set-visits"
              type="text"
              inputMode="numeric"
              value={minMonthlyVisits}
              onChange={(e) => setMinMonthlyVisits(e.target.value)}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">Default: 50,000 monthly visits</p>
          </div>

          <div>
            <label htmlFor="set-langs" className="block text-sm font-medium text-slate-700">
              Target Languages (ISO codes)
            </label>
            <input
              id="set-langs"
              type="text"
              value={targetLanguages}
              onChange={(e) => setTargetLanguages(e.target.value)}
              placeholder="en, es"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">Comma-separated; blank allows any</p>
          </div>

          <div>
            <label htmlFor="set-countries" className="block text-sm font-medium text-slate-700">
              Target Countries (optional)
            </label>
            <input
              id="set-countries"
              type="text"
              value={targetCountries}
              onChange={(e) => setTargetCountries(e.target.value)}
              placeholder="e.g. US, GB, CA"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="set-min-articles" className="block text-sm font-medium text-slate-700">
                Min Articles
              </label>
              <input
                id="set-min-articles"
                type="text"
                inputMode="numeric"
                value={minArticleCount}
                onChange={(e) => setMinArticleCount(e.target.value)}
                className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="set-max-age" className="block text-sm font-medium text-slate-700">
                Max Age (days)
              </label>
              <input
                id="set-max-age"
                type="text"
                inputMode="numeric"
                value={maxDaysSinceLastArticle}
                onChange={(e) => setMaxDaysSinceLastArticle(e.target.value)}
                className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-6 pt-2">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={requireArticles}
              onChange={(e) => setRequireArticles(e.target.checked)}
              className="h-4 w-4 accent-indigo-600"
            />
            Require active written articles
          </label>

          <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={requireAds}
              onChange={(e) => setRequireAds(e.target.checked)}
              className="h-4 w-4 accent-indigo-600"
            />
            Require active ads (/ads.txt or ad scripts)
          </label>

          <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={requireNoAudioPlayer}
              onChange={(e) => setRequireNoAudioPlayer(e.target.checked)}
              className="h-4 w-4 accent-indigo-600"
            />
            Disqualify sites that already have an audio player
          </label>
        </div>
      </fieldset>

      {/* Group 2: Suppression Cooldown & Discovery */}
      <fieldset className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
        <legend className="px-2 text-sm font-bold text-slate-900">
          Outreach Cooldown &amp; Discovery Defaults
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="set-cooldown" className="block text-sm font-medium text-slate-700">
              Already Contacted Cooldown (days)
            </label>
            <input
              id="set-cooldown"
              type="text"
              inputMode="numeric"
              value={contactedCooldownDays}
              onChange={(e) => setContactedCooldownDays(e.target.value)}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">
              Default: 90 days. Changing this immediately updates active cooldowns across Discovery and Pipeline.
            </p>
          </div>

          <div className="flex items-center pt-4">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={excludeMegaPublishers}
                onChange={(e) => setExcludeMegaPublishers(e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
              Exclude mega-publishers by default during Discovery (CNN, BBC, Forbes, NYT...)
            </label>
          </div>
        </div>
      </fieldset>

      {/* Group 3: Optional BYOK API Keys */}
      <fieldset className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
        <legend className="px-2 text-sm font-bold text-slate-900">
          Optional API Keys (100% Free Without Keys)
        </legend>
        <p className="text-xs text-slate-500">
          Keys stay in your local SQLite database and unlock deeper contact email discovery or broader search coverage when provided. Clear a field and save to remove a key.
        </p>

        <div className="grid items-end gap-4 sm:grid-cols-2">
          {renderSecretField(
            'key-hunter',
            'Hunter.io API Key',
            hunterApiKey,
            setHunterApiKey,
            'Optional Hunter API key',
          )}
          {renderSecretField(
            'key-apollo',
            'Apollo.io API Key',
            apolloApiKey,
            setApolloApiKey,
            'Optional Apollo API key',
          )}
          {renderSecretField(
            'key-serper',
            'Serper.dev API Key',
            serperApiKey,
            setSerperApiKey,
            'Optional Serper API key',
          )}
          {renderSecretField(
            'key-brave',
            'Brave Search API Key',
            braveApiKey,
            setBraveApiKey,
            'Optional Brave API key',
          )}
        </div>

        <div className="grid items-end gap-4 pt-2 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0">
            <label htmlFor="set-llm-provider" className="block text-sm font-medium text-slate-700">
              AI Masthead Parser
            </label>
            <select
              id="set-llm-provider"
              value={llmProvider}
              onChange={(e) => setLlmProvider(e.target.value as LlmProvider)}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="none">Disabled</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>

          {renderSecretField(
            'key-llm',
            'LLM API Key',
            llmApiKey,
            setLlmApiKey,
            'Optional OpenAI / Gemini key',
          )}

          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <label htmlFor="set-llm-model" className="block text-sm font-medium text-slate-700">
              Model Override (Optional)
            </label>
            <input
              id="set-llm-model"
              type="text"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder={llmProvider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini'}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="app-input mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </fieldset>
    </form>
  );
}
