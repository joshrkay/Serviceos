/**
 * D-044 / #1768 — the address of a hosted tenant site: the `<slug>` in
 * `<slug>.<TENANT_SITE_BASE_DOMAIN>`. Pure helpers; whether a slug is already
 * taken is the repository's question.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 42;

/** Mirrors the CHECK on tenant_sites.slug (migration 334). */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{1,40}[a-z0-9])$/;

/**
 * Subdomains a business must not claim: they look like the platform, mail or
 * support, or are conventional infrastructure hosts. A tenant page on one of
 * these would be a phishing gift.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'admin', 'administrator', 'root', 'mail', 'email', 'smtp', 'imap', 'pop',
  'ftp', 'ns', 'ns1', 'ns2', 'dns', 'cdn', 'static', 'assets', 'img', 'images', 'media',
  'login', 'signin', 'signup', 'auth', 'sso', 'oauth', 'account', 'accounts', 'billing', 'pay',
  'payments', 'checkout', 'secure', 'security', 'support', 'help', 'status', 'docs', 'blog',
  'dashboard', 'portal', 'staging', 'stage', 'dev', 'test', 'demo', 'preview', 'sandbox',
  'rivet', 'serviceos', 'webhook', 'webhooks', 'voice', 'sites', 'site', 'web', 'wwww', 'localhost',
]);

export type SlugProblem = 'too_short' | 'too_long' | 'malformed' | 'reserved';

export const SLUG_PROBLEM_MESSAGES: Record<SlugProblem | 'taken', string> = {
  too_short: `Addresses need at least ${SLUG_MIN_LENGTH} characters`,
  too_long: `Addresses can be at most ${SLUG_MAX_LENGTH} characters`,
  malformed: 'Use only lowercase letters, numbers and single hyphens, starting and ending with a letter or number',
  reserved: 'That address is reserved. Pick another one',
  taken: 'That address is already taken. Pick another one',
};

/** Lowercases and trims; the owner may type it in any case. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/** The first problem with an already-normalized slug, or null when it is usable. */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < SLUG_MIN_LENGTH) return 'too_short';
  if (slug.length > SLUG_MAX_LENGTH) return 'too_long';
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) return 'malformed';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  return null;
}

/** A starting suggestion from the business name ("Joe's Plumbing & Heating" -> "joes-plumbing-heating"). */
export function suggestSlug(businessName: string): string {
  const base = businessName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slugProblem(base) === null ? base : '';
}

export type HostMatch =
  /** Not under the tenant-site domain: the app's own traffic. */
  | { kind: 'other' }
  /** The tenant-site domain itself or a nested/invalid subdomain: nothing to serve. */
  | { kind: 'unknown' }
  | { kind: 'site'; slug: string };

/** Classifies a request hostname against the configured tenant-site base domain. */
export function matchTenantSiteHost(hostname: string, baseDomain: string): HostMatch {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === baseDomain) return { kind: 'unknown' };
  if (!host.endsWith(`.${baseDomain}`)) return { kind: 'other' };
  const label = host.slice(0, host.length - baseDomain.length - 1);
  if (label.includes('.') || slugProblem(label) !== null) return { kind: 'unknown' };
  return { kind: 'site', slug: label };
}
