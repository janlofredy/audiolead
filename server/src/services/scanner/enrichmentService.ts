import * as cheerio from 'cheerio';
import type { AppSettings, AuthorityTier, Contact } from '@audiolead/shared';
import { safeFetch } from './safeFetch.js';
import { isGenericRoleEmail, scoreContactAuthority } from './authorityRanker.js';
import { cleanValidEmail } from './contactFinder.js';

export interface EnrichedContactInput {
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
}

export async function enrichDomainWithApis(
  domain: string,
  baseUrl: string,
  settings: AppSettings,
): Promise<{ contacts: EnrichedContactInput[]; providersUsed: string[]; notes: string[] }> {
  const results: EnrichedContactInput[] = [];
  const providersUsed: string[] = [];
  const notes: string[] = [];

  // 1. Hunter.io Domain Search
  if (settings.hunterApiKey) {
    providersUsed.push('Hunter.io');
    try {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(settings.hunterApiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: {
            emails?: Array<{
              value?: string;
              first_name?: string;
              last_name?: string;
              position?: string;
              linkedin?: string;
              type?: string;
              verification?: { status?: string };
            }>;
          };
        };
        for (const item of json.data?.emails ?? []) {
          const email = item.value ? cleanValidEmail(item.value) : null;
          if (!email) continue;
          const fullName = [item.first_name, item.last_name].filter(Boolean).join(' ').trim() || null;
          const roleTitle = item.position?.trim() || null;
          const auth = scoreContactAuthority({ fullName, roleTitle, email });
          results.push({
            fullName,
            roleTitle,
            authorityTier: auth.tier,
            authorityScore: auth.score,
            email,
            isGenericEmail: item.type === 'generic' || isGenericRoleEmail(email),
            mxValid: item.verification?.status === 'valid' ? true : null,
            linkedinUrl: item.linkedin ?? null,
            sourceUrl: `https://hunter.io/search/${domain}`,
            sourceType: 'hunter',
          });
        }
      } else {
        notes.push(`Hunter.io returned HTTP ${res.status}`);
      }
    } catch (err) {
      notes.push(`Hunter.io error: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  // 2. Apollo.io People Search
  if (settings.apolloApiKey) {
    providersUsed.push('Apollo.io');
    try {
      const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': settings.apolloApiKey,
        },
        body: JSON.stringify({
          q_organization_domains: domain,
          person_seniorities: ['owner', 'founder', 'c_suite', 'vp', 'director', 'head'],
          per_page: 8,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          people?: Array<{
            name?: string;
            title?: string;
            email?: string;
            linkedin_url?: string;
          }>;
        };
        for (const p of json.people ?? []) {
          const email = p.email ? cleanValidEmail(p.email) : null;
          const auth = scoreContactAuthority({ fullName: p.name, roleTitle: p.title, email });
          if (!email && !p.name) continue;
          results.push({
            fullName: p.name ?? null,
            roleTitle: p.title ?? null,
            authorityTier: auth.tier,
            authorityScore: auth.score,
            email,
            isGenericEmail: email ? isGenericRoleEmail(email) : false,
            mxValid: null,
            linkedinUrl: p.linkedin_url ?? null,
            sourceUrl: 'https://app.apollo.io',
            sourceType: 'apollo',
          });
        }
      } else {
        notes.push(`Apollo.io returned HTTP ${res.status}`);
      }
    } catch (err) {
      notes.push(`Apollo.io error: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  // 3. Optional LLM (OpenAI / Gemini) structured masthead extraction
  if (settings.llmProvider !== 'none' && settings.llmApiKey) {
    providersUsed.push(settings.llmProvider === 'openai' ? 'OpenAI' : 'Gemini');
    try {
      const pageCandidates = [
        baseUrl,
        new URL('/about', baseUrl).toString(),
        new URL('/team', baseUrl).toString(),
        new URL('/masthead', baseUrl).toString(),
        new URL('/contact', baseUrl).toString(),
      ];
      const snippets: string[] = [];
      for (const pUrl of pageCandidates) {
        const fetched = await safeFetch(pUrl, { timeoutMs: 5000, maxBytes: 512_000 });
        if (!fetched.ok) continue;
        const $ = cheerio.load(fetched.body);
        $('script, style, noscript').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3500);
        if (text) snippets.push(`SOURCE ${fetched.finalUrl}:\n${text}`);
      }

      if (snippets.length > 0) {
        const prompt = `Extract website decision-makers (Founder, Owner, Publisher, Editor-in-Chief, Head of Digital/Product, CTO, Ad Ops/Revenue lead) and any editorial/business contact emails from the text below. Return strict JSON: {"contacts":[{"fullName":string|null,"roleTitle":string|null,"email":string|null,"linkedinUrl":string|null}]}. Only include people or emails explicitly present in the text.\n\n${snippets.join('\n\n').slice(0, 12000)}`;

        let parsedContacts: Array<{
          fullName?: string | null;
          roleTitle?: string | null;
          email?: string | null;
          linkedinUrl?: string | null;
        }> = [];

        if (settings.llmProvider === 'openai') {
          const model = settings.llmModel || 'gpt-4o-mini';
          const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${settings.llmApiKey}`,
            },
            body: JSON.stringify({
              model,
              response_format: { type: 'json_object' },
              messages: [{ role: 'user', content: prompt }],
              temperature: 0,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (llmRes.ok) {
            const payload = (await llmRes.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const content = payload.choices?.[0]?.message?.content;
            if (content) {
              const json = JSON.parse(content) as { contacts?: typeof parsedContacts };
              parsedContacts = json.contacts ?? [];
            }
          }
        } else if (settings.llmProvider === 'gemini') {
          const model = settings.llmModel || 'gemini-2.5-flash';
          const llmRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.llmApiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: 'application/json' },
              }),
              signal: AbortSignal.timeout(15000),
            },
          );
          if (llmRes.ok) {
            const payload = (await llmRes.json()) as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const content = payload.candidates?.[0]?.content?.parts?.[0]?.text;
            if (content) {
              const json = JSON.parse(content) as { contacts?: typeof parsedContacts };
              parsedContacts = json.contacts ?? [];
            }
          }
        }

        for (const c of parsedContacts) {
          const email = c.email ? cleanValidEmail(c.email) : null;
          if (!email && !c.fullName) continue;
          const auth = scoreContactAuthority({
            fullName: c.fullName,
            roleTitle: c.roleTitle,
            email,
          });
          results.push({
            fullName: c.fullName ?? null,
            roleTitle: c.roleTitle ?? null,
            authorityTier: auth.tier,
            authorityScore: auth.score,
            email,
            isGenericEmail: email ? isGenericRoleEmail(email) : false,
            mxValid: null,
            linkedinUrl: c.linkedinUrl ?? null,
            sourceUrl: baseUrl,
            sourceType: 'llm',
          });
        }
      }
    } catch (err) {
      notes.push(`LLM extraction error: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  return { contacts: results, providersUsed, notes };
}
