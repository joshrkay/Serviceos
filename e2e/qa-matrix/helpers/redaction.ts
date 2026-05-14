const SECRET = '<redacted>';

const HIGH_RISK_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'bearer', regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'api_key', regex: /\b(?:sk|pk|rk|api|key)[_-]?[A-Za-z0-9]{12,}\b/gi },
  { name: 'email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: 'phone', regex: /\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
];

function scrubString(input: string): string {
  let output = input;
  for (const { regex } of HIGH_RISK_PATTERNS) output = output.replace(regex, SECRET);
  return output;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|token|secret|api[-_]?key/i.test(k) ? SECRET : scrubString(String(v));
  }
  return out;
}

export function redactUnknown<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value) as T;
  if (Array.isArray(value)) return value.map((x) => redactUnknown(x)) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /authorization|token|secret|api[-_]?key|password/i.test(k) ? SECRET : redactUnknown(v);
    }
    return out as T;
  }
  return value;
}

export function fingerprint(value: unknown): string {
  const raw = JSON.stringify(redactUnknown(value));
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Collects every string leaf of an arbitrary value. Non-string scalars
 * (numbers, booleans) are skipped: the secrets we care about — bearer
 * tokens, JWTs, API keys, emails, phone numbers — always appear as strings
 * in payloads. Scanning JSON.stringify() output instead false-positives on
 * numeric values (e.g. a 10-digit unix timestamp matches the phone pattern).
 */
function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(v, out);
    }
  }
}

export function scanForSecrets(value: unknown): Array<{ name: string; sample: string }> {
  const leaves: string[] = [];
  collectStringLeaves(value, leaves);
  const findings: Array<{ name: string; sample: string }> = [];
  for (const { name, regex } of HIGH_RISK_PATTERNS) {
    for (const leaf of leaves) {
      const m = leaf.match(regex);
      if (m?.length) {
        findings.push({ name, sample: m[0].slice(0, 64) });
        break;
      }
    }
  }
  return findings;
}
