/**
 * Signup attribution — where a trial signup came from.
 *
 * The marketing site (therivetapp.com) forwards first-touch data to
 * `app.therivetapp.com/signup` two ways: query params (`utm_*`, `rvt_ref`,
 * `rvt_landing`, `rvt_ft_at`) and a first-party `rvt_ft` cookie on
 * `.therivetapp.com` whose value is
 * `encodeURIComponent(JSON.stringify({ ref, landing, at, utm_source?, ... }))`.
 *
 * The web client parses both with {@link parseSignupAttribution} and hands
 * the result to Clerk as `unsafe_metadata.signupAttribution`. That metadata
 * is client-controlled, so the API re-validates it with
 * {@link sanitizeSignupAttribution} — the same per-field rules — before
 * persisting it on the tenant. Pure; never throws on malformed input.
 */

export interface SignupAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  /** External referrer: http(s) origin + path, no query/fragment. */
  ref?: string;
  /** First marketing-site path; always starts with "/". */
  landing?: string;
  /** First-visit date, YYYY-MM-DD. */
  firstTouchAt?: string;
}

export const SIGNUP_ATTRIBUTION_MAX_LENGTH = 200;
export const SIGNUP_ATTRIBUTION_COOKIE = 'rvt_ft';

const UTM_FIELDS = [
  ['utmSource', 'utm_source'],
  ['utmMedium', 'utm_medium'],
  ['utmCampaign', 'utm_campaign'],
  ['utmContent', 'utm_content'],
  ['utmTerm', 'utm_term'],
] as const;

type UtmField = (typeof UTM_FIELDS)[number][0];

// Control characters (incl. NUL, which Postgres TEXT rejects outright).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function cleanUtm(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  return cleaned?.slice(0, SIGNUP_ATTRIBUTION_MAX_LENGTH);
}

function cleanRef(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const stripped = `${url.origin}${url.pathname}`;
  // A truncated URL would be a different (wrong) URL — drop instead.
  return stripped.length <= SIGNUP_ATTRIBUTION_MAX_LENGTH ? stripped : undefined;
}

function cleanLanding(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned || !cleaned.startsWith('/')) return undefined;
  // Path only: a query or fragment can carry emails or tokens.
  const path = cleaned.split(/[?#]/, 1)[0];
  return path.length <= SIGNUP_ATTRIBUTION_MAX_LENGTH ? path : undefined;
}

function cleanDate(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned || !DATE_RE.test(cleaned)) return undefined;
  // Reject impossible calendar dates (2026-02-31) — they would also fail a
  // Postgres DATE cast.
  const [y, m, d] = cleaned.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  return cleaned;
}

function compact(attr: SignupAttribution): SignupAttribution | null {
  const out: SignupAttribution = {};
  for (const [key, value] of Object.entries(attr) as Array<[keyof SignupAttribution, string | undefined]>) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function utmSet(read: (key: string) => unknown): Pick<SignupAttribution, UtmField> {
  const out: Pick<SignupAttribution, UtmField> = {};
  for (const [field, param] of UTM_FIELDS) {
    const value = cleanUtm(read(param));
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function decodeCookie(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Build a validated attribution from the signup URL's query string plus the
 * raw (still URI-encoded) `rvt_ft` cookie value. Precedence mirrors the
 * marketing site: if the URL carries any utm_* parameter (even one that
 * fails validation), the URL's utm set is used alone (never mixed with the
 * cookie's); otherwise the cookie's.
 * ref / landing / first-touch date each come from the URL, else the cookie.
 * Returns null when nothing valid remains.
 */
export function parseSignupAttribution(input: {
  search?: string | URLSearchParams | null;
  cookie?: string | null;
}): SignupAttribution | null {
  const params =
    input.search instanceof URLSearchParams
      ? input.search
      : new URLSearchParams(input.search ?? '');
  const cookie = decodeCookie(input.cookie) ?? {};

  const urlHasUtm = UTM_FIELDS.some(([, param]) => params.has(param));
  const utm = urlHasUtm ? utmSet((key) => params.get(key)) : utmSet((key) => cookie[key]);

  return compact({
    ...utm,
    ref: cleanRef(params.get('rvt_ref')) ?? cleanRef(cookie.ref),
    landing: cleanLanding(params.get('rvt_landing')) ?? cleanLanding(cookie.landing),
    firstTouchAt: cleanDate(params.get('rvt_ft_at')) ?? cleanDate(cookie.at),
  });
}

/**
 * Re-validate an already-shaped attribution object of unknown provenance
 * (e.g. Clerk `unsafe_metadata.signupAttribution`, which the browser
 * controls). Applies the same per-field rules as
 * {@link parseSignupAttribution}; unknown keys are dropped.
 */
export function sanitizeSignupAttribution(input: unknown): SignupAttribution | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const utm: Pick<SignupAttribution, UtmField> = {};
  for (const [field] of UTM_FIELDS) {
    const value = cleanUtm(raw[field]);
    if (value !== undefined) utm[field] = value;
  }
  return compact({
    ...utm,
    ref: cleanRef(raw.ref),
    landing: cleanLanding(raw.landing),
    firstTouchAt: cleanDate(raw.firstTouchAt),
  });
}

/** Read one cookie's raw (undecoded) value out of a `document.cookie` string. */
export function readCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Analytics gets enums only (analytics/posthog.ts: IDs/enums/flags, never
// PII). Every value below is matched against a fixed list and anything
// unknown becomes "other" — free text never reaches PostHog, however it is
// shaped. The full sanitized values stay in the tenant's signup_* columns.

/** Known utm_source values (lower-cased). */
const ANALYTICS_UTM_SOURCES = new Set([
  'google', 'bing', 'facebook', 'instagram', 'linkedin', 'reddit', 'youtube',
  'tiktok', 'x', 'twitter', 'nextdoor', 'yelp', 'chatgpt', 'perplexity',
  'newsletter', 'email', 'outbound', 'partner', 'referral',
]);

/** Known utm_medium values (lower-cased). */
const ANALYTICS_UTM_MEDIUMS = new Set([
  'cpc', 'ppc', 'paid', 'paid_social', 'display', 'social', 'organic',
  'email', 'outbound', 'referral', 'affiliate', 'partner', 'community',
]);

/** Referrer hostnames, matched on the domain or any subdomain of it. */
const ANALYTICS_REFERRERS: ReadonlyArray<[domain: string, label: string]> = [
  ['google.com', 'google'], ['bing.com', 'bing'], ['duckduckgo.com', 'duckduckgo'],
  ['yahoo.com', 'yahoo'], ['facebook.com', 'facebook'], ['instagram.com', 'instagram'],
  ['linkedin.com', 'linkedin'], ['lnkd.in', 'linkedin'], ['reddit.com', 'reddit'],
  ['youtube.com', 'youtube'], ['tiktok.com', 'tiktok'], ['x.com', 'x'], ['t.co', 'x'],
  ['twitter.com', 'x'], ['nextdoor.com', 'nextdoor'], ['yelp.com', 'yelp'],
  ['chatgpt.com', 'chatgpt'], ['openai.com', 'chatgpt'], ['perplexity.ai', 'perplexity'],
  ['claude.ai', 'claude'], ['therivetapp.com', 'rivet'],
];

/** First path segments of the marketing site (therivetapp.com). */
const ANALYTICS_LANDING_SECTIONS = new Set([
  '', 'trades', 'go', 'blog', 'guides', 'pricing', 'vs', 'tools', 'faq', 'about',
  'contact', 'demo', 'security', 'going-independent',
  'ai-answering-service-for-contractors', 'editorial-standards',
]);

function enumOrOther(value: string | undefined, known: ReadonlySet<string>): string | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  return known.has(v) ? v : 'other';
}

function referrerLabel(ref: string): string {
  const host = new URL(ref).hostname.toLowerCase();
  for (const [domain, label] of ANALYTICS_REFERRERS) {
    if (host === domain || host.endsWith(`.${domain}`)) return label;
  }
  return 'other';
}

/**
 * Flat analytics properties for an attribution, so the browser
 * `signup_started` and server `signup_completed` events carry identical keys.
 * Absent fields are omitted. Enum-only (see the lists above):
 * - utm_source / utm_medium: a known value, else "other"
 * - utm_campaign / utm_content / utm_term: never sent (free text)
 * - signup_referrer: a known site label, else "other"
 * - signup_landing_section: a known marketing section ("/trades"), else "other"
 */
export function signupAttributionProperties(
  attr: SignupAttribution | null,
): Record<string, string> {
  if (!attr) return {};
  const props: Record<string, string> = {};
  const source = enumOrOther(attr.utmSource, ANALYTICS_UTM_SOURCES);
  const medium = enumOrOther(attr.utmMedium, ANALYTICS_UTM_MEDIUMS);
  if (source !== undefined) props.utm_source = source;
  if (medium !== undefined) props.utm_medium = medium;
  if (attr.ref !== undefined) props.signup_referrer = referrerLabel(attr.ref);
  if (attr.landing !== undefined) {
    const segment = attr.landing.split('/')[1] ?? '';
    props.signup_landing_section = ANALYTICS_LANDING_SECTIONS.has(segment) ? `/${segment}` : 'other';
  }
  if (attr.firstTouchAt !== undefined) props.signup_first_touch_at = attr.firstTouchAt;
  return props;
}
