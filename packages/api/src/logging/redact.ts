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

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function shouldRedactValue(value: unknown): boolean {
  // Empty strings stay untouched — intentionally-blank secrets (e.g. in test
  // fixtures) shouldn't flip to '[REDACTED]' and mask the fact that nothing
  // was actually set.
  if (typeof value === 'string' && value.length === 0) return false;
  if (value === undefined || value === null) return false;
  return true;
}

function walk<T>(input: T, seen: WeakSet<object>): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;

  if (seen.has(input as object)) {
    return CIRCULAR as unknown as T;
  }
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((v) => walk(v, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretKey(key) && shouldRedactValue(value)) {
      // Redact the entire value regardless of its type — object/array/number
      // values under a secret-like key could still leak sensitive data.
      out[key] = REDACTED;
    } else {
      out[key] = walk(value, seen);
    }
  }
  return out as T;
}

export function redactSecrets<T>(input: T): T {
  return walk(input, new WeakSet<object>());
}
