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

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

export function redactSecrets<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (isSecretKey(key) && typeof value === 'string' && value.length > 0) {
        out[key] = REDACTED;
      } else {
        out[key] = redactSecrets(value);
      }
    }
    return out as T;
  }
  return input;
}
