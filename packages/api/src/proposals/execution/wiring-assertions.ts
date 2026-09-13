import { ProposalType } from '../proposal';
import { ExecutionHandler } from './handlers';

/**
 * U5 / WS3 — boot-time guard against silent persistence loss.
 *
 * Some execution handlers historically degraded to a synthetic-id passthrough
 * when a required dependency was absent: they returned `{ success: true }` with
 * a fresh uuid and persisted nothing. That was documented as "intentional for
 * in-memory unit tests", but in a deployed environment (a real Postgres pool
 * configured) it meant a tradesperson's spoken "create an invoice" reported
 * success while saving nothing — the worst failure mode for a voice-first
 * product. WS3 makes that impossible in production two ways:
 *
 *   1. Every voice-reachable PERSISTENCE handler now implements `isFullyWired()`
 *      (returns false when a dependency it needs to persist is missing). This
 *      guard fails boot loudly when a pool is configured and any such handler
 *      is degraded — so the synthetic-success branch is unreachable in a real
 *      deployment (boot aborts before serving traffic).
 *   2. The consent/entity-audit handlers (update_customer, add_note,
 *      confirm_appointment, request_feedback) additionally return an explicit
 *      `{ success: false, error: 'handler_not_wired:<dep>' }` at runtime instead
 *      of a synthetic success, and take their AuditRepository as a NON-optional
 *      constructor param, so they cannot even be constructed without an audit
 *      sink.
 *
 * A voice-reachable proposal type whose handler reports NOT fully wired — or
 * that has no handler at all — is flagged.
 *
 * U8 (C2) — the guard FAILS CLOSED on a missing probe: a voice-reachable
 * handler that does not implement `isFullyWired` is treated as DEGRADED, not
 * as wired. The old default ("no probe = assume wired") meant a new handler
 * shipped without a probe was invisible to this guard — exactly the class of
 * silent success-without-persistence the guard exists to prevent. Every
 * voice-reachable handler now implements the probe (pinned by the
 * registry-enumeration test in test/proposals/wiring-assertions.test.ts), so
 * the only way to trip the missing-probe branch is to add a new
 * voice-reachable handler without one — which should fail the boot, and that
 * test, until the probe is written.
 */
export interface WiringLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export function findDegradedVoiceHandlers(
  registry: Map<ProposalType, ExecutionHandler>,
  voiceReachableTypes: readonly (ProposalType | undefined)[],
): ProposalType[] {
  // Multiple voice intents can map to the same ProposalType, so dedupe the
  // inputs (and outputs) to avoid redundant checks and duplicate names in the
  // boot-blocking error message.
  const degraded = new Set<ProposalType>();
  for (const type of new Set(voiceReachableTypes)) {
    if (!type) continue;
    const handler = registry.get(type);
    if (!handler) {
      // A voice intent maps to a proposal type with no execution handler at
      // all — it could never persist. Surface it like a degraded handler.
      degraded.add(type);
      continue;
    }
    // U8 — fail closed: no probe counts as degraded (see module doc above).
    if (!handler.isFullyWired || !handler.isFullyWired()) {
      degraded.add(type);
    }
  }
  return Array.from(degraded);
}

export function assertVoiceHandlersWired(
  registry: Map<ProposalType, ExecutionHandler>,
  voiceReachableTypes: readonly (ProposalType | undefined)[],
  opts: { poolConfigured: boolean; logger?: WiringLogger },
): void {
  const degraded = findDegradedVoiceHandlers(registry, voiceReachableTypes);
  if (degraded.length === 0) return;

  const message =
    'Voice-reachable execution handlers are degraded (would return success ' +
    `without persisting) or are missing an isFullyWired() probe: ${degraded.join(', ')}. ` +
    'Wire their repositories/services (or implement the probe) before serving voice traffic.';

  if (opts.poolConfigured) {
    // A Postgres pool is configured → real deployment. Fail boot rather than
    // silently no-op a tradesperson's spoken action.
    throw new Error(message);
  }
  // No pool (dev / in-memory) → degraded handlers are expected; just warn.
  opts.logger?.warn(message, { degraded });
}
