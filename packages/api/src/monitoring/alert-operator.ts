/**
 * WS15 — alert a HUMAN about a platform SLO breach.
 *
 * The app already exports Prometheus metrics, but nothing evaluated them or
 * contacted anyone. This module is the single "page the operator" seam:
 *
 *   - Sentry: always `captureMessage(..., 'error')` — with the Sentry→Slack/DM
 *     alert rules (docs/runbooks/alerting.md) this is the durable, always-on
 *     channel. No-op client when SENTRY_DSN is unset (dev).
 *   - SMS: when ALERT_SMS_TO is configured AND a MessageDeliveryProvider is
 *     wired, send an SMS with recipientClass 'owner' — the operator/on-call
 *     class that BYPASSES the GatedMessageDelivery consent+DNC gate (see
 *     notifications/delivery-provider.ts). A 'customer'-class send would fail
 *     closed (missing_consent_context) and silently suppress the page.
 *
 * Failure posture: NEVER throws into the caller (the SLO sweep / shutdown
 * path) — every channel failure is swallowed and logged, same posture as the
 * other best-effort emitters.
 *
 * Cooldown: per-rule, in-process (default 60 min via SLO_ALERT_COOLDOWN_MIN)
 * so a persistent breach re-evaluated every ~5 min doesn't re-page every tick.
 * MULTI-REPLICA CAVEAT: the cooldown Map is per-process. The SLO monitor runs
 * under a Postgres advisory leader lock, so it is effectively single-writer —
 * but a leader handoff (deploy, replica restart) lands on a process with an
 * empty Map and can double-page ONCE per rule. Accepted trade (comment kept
 * next to the Map below).
 */
import type { Logger } from '../logging/logger';
import type { SentryClient } from './sentry';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import { sloAlertsSentTotal, voiceDrainAbandonedCallsTotal } from './metrics';

export interface OperatorAlert {
  severity: 'warning' | 'critical';
  /** Stable rule key — also the cooldown key (e.g. 'call_completion_rate'). */
  rule: string;
  /** One-line human summary — becomes the Sentry message + SMS body lead. */
  summary: string;
  /** Structured context — appended to the SMS body and logged. */
  details?: Record<string, string | number>;
}

export interface AlertOperatorDeps {
  sentry: SentryClient;
  /** Null when no delivery provider is wired (dev) — SMS channel skipped. */
  delivery: MessageDeliveryProvider | null;
  /** E.164 operator number; unset/empty disables the SMS channel. */
  alertSmsTo?: string | undefined;
  cooldownMs: number;
  logger: Logger;
  now?: () => number;
}

export type AlertOperatorFn = (alert: OperatorAlert) => Promise<void>;

/**
 * Build the alertOperator function with its per-rule cooldown state.
 * One instance per process (app.ts wiring); tests build their own.
 */
export function createAlertOperator(deps: AlertOperatorDeps): AlertOperatorFn {
  // Per-rule last-page timestamps. In-process by design — see module JSDoc
  // for the leader-handoff double-page caveat.
  const lastAlertAt = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());

  return async function alertOperator(alert: OperatorAlert): Promise<void> {
    try {
      const t = now();
      const last = lastAlertAt.get(alert.rule);
      if (last !== undefined && t - last < deps.cooldownMs) {
        deps.logger.info('SLO alert suppressed by cooldown', {
          rule: alert.rule,
          sinceLastMs: t - last,
          cooldownMs: deps.cooldownMs,
        });
        return;
      }
      lastAlertAt.set(alert.rule, t);

      const detailStr = alert.details
        ? Object.entries(alert.details)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
        : '';
      const message = `[SLO:${alert.severity}] ${alert.rule}: ${alert.summary}${detailStr ? ` (${detailStr})` : ''}`;

      // Channel 1 — Sentry (always). Error level so the tag-filtered
      // Sentry→Slack/DM rules fire; no-op client when unconfigured.
      try {
        deps.sentry.captureMessage(message, 'error');
        sloAlertsSentTotal.inc({ rule: alert.rule, channel: 'sentry' });
      } catch (err) {
        deps.logger.error('SLO alert: Sentry channel failed', {
          rule: alert.rule,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Channel 2 — operator SMS (only when configured + provider wired).
      // recipientClass 'owner' is REQUIRED: it bypasses the consent+DNC gate
      // (GatedMessageDelivery) so an operator page can never be suppressed as
      // an unconsented customer send.
      if (deps.alertSmsTo && deps.delivery) {
        try {
          await deps.delivery.sendSms({
            to: deps.alertSmsTo,
            body: message.slice(0, 320),
            recipientClass: 'owner',
            idempotencyKey: `slo-alert-${alert.rule}-${t}`,
          });
          sloAlertsSentTotal.inc({ rule: alert.rule, channel: 'sms' });
        } catch (err) {
          deps.logger.error('SLO alert: SMS channel failed', {
            rule: alert.rule,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      deps.logger.warn('SLO alert dispatched', {
        rule: alert.rule,
        severity: alert.severity,
        summary: alert.summary,
        ...(alert.details ?? {}),
      });
    } catch (err) {
      // Absolute backstop — alerting must never throw into the sweep.
      deps.logger.error('alertOperator failed', {
        rule: alert.rule,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * WS15 — drain-abandonment alarm. Called by the shutdown path (app.ts
 * runShutdown) when the DRAIN_TIMEOUT_MS window expired with live voice
 * sessions still active: teardown proceeds and Twilio ends those calls, i.e.
 * real callers were hung up on by a deploy.
 *
 * Fire-and-forget by construction: `captureMessage` is a synchronous enqueue
 * into the Sentry client's internal transport buffer (no await, nothing that
 * can hang the 30s force-exit backstop). Whether the buffered event escapes
 * before process exit is best-effort — but the shutdown path already spends
 * multiple seconds draining pools after this point, which in practice gives
 * the transport time to flush. The Prometheus counter is incremented too, but
 * it dies with the process (see metrics.ts) — Sentry is the durable alarm.
 *
 * Never throws (best-effort; must not block or fail shutdown).
 */
export function emitDrainAbandonment(
  liveCount: number,
  callSids: string[],
  deps: { sentry: SentryClient; logger: Logger },
): void {
  try {
    voiceDrainAbandonedCallsTotal.inc(liveCount);
    deps.sentry.captureMessage(
      `[SLO:critical] drain_abandonment: shutdown drain window expired with ${liveCount} live call(s) — teardown proceeded, Twilio ends them (callSids: ${callSids.join(', ') || 'unknown'})`,
      'error',
    );
    deps.logger.error('Drain abandonment: live calls at teardown', {
      liveCount,
      callSids,
    });
  } catch (err) {
    // Best-effort — never let the alarm break shutdown.
    try {
      deps.logger.error('emitDrainAbandonment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // logger itself failed during teardown — nothing left to do.
    }
  }
}
