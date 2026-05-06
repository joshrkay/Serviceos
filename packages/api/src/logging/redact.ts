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
