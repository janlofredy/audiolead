import type { AuthorityTier } from '@audiolead/shared';

export interface RankedAuthority {
  tier: AuthorityTier;
  score: number;
  isGenericEmail: boolean;
}

const GENERIC_PREFIXES = new Set([
  'editor',
  'editors',
  'editorial',
  'publisher',
  'partnerships',
  'partner',
  'advertising',
  'advertise',
  'ads',
  'adops',
  'webmaster',
  'business',
  'bizdev',
  'hello',
  'contact',
  'info',
  'press',
  'media',
  'news',
  'newsroom',
  'tips',
  'support',
  'admin',
  'team',
  'office',
  'sales',
  'marketing',
  'feedback',
  'inquiries',
  'enquiry',
  'general',
  'mail',
  'hi',
]);

const TIER_1_REGEX =
  /\b(founder|co-founder|cofounder|owner|proprietor|ceo|chief executive|president|publisher|managing director|editor[- ]in[- ]chief|executive editor|chief content officer|chief digital officer|cdo|cto|chief technology officer|head of digital|vp of digital|vice president of digital|head of product|vp of product|head of revenue|head of monetization|head of ad ops|vp of revenue|director of digital)\b/i;

const TIER_2_REGEX =
  /\b(managing editor|editorial director|digital director|head of content|head of audience|head of growth|head of partnerships|director of content|director of editorial|webmaster|site director|product manager|digital editor|senior editor|operations director|director of operations|head of engineering|vp of content|general manager)\b/i;

const TIER_3_REGEX =
  /\b(editor|associate editor|deputy editor|contributing editor|content manager|content lead|producer|journalist|writer|reporter|author|columnist|staff|coordinator|manager)\b/i;

export function isGenericRoleEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const local = email.split('@')[0]?.toLowerCase().replace(/\+.*/, '') ?? '';
  return GENERIC_PREFIXES.has(local);
}

export function scoreContactAuthority(input: {
  roleTitle?: string | null;
  email?: string | null;
  fullName?: string | null;
  sourcePage?: string | null;
}): RankedAuthority {
  const email = input.email?.trim().toLowerCase() ?? null;
  const generic = isGenericRoleEmail(email);
  const title = input.roleTitle?.trim() ?? '';

  if (title && TIER_1_REGEX.test(title)) {
    let score = generic ? 78 : 95;
    if (/\b(founder|owner|ceo|publisher|editor[- ]in[- ]chief)\b/i.test(title)) {
      score = generic ? 80 : 100;
    }
    if (email && !generic) score = Math.min(100, score);
    return { tier: 1, score, isGenericEmail: generic };
  }

  if (title && TIER_2_REGEX.test(title)) {
    return { tier: 2, score: generic ? 64 : 78, isGenericEmail: generic };
  }

  if (title && TIER_3_REGEX.test(title)) {
    return { tier: 3, score: generic ? 38 : 52, isGenericEmail: generic };
  }

  // No clear title: distinguish personal email vs generic inbox
  if (email && !generic) {
    const bonus = input.fullName ? 55 : 42;
    return { tier: 3, score: bonus, isGenericEmail: false };
  }

  if (email && generic) {
    const local = email.split('@')[0] ?? '';
    const highValueFallback = ['editor', 'editorial', 'publisher', 'partnerships', 'advertising', 'ads', 'adops', 'webmaster', 'bizdev', 'business'].includes(local);
    return { tier: 4, score: highValueFallback ? 32 : 20, isGenericEmail: true };
  }

  // Named person without email yet (useful for LinkedIn/Hunter lookup)
  if (input.fullName) {
    return { tier: 3, score: 40, isGenericEmail: false };
  }

  return { tier: 4, score: 10, isGenericEmail: generic };
}
