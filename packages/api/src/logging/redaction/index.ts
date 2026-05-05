import { createHmac } from 'node:crypto';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const PROMPT_INJECTION_MARKER = '[PROMPT_INJECTION_MARKER]';

const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  /secret/i,
  /password/i,
  /token/i,
  /api[_-]?key/i,
  /auth(orization)?/i,
  /bearer/i,
  /private[_-]?key/i,
  /signing[_-]?secret/i,
  /webhook[_-]?secret/i,
  /cookie/i,
  /session/i,
  /^x[-_]?api[-_]?key$/i,
];

const DEFAULT_HEADER_ALLOWLIST = ['content-type', 'content-length', 'user-agent', 'accept', 'host'];

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const INJECTION_MARKER_RE = /<(?:\/?\s*(?:system|assistant|developer|instruction|prompt|tool|function)[^>]*)>/gi;

export type SinkType = 'cloudwatch' | 'sentry' | 'qa';

export interface RedactionPolicy {
  redactedText: string;
  sensitiveKeyPatterns: RegExp[];
  preserveEmptyStrings: boolean;
  maxDepth: number;
}

export interface TranscriptSanitizeOptions {
  redactEmails?: boolean;
  redactPhones?: boolean;
  normalizePromptInjectionMarkers?: boolean;
  redactedText?: string;
}

export interface HeaderRedactionPolicy {
  allowlist: string[];
  sensitiveKeyPatterns: RegExp[];
  redactedText: string;
}

export const DEFAULT_API_REDACTION_POLICY: Readonly<RedactionPolicy> = {
  redactedText: REDACTED,
  sensitiveKeyPatterns: DEFAULT_SENSITIVE_KEY_PATTERNS,
  preserveEmptyStrings: true,
  maxDepth: 20,
};

export const DEFAULT_WORKER_REDACTION_POLICY: Readonly<RedactionPolicy> = {
  ...DEFAULT_API_REDACTION_POLICY,
  maxDepth: 12,
};

export const DEFAULT_QA_REDACTION_POLICY: Readonly<RedactionPolicy> = {
  ...DEFAULT_API_REDACTION_POLICY,
  maxDepth: 8,
};

export const DEFAULT_HEADER_REDACTION_POLICY: Readonly<HeaderRedactionPolicy> = {
  allowlist: DEFAULT_HEADER_ALLOWLIST,
  sensitiveKeyPatterns: DEFAULT_SENSITIVE_KEY_PATTERNS,
  redactedText: REDACTED,
};

function shouldRedactValue(value: unknown, preserveEmptyStrings: boolean): boolean {
  if (value === undefined || value === null) return false;
  if (preserveEmptyStrings && typeof value === 'string' && value.length === 0) return false;
  return true;
}

function isSensitiveKey(key: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(key));
}

function redactObjectInternal(value: unknown, policy: RedactionPolicy, depth: number, seen: WeakSet<object>): unknown {
  if (depth > policy.maxDepth) return policy.redactedText;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return CIRCULAR;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactObjectInternal(item, policy, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key, policy.sensitiveKeyPatterns) && shouldRedactValue(child, policy.preserveEmptyStrings)) {
      output[key] = policy.redactedText;
      continue;
    }
    output[key] = redactObjectInternal(child, policy, depth + 1, seen);
  }
  return output;
}

export function redactObject<T>(value: T, policy: RedactionPolicy = DEFAULT_API_REDACTION_POLICY): T {
  return redactObjectInternal(value, policy, 0, new WeakSet<object>()) as T;
}

export function sanitizeTranscript(text: string, options: TranscriptSanitizeOptions = {}): string {
  const redactedText = options.redactedText ?? REDACTED;
  let sanitized = text;

  if (options.redactEmails ?? true) sanitized = sanitized.replace(EMAIL_RE, redactedText);
  if (options.redactPhones ?? true) sanitized = sanitized.replace(PHONE_RE, redactedText);
  if (options.normalizePromptInjectionMarkers ?? true) {
    sanitized = sanitized.replace(INJECTION_MARKER_RE, PROMPT_INJECTION_MARKER);
  }

  return sanitized;
}

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  policy: HeaderRedactionPolicy = DEFAULT_HEADER_REDACTION_POLICY
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const isAllowed = policy.allowlist.includes(key);
    const isSensitive = isSensitiveKey(key, policy.sensitiveKeyPatterns);

    if (!isAllowed || isSensitive) {
      out[rawKey] = shouldRedactValue(value, false) ? policy.redactedText : value;
      continue;
    }

    out[rawKey] = value;
  }
  return out;
}

export function redactForSink<T extends Record<string, unknown>>(event: T, sinkType: SinkType): T {
  const policy =
    sinkType === 'qa'
      ? DEFAULT_QA_REDACTION_POLICY
      : sinkType === 'cloudwatch'
        ? DEFAULT_API_REDACTION_POLICY
        : DEFAULT_WORKER_REDACTION_POLICY;

  const redacted = redactObject(event, policy) as Record<string, unknown>;
  if (typeof redacted.message === 'string') {
    redacted.message = sanitizeTranscript(redacted.message);
  }

  if (redacted.headers && typeof redacted.headers === 'object' && !Array.isArray(redacted.headers)) {
    redacted.headers = redactHeaders(redacted.headers as Record<string, string | string[] | undefined>);
  }

  return redacted as T;
}

export function deterministicFingerprint(value: string, secret: string, prefix = 'fp'): string {
  const digest = createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

export { REDACTED, CIRCULAR };
