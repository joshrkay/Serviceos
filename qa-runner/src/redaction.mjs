const SECRET = '<redacted>';
const HIGH_RISK_PATTERNS = [
  { name: 'bearer', regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'api_key', regex: /\b(?:sk|pk|rk|api|key)[_-]?[A-Za-z0-9]{12,}\b/gi },
  { name: 'email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: 'phone', regex: /\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
];
const scrubString = (s) => HIGH_RISK_PATTERNS.reduce((acc, p) => acc.replace(p.regex, SECRET), s);
export function redactHeaders(headers = {}) { return Object.fromEntries(Object.entries(headers).map(([k,v]) => [k, /authorization|token|secret|api[-_]?key/i.test(k) ? SECRET : scrubString(String(v))])); }
export function redactUnknown(value) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /authorization|token|secret|api[-_]?key|password/i.test(k) ? SECRET : redactUnknown(v)]));
  return value;
}
export function scanForSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const findings = [];
  for (const p of HIGH_RISK_PATTERNS) { const m = text.match(p.regex); if (m?.length) findings.push({ name: p.name, sample: m[0].slice(0,64) }); }
  return findings;
}
export function fingerprint(value) {
  const raw = JSON.stringify(redactUnknown(value));
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) { hash ^= raw.charCodeAt(i); hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24); }
  return (hash >>> 0).toString(16);
}
