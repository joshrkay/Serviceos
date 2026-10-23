/**
 * #1737 — abuse controls for the unauthenticated web chat path.
 *
 *  - {@link SlidingWindowLimiter}: in-process per-key limiter (per IP, per
 *    session). It sits BEHIND the shared-Redis express-rate-limit bucket the
 *    app mounts on the route, so a single replica cannot be walked past its
 *    own cap and a cluster still shares the coarse per-IP bucket.
 *  - {@link BotVerifier}: the bot-protection hook. Production wires the
 *    Cloudflare Turnstile verifier when `WEBCHAT_TURNSTILE_SECRET` is set;
 *    with no verifier the honeypot + limits + origin allow-list still apply.
 */

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Record one hit; false when the key is over its cap for the window. */
  allow(key: string, nowMs: number): boolean {
    const floor = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > floor);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.delete(key); // re-insert last so eviction order follows recency
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return true;
  }
}

export interface BotVerifier {
  /** True when the visitor passed the challenge. Called once per new session. */
  verify(args: { token: string | undefined; ip: string | undefined }): Promise<boolean>;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare Turnstile server-side verification. Fails CLOSED on any error. */
export function createTurnstileVerifier(
  secret: string,
  fetchImpl: typeof fetch = fetch,
): BotVerifier {
  return {
    async verify({ token, ip }) {
      if (!token) return false;
      try {
        const body = new URLSearchParams({ secret, response: token });
        if (ip) body.set('remoteip', ip);
        const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body });
        if (!res.ok) return false;
        const json = (await res.json()) as { success?: boolean };
        return json.success === true;
      } catch {
        return false;
      }
    },
  };
}
