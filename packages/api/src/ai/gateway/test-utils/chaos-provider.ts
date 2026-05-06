/**
 * Programmable LLMProvider for chaos / fault injection.
 *
 * Wires latency, error injection, and partial-stream cuts behind a
 * single dial. Used by:
 *   - vitest specs that exercise the breaker / retry / fallback paths;
 *   - the k6 chaos harness via an admin endpoint gated by the
 *     CHAOS_PROVIDER_ENABLED env var (never on in production).
 */
import type { LLMProvider, LLMRequest, LLMResponse } from '../gateway';

export interface ChaosProfile {
  /** Mean injected latency in ms. */
  latencyMs?: number;
  /** Latency jitter in ms (±). */
  latencyJitterMs?: number;
  /** Probability of throwing a transient error per call. */
  transientErrorRate?: number;
  /** Probability of throwing a 429 rate-limit error per call. */
  rateLimitErrorRate?: number;
  /** Probability of throwing a 4xx permanent error per call. */
  permanentErrorRate?: number;
  /** Probability of timing out (never resolving until aborted). */
  timeoutRate?: number;
  /** Override the response content. */
  responseContent?: string;
  /** Counter of total calls made. */
  callCount?: number;
}

export class ChaosProvider implements LLMProvider {
  readonly name: string;
  private profile: ChaosProfile;
  callCount = 0;

  constructor(name: string = 'chaos', profile: ChaosProfile = {}) {
    this.name = name;
    this.profile = profile;
  }

  setProfile(profile: ChaosProfile): void {
    this.profile = profile;
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
    this.profile = {};
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    const p = this.profile;

    const latency =
      (p.latencyMs ?? 0) +
      (p.latencyJitterMs ? (Math.random() - 0.5) * 2 * p.latencyJitterMs : 0);
    if (latency > 0) {
      await this.sleep(latency, request.signal);
    }

    if (p.timeoutRate && Math.random() < p.timeoutRate) {
      // Wait until aborted or 30s.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 30_000);
        if (typeof t.unref === 'function') t.unref();
        request.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    }

    if (p.transientErrorRate && Math.random() < p.transientErrorRate) {
      const err: Error & { status?: number } = new Error('chaos: transient ECONNRESET');
      err.status = 503;
      throw err;
    }
    if (p.rateLimitErrorRate && Math.random() < p.rateLimitErrorRate) {
      const err: Error & { status?: number } = new Error('chaos: 429 rate limited');
      err.status = 429;
      throw err;
    }
    if (p.permanentErrorRate && Math.random() < p.permanentErrorRate) {
      const err: Error & { status?: number } = new Error('chaos: 400 bad request');
      err.status = 400;
      throw err;
    }

    return {
      content: p.responseContent ?? '{"chaos": true}',
      model: request.model ?? 'chaos-model',
      provider: this.name,
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: Math.max(0, latency),
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (typeof t.unref === 'function') t.unref();
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      });
    });
  }
}
