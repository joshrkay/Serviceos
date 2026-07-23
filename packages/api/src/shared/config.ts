import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z
    .enum(['dev', 'staging', 'prod', 'development', 'production', 'test'])
    .default('dev')
    .transform((v) => {
      if (v === 'development') return 'dev';
      if (v === 'production') return 'prod';
      return v as 'dev' | 'staging' | 'prod' | 'test';
    }),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  CLERK_JWKS_URL: z.string().url().optional(),
  // P0-033 — gate for the legacy HMAC-SHA256 dev path in `verifyClerkSession`.
  // Only honoured when explicitly set to the literal string 'true'. Refused
  // in production by `validateEnvSchema` so a misconfigured prod can't
  // silently fall back to HMAC.
  CLERK_DEV_HMAC_TOKENS: z.string().optional(),
  // Cloudflare R2 — S3-compatible object storage for file uploads
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('serviceos-uploads'),
  R2_PUBLIC_URL: z.string().url().optional(),
  AI_PROVIDER_API_KEY: z.string().min(1).optional(),
  AI_PROVIDER_BASE_URL: z.string().url().optional(),
  /** Optional dual-provider failover (FM-03). Both key+URL required to activate. */
  AI_FALLBACK_PROVIDER_API_KEY: z.string().min(1).optional(),
  AI_FALLBACK_PROVIDER_BASE_URL: z.string().url().optional(),
  AI_FALLBACK_LIGHTWEIGHT_MODEL: z.string().min(1).optional(),
  AI_FALLBACK_STANDARD_MODEL: z.string().min(1).optional(),
  AI_FALLBACK_COMPLEX_MODEL: z.string().min(1).optional(),
  AI_DEFAULT_MODEL: z.string().default('gpt-4o-mini'),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  STRIPE_API_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  WEB_URL: z.string().url().optional().default('http://localhost:5173'),
  STRIPE_PRICE_ID: z.string().optional(),
  // TCPA/DNC express-consent enforcement for the outbound calling path.
  // 'off' (default) preserves prior behavior exactly (DNC opt-out check only);
  // 'warn' runs the per-customer consent gate and audits+logs a would-be block
  // but still places the call (observability); 'block' refuses calls to numbers
  // without express consent on file. Off-by-default so production behavior is
  // unchanged until an operator explicitly opts in.
  TCPA_CONSENT_ENFORCEMENT: z.enum(['off', 'warn', 'block']).default('off'),
  // WS2 — process-role split. One image, up to three Railway services: 'web'
  // serves the HTTP/voice/WS surface only, 'worker' runs the background sweeps
  // + queue poll loop only, 'all' (default) runs both — byte-for-byte
  // back-compat with the single-service deploy. See docs/deployment.md
  // "Deploy topology (web + worker)".
  // WS14 — 'voice' is a THIRD, opt-in role: a dedicated telephony-webhook +
  // media-streams-WS service that deploys rarely, so Twilio's phone-number
  // webhooks can point at a domain web/worker deploys never touch (live
  // calls no longer ride the web service's 25s drain window). It serves the
  // full HTTP surface — same as 'web' (Railway can't path-route, and it
  // needs /health plus the telephony/gather/recording webhooks reachable;
  // other routes existing on it is harmless since nothing points at them)
  // — and attaches the media-streams WS, exactly like 'web' does. It runs
  // ZERO background worker loops, same as 'web'.
  // 'web' never starts the background interval loops; neither does 'voice'.
  // Every other role ('worker', 'all') does.
  //
  // Companion env var (read raw from process.env, same pattern as
  // PUBLIC_API_URL — intentionally NOT in this schema): VOICE_PUBLIC_URL is
  // the dedicated voice service's public base URL, set on the WEB and WORKER
  // services (where provisioning jobs execute). The Twilio number-provisioning
  // worker (workers/provision-twilio.ts) uses it for the number's VoiceUrl +
  // voice status callback so newly-provisioned numbers point at the voice
  // domain; unset ⇒ single/two-service topology ⇒ falls back to the job's
  // baseUrl (PUBLIC_API_URL at enqueue time). SMS + Vapi webhooks always stay
  // on the web domain. See docs/deployment.md + docs/prod-env-checklist.md.
  PROCESS_ROLE: z.enum(['web', 'worker', 'voice', 'all']).default('all'),
  // SEC-01 / WS1 — Postgres RLS runtime-role enforcement flag. Read raw today
  // by db/rls-runtime-role.ts (isRlsRuntimeRoleEnabled); declared here so it is
  // part of the validated config surface. The HARD prod/staging requirement
  // (must be 'true') is enforced in validateFeatureRequiredConfig above — this
  // schema entry only types/normalizes the value.
  RLS_RUNTIME_ROLE: z.enum(['true', 'false']).optional(),
  // D-015 amendment — platform-wide kill switch for the autonomous booking
  // lane. 'true' short-circuits evaluateAutonomousBookingLane before the
  // per-tenant opt-in check, regardless of any tenant's
  // autonomous_booking_enabled setting. Absent/'false' preserves today's
  // per-tenant-only gating — no prod requirement.
  AUTONOMOUS_BOOKING_DISABLED: z.enum(['true', 'false']).optional(),
  // D-018 → DEPRECATED by D-019 (QUALITY-2026-07-12 WS2). There is no longer
  // any autonomous CLOSE execution to disable — the on-call close only ever
  // STAGES proposals for owner one-tap approval (nothing is system-approved or
  // executed). Still accepted (and independent of AUTONOMOUS_BOOKING_DISABLED)
  // as a platform-wide off switch for even PREPARING the owner-approval chain:
  // 'true' short-circuits evaluateAutonomousCloseLane so the affirmative falls
  // back to the plain owner-finalizes interim. Absent/'false' is the default —
  // no prod requirement.
  AUTONOMOUS_CLOSE_DISABLED: z.enum(['true', 'false']).optional(),
  // ── WS15 — platform SLO monitor thresholds (workers/slo-monitor.ts). All
  // optional with safe defaults; documented in .env.production.example and
  // docs/runbooks/slo-alerts.md. No prod hard-requirement — the monitor runs
  // with defaults and pages via Sentry (SENTRY_DSN) and, when set, ALERT_SMS_TO.
  //
  // Minimum acceptable call completion rate over the trailing 60 min (0..1).
  SLO_CALL_COMPLETION_MIN: z.coerce.number().min(0).max(1).default(0.85),
  // Ended-call sample floor: below this many calls in the window the
  // completion rule never breaches (avoids 1-call false pages).
  SLO_CALL_COMPLETION_MIN_SAMPLE: z.coerce.number().int().positive().default(5),
  // Pending queue jobs older than this many minutes count as stale (breach).
  SLO_QUEUE_STALE_MIN: z.coerce.number().positive().default(15),
  // Sweep-heartbeat age (minutes) above which the worker loop is presumed wedged.
  SLO_SWEEP_LAG_MIN: z.coerce.number().positive().default(15),
  // WS26 — voice turn-latency P95 breach threshold (ms): STT-final → first TTS
  // chunk on the media-streams path. Only evaluated in-process under
  // PROCESS_ROLE=all; split topologies alert via Prometheus (see slo-alerts.md).
  SLO_TURN_LATENCY_P95_MS: z.coerce.number().positive().default(3500),
  // WS26 — minimum recorded turns before the turn-latency rule can breach.
  SLO_TURN_LATENCY_MIN_SAMPLE: z.coerce.number().int().positive().default(30),
  // Per-rule alert cooldown (minutes) — a persistent breach re-pages at most
  // once per cooldown window, not every monitor tick.
  SLO_ALERT_COOLDOWN_MIN: z.coerce.number().positive().default(60),
  // Operator phone (E.164) for SLO breach SMS pages. Unset → Sentry-only.
  ALERT_SMS_TO: z.string().min(1).optional(),
  // QUALITY-2026-07-12 WS5 — Microsoft Presidio PII redaction backend for
  // training-asset ingestion. Two separate REST services (matching Presidio's
  // standard deployment): the Analyzer detects PII spans, the Anonymizer
  // replaces them. Both must be set to enable the Presidio-first redaction
  // pass; when set, an unreachable backend FAILS CLOSED (asset quarantined,
  // never persisted with raw / regex-only text). Unset ⇒ local deterministic
  // scrub only (dev/test). See ai/privacy/presidio-adapter.ts.
  PRESIDIO_ANALYZER_URL: z.string().url().optional(),
  PRESIDIO_ANONYMIZER_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  if (cachedConfig) return cachedConfig;

  // GitHub Actions injects unset `secrets.*` references as empty strings
  // rather than leaving them unset. For env-vars declared `.min(1).optional()`
  // an empty string fails validation, but the intent is "absent". Coerce
  // empty strings to undefined so secret-not-configured behaves the same
  // as variable-not-set.
  const normalized: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    normalized[k] = v === '' ? undefined : v;
  }

  const result = configSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.message}`
    );
    throw new Error(`Configuration validation failed:\n${issues.join('\n')}`);
  }

  cachedConfig = result.data;

  // WS1 — prod/staging default the consent gate to enforcement. The zod default
  // is 'off' (safe for dev/test), but in production a send must fail closed
  // unless an operator has EXPLICITLY set the value. So: when unset in
  // prod/staging, resolve to 'block'. An explicit 'off' (or 'warn') is honored.
  // This same value drives BOTH the voice consent gate and the SMS gate.
  if (
    (cachedConfig.NODE_ENV === 'prod' || cachedConfig.NODE_ENV === 'staging') &&
    normalized.TCPA_CONSENT_ENFORCEMENT === undefined
  ) {
    cachedConfig.TCPA_CONSENT_ENFORCEMENT = 'block';
  }

  // Enforce required config in production environments
  if (cachedConfig.NODE_ENV === 'prod' || cachedConfig.NODE_ENV === 'staging') {
    validateProductionConfig(cachedConfig);
    validateFeatureRequiredConfig(env);
  }

  return cachedConfig;
}

/**
 * Validates that all required production configuration is present.
 * Throws on missing critical env vars that have no safe default.
 */
function validateProductionConfig(config: AppConfig): void {
  const missing: string[] = [];

  // Database — must have either DATABASE_URL or explicit host/name/user/password
  if (!config.DATABASE_URL) {
    if (!config.DB_HOST) missing.push('DB_HOST (or DATABASE_URL)');
    if (!config.DB_NAME) missing.push('DB_NAME (or DATABASE_URL)');
    if (!config.DB_USER) missing.push('DB_USER (or DATABASE_URL)');
    if (!config.DB_PASSWORD) missing.push('DB_PASSWORD (or DATABASE_URL)');
  }

  // Auth — both keys are required. The publishable key is used at request time
  // to derive the Clerk JWKS host; without it every authenticated request 401s
  // (P0-033). Fail fast at startup instead of waiting for the first request.
  if (!config.CLERK_SECRET_KEY) missing.push('CLERK_SECRET_KEY');
  if (!config.CLERK_PUBLISHABLE_KEY) missing.push('CLERK_PUBLISHABLE_KEY');

  // Webhooks — signing secrets required to verify inbound webhooks.
  // SEC-43: CLERK gates tenant bootstrap; STRIPE gates payment confirmation
  // (billing is core — every prod tenant takes card payments). Without
  // STRIPE_WEBHOOK_SECRET the Stripe handler 400s/503s on the first real
  // event, so Stripe shows "paid" while the invoice never settles. Fail fast
  // at boot instead. (WISETACK_WEBHOOK_SECRET is financing-gated — see the
  // feature-required gate below — because financing is opt-in per tenant.)
  if (!config.CLERK_WEBHOOK_SECRET) missing.push('CLERK_WEBHOOK_SECRET');
  if (!config.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');

  // AI provider
  if (!config.AI_PROVIDER_API_KEY) missing.push('AI_PROVIDER_API_KEY');

  // CORS — must be an explicit origin, not the wildcard fallback
  if (!config.CORS_ORIGIN) missing.push('CORS_ORIGIN');

  // NOTE (P5-017): Stripe payment-link key (STRIPE_SECRET_KEY / STRIPE_API_KEY)
  // is enforced at boot by `createPaymentLinkProvider` in
  // `payments/payment-link-provider.ts` rather than here, because the
  // existing AC#1 test surface in `config.test.ts` is fixed and the
  // payment-link factory provides an equivalent fail-fast guard.

  if (missing.length > 0) {
    throw new Error(
      `Production configuration is missing required values:\n  ${missing.join('\n  ')}\n` +
        'Set these environment variables before starting in production.'
    );
  }
}

/**
 * P7-023 follow-up — feature-required config gate.
 *
 * Today the app reads TWILIO_* / SENDGRID_* / R2_* directly from
 * process.env in `app.ts` and conditionally wires the providers when
 * present. Missing vars previously caused silent feature degradation
 * (SMS no-ops, recordings drop, invoice email never sends) with no
 * boot signal. This gate flips that to fail-loud-by-default in
 * production / staging: each feature bundle is required unless the
 * operator has explicitly opted out via a `<FEATURE>_ENABLED=false`
 * flag. The error message names every missing var so an operator can
 * fix it directly.
 */
function validateFeatureRequiredConfig(env: Record<string, string | undefined>): void {
  const missing: string[] = [];

  const telephonyEnabled = env.TELEPHONY_ENABLED !== 'false';
  const emailEnabled = env.EMAIL_ENABLED !== 'false';
  const storageEnabled = env.STORAGE_ENABLED !== 'false';

  // Twilio credentials are shared between telephony (voice + SMS) and
  // the email path. TwilioDeliveryProvider in app.ts couples SMS +
  // SendGrid into a single delivery service: without TWILIO_*, the
  // delivery provider is null and /invoices/:id/send + /estimates/:id/send
  // return 503 even when SendGrid is configured. So Twilio is required
  // whenever either feature is enabled, with a message that names the
  // opt-out flag(s) the operator can flip.
  if (telephonyEnabled || emailEnabled) {
    const optOut =
      telephonyEnabled && emailEnabled
        ? '(or set both TELEPHONY_ENABLED=false and EMAIL_ENABLED=false)'
        : telephonyEnabled
          ? '(or set TELEPHONY_ENABLED=false)'
          : '(or set EMAIL_ENABLED=false)';
    if (!env.TWILIO_ACCOUNT_SID) missing.push(`TWILIO_ACCOUNT_SID ${optOut}`);
    if (!env.TWILIO_AUTH_TOKEN) missing.push(`TWILIO_AUTH_TOKEN ${optOut}`);
    if (!env.TWILIO_FROM_NUMBER) missing.push(`TWILIO_FROM_NUMBER ${optOut}`);
  }

  // Default tenant id is required when telephony is on so inbound
  // calls resolve to a tenant before the multi-tenant phone-lookup
  // ships (B1 in the launch readiness plan).
  if (telephonyEnabled && !env.TWILIO_DEFAULT_TENANT_ID) {
    missing.push('TWILIO_DEFAULT_TENANT_ID (or set TELEPHONY_ENABLED=false)');
  }

  // SendGrid credentials — invoice + estimate delivery email side.
  if (emailEnabled) {
    if (!env.SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY (or set EMAIL_ENABLED=false)');
    if (!env.SENDGRID_FROM_EMAIL) missing.push('SENDGRID_FROM_EMAIL (or set EMAIL_ENABLED=false)');
  }

  // Object storage — voice recordings, file/job uploads via Cloudflare R2.
  // R2_PUBLIC_URL is intentionally NOT required: S3StorageProvider
  // falls back to presigned GET URLs when publicUrlBase is unset
  // (see files/storage-provider.ts:159), so storage works without it.
  if (storageEnabled) {
    if (!env.R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID (or set STORAGE_ENABLED=false)');
    if (!env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID (or set STORAGE_ENABLED=false)');
    if (!env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY (or set STORAGE_ENABLED=false)');
  }

  // Voice Media Streams (Twilio bidirectional audio) require a raw-PCM-capable
  // TTS path. The media-streams adapter feeds the TTS output straight into a
  // PCM16 -> mu-law encoder with no decoder, so only the ElevenLabs *streaming*
  // provider (synthesizeStream, raw PCM) is safe. OpenAI tts-1 — the default
  // when TTS_PROVIDER is unset — returns mp3, which plays as inaudible static
  // on every call (VOX-30). Opt-IN flag (unlike the opt-out features above), so
  // only enforced when explicitly enabled. The createApp() boot guard
  // (assertTtsProviderSupportsMediaStreams) is a second, later layer; this
  // fails earlier and also catches the missing-key silent-no-audio case.
  const mediaStreamsEnabled = env.TWILIO_MEDIA_STREAMS_ENABLED === 'true';
  if (mediaStreamsEnabled) {
    if (env.TTS_PROVIDER !== 'elevenlabs') {
      missing.push(
        'TTS_PROVIDER=elevenlabs (required by TWILIO_MEDIA_STREAMS_ENABLED=true — only the ' +
          'ElevenLabs streaming provider emits raw PCM; OpenAI/unset returns mp3 that plays as ' +
          'static; or set TWILIO_MEDIA_STREAMS_ENABLED=false)'
      );
    }
    if (!env.ELEVENLABS_API_KEY) {
      missing.push(
        'ELEVENLABS_API_KEY (required by TWILIO_MEDIA_STREAMS_ENABLED=true; or set TWILIO_MEDIA_STREAMS_ENABLED=false)'
      );
    }
  }

  // SEC-43 — Wisetack financing webhook secret, gated on financing being on.
  // Financing is OPT-IN per tenant: createFinancingProvider() only builds the
  // live Wisetack client when WISETACK_API_KEY is present (else it falls back
  // to the Manual provider), so we must NOT force Wisetack config on tenants
  // that don't offer financing. But when financing IS wired, the webhook secret
  // is required — without it the Wisetack status webhook 500s and approvals/
  // declines silently stop updating (customer approved, invoice never reflects
  // it). Enabled when WISETACK_API_KEY is set, or explicitly via
  // FINANCING_ENABLED=true. Names the opt-out so an operator can fix it.
  const financingEnabled =
    env.FINANCING_ENABLED === 'true' || Boolean(env.WISETACK_API_KEY);
  if (financingEnabled && !env.WISETACK_WEBHOOK_SECRET) {
    missing.push(
      'WISETACK_WEBHOOK_SECRET (required when financing is enabled via ' +
        'WISETACK_API_KEY / FINANCING_ENABLED=true — verifies inbound Wisetack ' +
        'status webhooks; unset it only if you disable financing)'
    );
  }

  // SEC-01 — RLS runtime-role enforcement is a HARD prod/staging requirement.
  // Postgres Row-Level Security is a runtime NO-OP unless the app drops to the
  // least-privilege, RLS-subject `rls_app_runtime` role for tenant-scoped queries,
  // which only happens when RLS_RUNTIME_ROLE=true (see db/rls-runtime-role.ts).
  // Without it, a single forgotten `tenant_id` filter silently crosses tenants —
  // tenant isolation would rest solely on app-layer filters. Unlike the feature
  // bundles above there is NO opt-out flag: shipping prod/staging with RLS
  // unenforced is not permitted. The boot probe `verifyRlsRuntimeRole` fails fast
  // if the `rls_app_runtime` role is unprovisioned, so requiring the flag can
  // never silently ship a broken RLS state — provision the role first (migration
  // 217 / docs/runbooks/rls-runtime-role-rollout.md), then set the flag.
  if (env.RLS_RUNTIME_ROLE !== 'true') {
    missing.push(
      'RLS_RUNTIME_ROLE=true (Postgres RLS enforcement — makes tenant-isolation ' +
        'policies actually enforce; requires the rls_app_runtime role from migration ' +
        '217; see docs/runbooks/rls-runtime-role-rollout.md)'
    );
  }

  // ARCH-01 — REDIS_URL is a HARD requirement once the app runs on more than
  // one replica. Redis is otherwise entirely optional: createRedisClient()
  // returns null when REDIS_URL is unset/unreachable and every shared-state
  // store FAILS OPEN to a per-replica in-memory path (rate-limit-store.ts,
  // ws/redis-connection-registry.ts, ai/gateway/redis-tenant-quota.ts,
  // dispatch presence + fan-out). That is correct for the single-replica
  // deploy, but if numReplicas is raised past 1 without a shared Redis, every
  // one of those stores silently degrades to per-process memory: rate limits
  // become N× the configured limit, LLM per-tenant quota and WS connection
  // caps stop being global, and voice/dispatch fan-out no longer crosses
  // replicas — with no boot error and no health-check failure. The operator
  // signals the replica count to the app via NUM_REPLICAS (kept in step with
  // railway.toml's numReplicas); when it is >1 we require REDIS_URL so the
  // degradation can never ship silently. Absent/unparseable/≤1 → single
  // replica, unchanged (the current no-Redis prod deploy still boots).
  const numReplicas = Number.parseInt(env.NUM_REPLICAS ?? '', 10);
  if (Number.isFinite(numReplicas) && numReplicas > 1 && !env.REDIS_URL) {
    missing.push(
      `REDIS_URL (required when NUM_REPLICAS=${numReplicas} — with more than one ` +
        'replica and no shared Redis, rate limiting degrades to N× the configured ' +
        'limit, LLM tenant quota and WebSocket connection caps become per-process, ' +
        'and voice/dispatch fan-out stops crossing replicas, all silently; set ' +
        'REDIS_URL before raising numReplicas, or run a single replica)'
    );
  }

  // T4-F06 — TENANT_ENCRYPTION_KEY/TRANSCRIPT_ENCRYPTION_KEY are load-bearing
  // for tenant credential (integrations/credentials.ts, calendar-integration.ts,
  // accounting/token-crypto.ts, workers/provision-twilio.ts) and transcript-at-
  // rest (transcription.ts) encryption, but were previously validated ONLY at
  // first use, deep in integrations/crypto.ts's parseKey (64-hex-char/32-byte
  // contract) — a bad/missing key crashed on first decrypt/encrypt instead of
  // failing at boot. TENANT_ENCRYPTION_KEY is required in prod/staging (no
  // opt-out: every deploy resolves tenant credentials); TRANSCRIPT_ENCRYPTION_KEY
  // stays optional (transcription.ts falls back to TENANT_ENCRYPTION_KEY, see
  // app.ts) but is format-checked when set so a typo there fails at boot too.
  // A local regex (not importing integrations/crypto.ts) keeps this config
  // module's dependency direction unchanged — it runs before most modules are
  // wired.
  const HEX_64_KEY = /^[0-9a-f]{64}$/i;
  if (!env.TENANT_ENCRYPTION_KEY) {
    missing.push(
      'TENANT_ENCRYPTION_KEY (required in prod/staging — a 64-char hex string; ' +
        'encrypts tenant integration credentials, calendar/accounting tokens, and, ' +
        'by fallback, call transcripts at rest)'
    );
  } else if (!HEX_64_KEY.test(env.TENANT_ENCRYPTION_KEY)) {
    missing.push('TENANT_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  if (env.TRANSCRIPT_ENCRYPTION_KEY && !HEX_64_KEY.test(env.TRANSCRIPT_ENCRYPTION_KEY)) {
    missing.push('TRANSCRIPT_ENCRYPTION_KEY must be a 64-char hex string (32 bytes) when set');
  }

  if (missing.length > 0) {
    throw new Error(
      `Production feature configuration is missing required values:\n  ${missing.join('\n  ')}\n` +
        'Set these env vars before starting, or opt the feature out with the named flag.'
    );
  }
}

export function resetConfig(): void {
  cachedConfig = null;
}

/**
 * WS7 — resolve the effective media-streams (realtime voice) master switch.
 *
 * `TWILIO_MEDIA_STREAMS_ENABLED`:
 *   - `'true'`  → on. The hard-require validation in `validateProductionConfig`
 *     and the `assertTtsProviderSupportsMediaStreams` boot guard enforce a
 *     complete streaming stack (crash on a misconfigured provider/key).
 *   - `'false'` → off (kill switch).
 *   - unset / `'auto'` → on ONLY when the full streaming stack is already
 *     present: `TTS_PROVIDER === 'elevenlabs'` AND `ELEVENLABS_API_KEY` AND
 *     `DEEPGRAM_API_KEY`. Stricter than `realtimeCapabilities()` (which accepts
 *     `AI_PROVIDER_API_KEY` for TTS) so auto never boot-crashes on
 *     `assertTtsProviderSupportsMediaStreams` and never enables a half-capable
 *     (no-Deepgram) stack. A partial stack resolves off, unchanged.
 */
export function resolveMediaStreamsEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.TWILIO_MEDIA_STREAMS_ENABLED;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return (
    env.TTS_PROVIDER === 'elevenlabs' &&
    Boolean(env.ELEVENLABS_API_KEY) &&
    Boolean(env.DEEPGRAM_API_KEY)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-026 — Startup environment validation (Zod schema)
//
// `validateEnvSchema(env)` is a sibling to `loadConfig`/`validateProductionConfig`
// that returns a strongly typed, parsed `Env` object. It is the canonical entry
// point for fail-fast startup validation; existing call sites of `loadConfig`
// keep their current contract (we don't want to break `app.ts`).
//
// Required vars:           DATABASE_URL, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY,
//                          CORS_ORIGIN (not the literal 'true' in production),
//                          NODE_ENV
// Optional with defaults:  PORT (8080), LOG_LEVEL (info)
//
// In `NODE_ENV=development` (or `dev`/`test`) the Clerk and DATABASE_URL keys
// become optional so that local boot does not require production secrets.
// ─────────────────────────────────────────────────────────────────────────────

const envEnum = z.enum(['development', 'dev', 'test', 'staging', 'production', 'prod']);

const baseEnvShape = {
  NODE_ENV: envEnum.default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // P0-033 — legacy HMAC dev-token gate. Production refuses any value other
  // than absent/'false' (enforced via the prod refinement on the schema).
  CLERK_DEV_HMAC_TOKENS: z.string().optional(),
  // Unsigned-token local bypass (auth/dev-auth-bypass.ts). Runtime is already
  // hard-gated on NODE_ENV=dev|development; refuse at schema parse in prod too.
  DEV_AUTH_BYPASS: z.string().optional(),
  // Staging escape hatch: allow pk_test_/sk_test_ under NODE_ENV=production.
  // Production must use live keys unless this is explicitly 'true'.
  ALLOW_CLERK_TEST_KEYS: z.string().optional(),
} as const;

const devEnvSchema = z.object({
  ...baseEnvShape,
  // In dev, DATABASE_URL may be absent (in-memory repos) but if provided
  // it still must be a valid URL.
  DATABASE_URL: z
    .string()
    .url({ message: 'must be a valid URL (e.g. postgres://user:pass@host/db)' })
    .optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

/**
 * True when Clerk test-key prefixes are allowed under a production NODE_ENV
 * (staging-shaped deploys). Default: refuse — prod must use pk_live_/sk_live_.
 */
export function allowsClerkTestKeys(
  env: Record<string, string | undefined>,
): boolean {
  return env.ALLOW_CLERK_TEST_KEYS === 'true';
}

/** Reject pk_test_/sk_test_ in production unless ALLOW_CLERK_TEST_KEYS=true. */
export function assertClerkKeyPrefixesForProduction(
  env: Record<string, string | undefined>,
): void {
  if (allowsClerkTestKeys(env)) return;
  const pub = env.CLERK_PUBLISHABLE_KEY ?? '';
  const secret = env.CLERK_SECRET_KEY ?? '';
  const problems: string[] = [];
  if (pub.startsWith('pk_test_')) {
    problems.push(
      "CLERK_PUBLISHABLE_KEY: production requires pk_live_ (got pk_test_). " +
        'Use the Production Clerk instance, or set ALLOW_CLERK_TEST_KEYS=true for staging.',
    );
  }
  if (secret.startsWith('sk_test_')) {
    problems.push(
      "CLERK_SECRET_KEY: production requires sk_live_ (got sk_test_). " +
        'Use the Production Clerk instance, or set ALLOW_CLERK_TEST_KEYS=true for staging.',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Environment validation failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'See docs/runbooks/clerk-setup.md.',
    );
  }
}

const prodEnvSchema = z
  .object({
    ...baseEnvShape,
    DATABASE_URL: z
      .string({ required_error: 'Required' })
      .url({ message: 'must be a valid URL (e.g. postgres://user:pass@host/db)' }),
    CLERK_SECRET_KEY: z
      .string({ required_error: 'Required' })
      .min(1, { message: 'Required' }),
    CLERK_PUBLISHABLE_KEY: z
      .string({ required_error: 'Required' })
      .min(1, { message: 'Required' }),
    CORS_ORIGIN: z
      .string({ required_error: 'Required' })
      .min(1, { message: 'Required' })
      .refine((v) => v !== 'true', {
        message: "Cannot be 'true' in production. Set a specific origin.",
      }),
    // P0-033 — must NOT be 'true' in production. Other values (absent,
    // 'false', '0', anything else) are accepted as "off". The runtime gate
    // in `verifyClerkSession` is also production-disabled as defense in
    // depth, but failing fast at startup gives operators a clear signal.
    CLERK_DEV_HMAC_TOKENS: z
      .string()
      .optional()
      .refine((v) => v !== 'true', {
        message:
          "CLERK_DEV_HMAC_TOKENS=true is forbidden in production. Unset or set to 'false' before starting.",
      }),
    DEV_AUTH_BYPASS: z
      .string()
      .optional()
      .refine((v) => v !== 'true', {
        message:
          "DEV_AUTH_BYPASS=true is forbidden in production. Unset or set to 'false' before starting.",
      }),
  });

export type Env = z.infer<typeof devEnvSchema> & Partial<z.infer<typeof prodEnvSchema>>;

function isProductionEnv(value: string | undefined): boolean {
  return value === 'production' || value === 'prod';
}

/**
 * Parses and validates `process.env` against the runtime environment schema.
 *
 * @returns A frozen, typed `Env` object. Pure parse — calling twice with the
 *   same input yields equivalent objects (idempotent, no caching).
 * @throws Error with one line per missing/invalid var when validation fails.
 *   Each line names the variable so an operator can fix it directly.
 */
export function validateEnvSchema(
  env: Record<string, string | undefined> = process.env
): Env {
  const schema = isProductionEnv(env.NODE_ENV) ? prodEnvSchema : devEnvSchema;
  const result = schema.safeParse(env);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    });
    throw new Error(
      `Environment validation failed:\n${lines.join('\n')}\n` +
        'Set these environment variables before starting the service.'
    );
  }

  if (isProductionEnv(env.NODE_ENV)) {
    assertClerkKeyPrefixesForProduction(env);
  }

  return result.data as Env;
}

export interface SecretResolver {
  resolve(secretName: string): Promise<string>;
}

export class EnvironmentSecretResolver implements SecretResolver {
  async resolve(secretName: string): Promise<string> {
    const value = process.env[secretName];
    if (!value) {
      throw new Error(`Secret not found: ${secretName}`);
    }
    return value;
  }
}

// P0-006 — Secrets backend decision.
//
// The PRD suggested AWS Secrets Manager, but the project deploys on Railway,
// which natively encrypts environment variables at rest and supports rotation
// via the Railway dashboard. Swapping to AWS SM would add a second control
// plane without reducing risk, so EnvironmentSecretResolver is the canonical
// resolver in every environment.
//
// loadConfig() enforces that all required production secrets are set before
// the app boots (AC#1), and the logger redacts any secret-keyed values before
// emitting structured JSON (AC#2 — see logging/redact.ts).
export function createSecretResolver(_env: string): SecretResolver {
  return new EnvironmentSecretResolver();
}
