const SECRET_KEY_PATTERNS = [
  /secret/i,
  /password/i,
  /token/i,
  /api[_-]?key/i,
  /auth(orization)?/i,
  /bearer/i,
  /private[_-]?key/i,
  /signing[_-]?secret/i,
  /webhook[_-]?secret/i,
  /clerk/i,
  /stripe/i,
];

const PII_KEY_PATTERNS = [/email/i, /phone/i, /name/i, /address/i, /user/i, /tenant/i];

// SEC-20 — keys whose VALUE is a raw request URL/path. Key-based redaction
// above never inspects a string value for an embedded secret, so a `route`
// or `url` field logged verbatim leaks live bearer tokens that travel as a
// query param or as the `:token` path segment on a public, token-gated
// route (`/public/estimates/:token`, `/api/public/portal/:token`, etc — see
// PUBLIC_TOKEN_PATH_PATTERNS below). Matched by exact key name (not
// substring) to avoid over-masking unrelated fields.
const URL_VALUE_KEY_PATTERN = /^(url|route|originalUrl|referrer|referer)$/i;

// Query param names that may carry a bearer/session token as their value.
const TOKEN_QUERY_PARAM_PATTERN =
  /^(token|access[_-]?token|session[_-]?token|view[_-]?token|auth|authorization|api[_-]?key|secret|password)$/i;

// Public, unauthenticated routes where a bearer/session token travels as a
// single path segment. Enumerated by grepping `app.use('/public/...')` /
// `'/api/public/...'` mounts in packages/api/src/app.ts and the
// corresponding `router.get('/:token', ...)` handlers:
//   - /public/estimates/:token/...      (routes/public-estimates.ts)
//   - /public/invoices/:token/...       (routes/public-invoices.ts)
//   - /public/feedback/:token           (routes/public-feedback.ts)
//   - /api/public/portal/:token/...     (routes/public-portal.ts)
// /pay/:token and /e/:token are named as reserved public token paths in the
// comment header of middleware/tenant-context.ts but are not currently
// mounted anywhere in app.ts (no `/pay` or `/e` route exists yet). They are
// masked defensively here so that mounting them later doesn't silently
// reopen this gap.
const PUBLIC_TOKEN_PATH_PATTERNS: RegExp[] = [
  /^(\/public\/estimates\/)[^/?]+/,
  /^(\/public\/invoices\/)[^/?]+/,
  /^(\/public\/feedback\/)[^/?]+/,
  /^(\/api\/public\/portal\/)[^/?]+/,
  /^(\/pay\/)[^/?]+/,
  /^(\/e\/)[^/?]+/,
];

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

export type RedactionTier = 'strict' | 'standard';

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function isPiiKey(key: string): boolean {
  return PII_KEY_PATTERNS.some((re) => re.test(key));
}

function shouldRedactValue(value: unknown): boolean {
  if (typeof value === 'string' && value.length === 0) return false;
  if (value === undefined || value === null) return false;
  return true;
}

function maskValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= 4) return REDACTED;
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return REDACTED;
}

function scrubTokenQueryParams(query: string): string {
  if (!query) return query;
  return query
    .split('&')
    .map((pair) => {
      const eqIndex = pair.indexOf('=');
      const rawKey = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        // Malformed percent-encoding — fall back to matching the raw key.
      }
      return TOKEN_QUERY_PARAM_PATTERN.test(decodedKey) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join('&');
}

function scrubTokenPathSegment(pathname: string): string {
  for (const pattern of PUBLIC_TOKEN_PATH_PATTERNS) {
    if (pattern.test(pathname)) {
      return pathname.replace(pattern, `$1${REDACTED}`);
    }
  }
  return pathname;
}

/**
 * SEC-20 — value-pattern scrub for a raw URL/path string (e.g.
 * `req.originalUrl`). Unlike the key-based redaction in `walk()`, this
 * inspects the VALUE itself: it masks known token query params (`?token=..`
 * -> `?token=[REDACTED]`) and the token path segment on known public,
 * token-gated routes, while preserving the rest of the path/query so the
 * log line stays useful for observability.
 */
export function redactUrlValue(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return rawUrl;

  const queryIndex = rawUrl.indexOf('?');
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);

  const scrubbedPath = scrubTokenPathSegment(pathname);
  if (queryIndex === -1) return scrubbedPath;

  return `${scrubbedPath}?${scrubTokenQueryParams(query)}`;
}

function walk<T>(input: T, seen: WeakSet<object>, tier: RedactionTier): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;

  if (seen.has(input as object)) {
    return CIRCULAR as unknown as T;
  }
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((v) => walk(v, seen, tier)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretKey(key) && shouldRedactValue(value)) {
      out[key] = REDACTED;
      continue;
    }
    if (URL_VALUE_KEY_PATTERN.test(key) && typeof value === 'string') {
      // Applies at every tier (not just 'strict') — this is a live-secret
      // exposure, not a PII-minimization concern.
      out[key] = redactUrlValue(value);
      continue;
    }
    if (tier === 'strict' && isPiiKey(key) && shouldRedactValue(value)) {
      out[key] = maskValue(value);
      continue;
    }
    out[key] = walk(value, seen, tier);
  }
  return out as unknown as T;
}

export function redactSecrets<T>(input: T): T {
  return walk(input, new WeakSet<object>(), 'standard');
}

export function redactByTier<T>(input: T, tier: RedactionTier): T {
  return walk(input, new WeakSet<object>(), tier);
}

export function redactSentryUser(user: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!user) return user;
  return redactByTier(user, 'strict');
}

export function serializeRedacted(input: unknown, tier: RedactionTier = 'standard'): string {
  return JSON.stringify(redactByTier(input, tier));
}
