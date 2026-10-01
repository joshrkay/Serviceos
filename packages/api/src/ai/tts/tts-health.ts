import type { TtsProbeResult, TtsProvider } from './tts-provider';

/**
 * #1536 — what the health endpoint reports about TTS beyond "a key is set".
 *  - ok          — the provider probe proved the key can synthesize
 *  - failed      — the provider refused/could not be reached; `reason` says why
 *  - unknown     — no verdict yet (probe still running past the health deadline)
 *  - config_only — the provider has no probe; only configuration was checked
 */
export interface TtsHealthState {
  status: 'ok' | 'failed' | 'unknown' | 'config_only';
  reason?: string;
}

export interface TtsHealthCheck {
  check(): Promise<TtsHealthState>;
}

/** Default verdict lifetime: a probe costs a provider call, so at most one per window. */
export const TTS_HEALTH_TTL_MS = 10 * 60_000;

/** The health endpoint never waits longer than this for a fresh verdict. */
export const TTS_HEALTH_RESPONSE_DEADLINE_MS = 1_500;
/** A probe that has not answered by now counts as `unreachable`. */
export const TTS_PROBE_TIMEOUT_MS = 8_000;

export interface TtsHealthCheckOpts {
  provider: TtsProvider | undefined;
  /** How long a verdict is reused before the provider is probed again. */
  ttlMs?: number;
  /**
   * Max time `check()` waits on an in-flight probe. Past it, `check()`
   * answers `unknown` and the probe keeps running, caching its verdict for
   * the next hit — a slow provider never slows the health endpoint.
   */
  responseDeadlineMs?: number;
  /** Hard bound on one probe (aborts it); a timeout is `unreachable`. */
  probeTimeoutMs?: number;
  /** Test seam: clock. */
  now?: () => number;
}

export function createTtsHealthCheck(opts: TtsHealthCheckOpts): TtsHealthCheck {
  const { provider } = opts;
  const ttlMs = opts.ttlMs ?? TTS_HEALTH_TTL_MS;
  const now = opts.now ?? Date.now;
  const responseDeadlineMs = opts.responseDeadlineMs ?? TTS_HEALTH_RESPONSE_DEADLINE_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? TTS_PROBE_TIMEOUT_MS;
  let cached: { state: TtsHealthState; at: number } | null = null;
  let inFlight: Promise<TtsHealthState> | null = null;

  const runProbe = (probe: NonNullable<TtsProvider['probe']>): Promise<TtsHealthState> => {
    inFlight ??= boundedProbe(probe, probeTimeoutMs)
      .then((result): TtsHealthState => (result.ok ? { status: 'ok' } : { status: 'failed', reason: result.reason }))
      .catch((): TtsHealthState => ({ status: 'failed', reason: 'unreachable' }))
      .then((state) => {
        cached = { state, at: now() };
        inFlight = null;
        return state;
      });
    return inFlight;
  };

  return {
    async check() {
      if (!provider || typeof provider.probe !== 'function') return { status: 'config_only' };
      if (cached && now() - cached.at < ttlMs) return cached.state;
      return withDeadline(runProbe(provider.probe.bind(provider)), responseDeadlineMs, {
        status: 'unknown',
        reason: 'probe_pending',
      });
    },
  };
}

function boundedProbe(probe: NonNullable<TtsProvider['probe']>, timeoutMs: number): Promise<TtsProbeResult> {
  const controller = new AbortController();
  return withDeadline(probe(controller.signal), timeoutMs, { ok: false, reason: 'unreachable' } as TtsProbeResult)
    .finally(() => controller.abort());
}

/** Resolves with `promise`, or with `fallback` once `ms` elapses (whichever first). */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
