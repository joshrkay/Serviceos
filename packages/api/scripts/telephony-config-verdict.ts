import type { TelephonyHealthReport } from '../src/routes/telephony';

export interface ConfigCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConfigVerdict {
  ok: boolean;
  checks: ConfigCheck[];
  warnings: string[];
}

/**
 * Pure interpretation of `GET /api/telephony/health` for the three
 * capability gates that decide whether SMS and click-to-call actually
 * work in prod.
 *
 * Deliberately stricter than the endpoint's own `ok` flag: that flag is
 * `(!mediaStreams || (stt && tts)) && database && llmGateway` (see the
 * getHealth() report in app.ts) and treats a missing message-delivery
 * provider or an unset PUBLIC_API_URL as a *warning only*. So a deploy
 * that 503s every SMS reply, or can't bridge a click-to-call, still
 * reports `ok: true` — which is exactly why `smoke-test`'s telephony
 * probe is not sufficient to confirm SMS/call config.
 */
export function evaluateTelephonyConfig(report: TelephonyHealthReport): ConfigVerdict {
  const caps = report?.capabilities;
  const cfg = report?.config;
  const warnings = report?.warnings ?? [];

  // Defensive: an older deploy (or the wrong host) may not return the
  // structured shape. Fail loudly rather than silently pass on `{}`.
  if (!caps || !cfg) {
    return {
      ok: false,
      warnings,
      checks: [
        {
          name: 'health-shape',
          ok: false,
          detail:
            'health payload missing capabilities/config — endpoint older than this verifier, ' +
            'or the URL is not the API origin',
        },
      ],
    };
  }

  const checks: ConfigCheck[] = [];

  // Outgoing SMS + email. messageDelivery is built only when all five
  // global creds are set (app.ts); in prod any missing one makes the
  // provider null and every reply / estimate-send / invoice-send 503s.
  checks.push({
    name: 'outgoing-sms-email',
    ok: caps.messageDelivery === true,
    detail: caps.messageDelivery
      ? 'message-delivery provider wired'
      : 'OFF — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ' +
        'SENDGRID_API_KEY, SENDGRID_FROM_EMAIL (any missing → replies/sends 503)',
  });

  // Click-to-call + inbound webhooks. Twilio calls back
  // {PUBLIC_API_URL}/api/calls/bridge; an unset origin makes the bridge
  // unreachable and click-to-call 503s.
  const publicUrl = typeof cfg.publicBaseUrl === 'string' ? cfg.publicBaseUrl.trim() : '';
  checks.push({
    name: 'click-to-call-host',
    ok: publicUrl.length > 0,
    detail:
      publicUrl.length > 0
        ? `PUBLIC_API_URL=${publicUrl}`
        : 'OFF — set PUBLIC_API_URL to the public API origin (not the web URL)',
  });

  // Persistence: threads + per-tenant Twilio credential resolution both
  // require the pool.
  checks.push({
    name: 'database',
    ok: caps.database === true,
    detail: caps.database
      ? 'database reachable'
      : 'OFF — set DATABASE_URL (threading + per-tenant Twilio creds depend on it)',
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    warnings,
  };
}
