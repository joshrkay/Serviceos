/**
 * Microsoft Presidio HTTP adapter (QUALITY-2026-07-12 WS5).
 *
 * Presidio ships as two REST services:
 *   - Analyzer   (POST /analyze)   — NER + recognizers → PII spans.
 *   - Anonymizer (POST /anonymize) — replaces those spans with placeholders.
 *
 * This adapter is the FIRST redaction pass for tenant training assets, ahead
 * of the deterministic `scrubPii` regex/known-entity sweep (defense in depth)
 * and the residual-PII gate. It is deliberately fail-closed: any transport
 * fault (connection refused, non-2xx, timeout, malformed JSON) throws
 * {@link PresidioUnavailableError}, and the redaction path turns that into an
 * asset quarantine rather than persisting raw or merely-regex-scrubbed text.
 *
 * Never trust the network with an unbounded wait — every call is guarded by an
 * AbortSignal timeout (mirrors HttpVapiClient in integrations/vapi/client.ts).
 * The adapter performs no I/O of its own beyond the two POSTs and holds no
 * mutable state, so it is trivially mockable in unit tests (inject `fetchFn`).
 */

/** A single PII span as returned by the Presidio Analyzer. */
export interface PresidioEntity {
  entityType: string;
  start: number;
  end: number;
  score: number;
}

export interface PresidioAnonymizeResult {
  /** The text with every detected entity replaced by a bracketed placeholder. */
  anonymizedText: string;
  /** The raw analyzer spans (offsets into the ORIGINAL text). */
  entities: PresidioEntity[];
}

/**
 * The contract the redaction service depends on. Implementations MUST reject
 * (never resolve with partial/raw text) when the backend is unreachable so the
 * caller can fail closed.
 */
export interface PresidioAnonymizer {
  anonymize(text: string, opts?: { language?: string }): Promise<PresidioAnonymizeResult>;
}

/**
 * Thrown for every unavailability mode: unconfigured, connection error, non-2xx
 * response, timeout, or malformed JSON. The redaction path maps this to a
 * quarantine with reason {@link PRESIDIO_UNAVAILABLE_SIGNAL}.
 */
export class PresidioUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PresidioUnavailableError';
  }
}

/** Residual-signal / audit reason recorded when Presidio fails closed. */
export const PRESIDIO_UNAVAILABLE_SIGNAL = 'presidio_unavailable';

export interface PresidioClientOptions {
  analyzerUrl: string;
  anonymizerUrl: string;
  /** Per-request timeout in ms (connect + response). Defaults to 5000. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Default analyzer language. Defaults to 'en'. */
  defaultLanguage?: string;
}

interface AnalyzerResponseItem {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

interface AnonymizerResponse {
  text: string;
}

/**
 * HTTP implementation of {@link PresidioAnonymizer} against the standard
 * Presidio Analyzer + Anonymizer REST APIs.
 */
export class HttpPresidioClient implements PresidioAnonymizer {
  private readonly analyzerUrl: string;
  private readonly anonymizerUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly defaultLanguage: string;

  constructor(opts: PresidioClientOptions) {
    this.analyzerUrl = opts.analyzerUrl.replace(/\/+$/, '');
    this.anonymizerUrl = opts.anonymizerUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.defaultLanguage = opts.defaultLanguage ?? 'en';
  }

  async anonymize(
    text: string,
    opts: { language?: string } = {},
  ): Promise<PresidioAnonymizeResult> {
    // Empty / whitespace-only input has nothing to redact — skip both HTTP
    // round-trips rather than paying (and potentially failing on) two network
    // calls for a no-op.
    if (!text.trim()) {
      return { anonymizedText: text, entities: [] };
    }
    const language = opts.language ?? this.defaultLanguage;
    const analyzerResults = await this.analyze(text, language);
    const entities: PresidioEntity[] = analyzerResults.map((item) => ({
      entityType: item.entity_type,
      start: item.start,
      end: item.end,
      score: item.score,
    }));

    // No entities → nothing to anonymize. Skip the second round-trip; the
    // original text is already clean per Presidio, and the downstream scrubPii
    // pass still runs as defense in depth.
    if (analyzerResults.length === 0) {
      return { anonymizedText: text, entities };
    }

    const anonymizedText = await this.anonymizeSpans(text, analyzerResults);
    return { anonymizedText, entities };
  }

  private async analyze(text: string, language: string): Promise<AnalyzerResponseItem[]> {
    const body = await this.post(
      `${this.analyzerUrl}/analyze`,
      { text, language },
      'analyze',
    );
    if (!Array.isArray(body)) {
      throw new PresidioUnavailableError(
        `Presidio analyze returned a non-array body (got ${typeof body})`,
      );
    }
    for (const item of body as unknown[]) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as AnalyzerResponseItem).entity_type !== 'string' ||
        typeof (item as AnalyzerResponseItem).start !== 'number' ||
        (item as AnalyzerResponseItem).start < 0 ||
        typeof (item as AnalyzerResponseItem).end !== 'number' ||
        (item as AnalyzerResponseItem).end < (item as AnalyzerResponseItem).start ||
        typeof (item as AnalyzerResponseItem).score !== 'number' ||
        Number.isNaN((item as AnalyzerResponseItem).score)
      ) {
        throw new PresidioUnavailableError('Presidio analyze returned a malformed span');
      }
    }
    return body as AnalyzerResponseItem[];
  }

  private async anonymizeSpans(
    text: string,
    analyzerResults: AnalyzerResponseItem[],
  ): Promise<string> {
    // Build a per-entity-type "replace" anonymizer so each span becomes an
    // uppercase bracketed placeholder (e.g. [PHONE_NUMBER]). Bracketed
    // ALL-CAPS tokens are exactly what the residual-PII gate strips before
    // its heuristics run, so Presidio's output composes cleanly with the
    // deterministic sweep.
    // Object.create(null): entity_type comes from an external service, so a
    // prototype-less dictionary prevents a hostile/buggy entity name like
    // "__proto__" or "constructor" from polluting or shadowing Object.prototype.
    const anonymizers: Record<string, { type: string; new_value: string }> =
      Object.create(null);
    anonymizers.DEFAULT = { type: 'replace', new_value: '[REDACTED]' };
    for (const item of analyzerResults) {
      anonymizers[item.entity_type] = {
        type: 'replace',
        new_value: `[${item.entity_type}]`,
      };
    }
    const body = await this.post(
      `${this.anonymizerUrl}/anonymize`,
      {
        text,
        analyzer_results: analyzerResults.map((item) => ({
          entity_type: item.entity_type,
          start: item.start,
          end: item.end,
          score: item.score,
        })),
        anonymizers,
      },
      'anonymize',
    );
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as AnonymizerResponse).text !== 'string'
    ) {
      throw new PresidioUnavailableError('Presidio anonymize returned a malformed body');
    }
    return (body as AnonymizerResponse).text;
  }

  private async post(url: string, payload: unknown, label: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Connection refused, DNS failure, or the AbortSignal timeout all land
      // here — every one is an unavailability we must fail closed on.
      throw new PresidioUnavailableError(
        `Presidio ${label} request failed (network/timeout)`,
        err,
      );
    }
    if (!res.ok) {
      throw new PresidioUnavailableError(
        `Presidio ${label} returned HTTP ${res.status}`,
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new PresidioUnavailableError(
        `Presidio ${label} returned malformed JSON`,
        err,
      );
    }
  }
}

export interface PresidioConfig {
  PRESIDIO_ANALYZER_URL?: string;
  PRESIDIO_ANONYMIZER_URL?: string;
}

/**
 * Build a Presidio client from config, or return null when the analyzer +
 * anonymizer URLs are not both configured. A null return means the redaction
 * service runs in local-only mode (dev / test); production wiring that wants
 * fail-closed compliance MUST set both URLs.
 */
export function createPresidioAnonymizer(
  config: PresidioConfig,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): PresidioAnonymizer | null {
  // Trim: an env var configured with stray whitespace would pass the presence
  // check but fail at connect time. (The fields are genuinely optional in the
  // config schema, so the optional chaining here is presence handling, not
  // defensive masking.)
  const analyzerUrl = config.PRESIDIO_ANALYZER_URL?.trim();
  const anonymizerUrl = config.PRESIDIO_ANONYMIZER_URL?.trim();
  if (!analyzerUrl || !anonymizerUrl) {
    return null;
  }
  return new HttpPresidioClient({
    analyzerUrl,
    anonymizerUrl,
    timeoutMs: opts.timeoutMs,
    fetchFn: opts.fetchFn,
  });
}
