import { ProposalType } from '../proposal';
import { ExecutionHandler } from './handlers';

/**
 * U5 — boot-time guard against silent persistence loss.
 *
 * Several execution handlers degrade to a synthetic-id passthrough when a
 * required dependency is absent: they return `{ success: true }` with a fresh
 * uuid and persist nothing. That is intentional for in-memory unit tests, but
 * in a deployed environment (a real Postgres pool configured) it would mean a
 * tradesperson's spoken "create an invoice" reports success while saving
 * nothing — the worst failure mode for a voice-first product.
 *
 * This guard finds any voice-reachable proposal type whose handler reports it
 * is NOT fully wired (see `ExecutionHandler.isFullyWired`) — or has no handler
 * at all — and, when a pool is configured, fails boot loudly instead of
 * silently no-opping. Handlers that don't implement `isFullyWired` are treated
 * as fully wired (the persist-critical invoice/job/appointment handlers
 * implement it today; others can opt in incrementally).
 */
export interface WiringLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export function findDegradedVoiceHandlers(
  registry: Map<ProposalType, ExecutionHandler>,
  voiceReachableTypes: readonly (ProposalType | undefined)[],
): ProposalType[] {
  const degraded: ProposalType[] = [];
  for (const type of voiceReachableTypes) {
    if (!type) continue;
    const handler = registry.get(type);
    if (!handler) {
      // A voice intent maps to a proposal type with no execution handler at
      // all — it could never persist. Surface it like a degraded handler.
      degraded.push(type);
      continue;
    }
    if (handler.isFullyWired && !handler.isFullyWired()) {
      degraded.push(type);
    }
  }
  return degraded;
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
    `without persisting): ${degraded.join(', ')}. Wire their ` +
    'repositories/services before serving voice traffic.';

  if (opts.poolConfigured) {
    // A Postgres pool is configured → real deployment. Fail boot rather than
    // silently no-op a tradesperson's spoken action.
    throw new Error(message);
  }
  // No pool (dev / in-memory) → degraded handlers are expected; just warn.
  opts.logger?.warn(message, { degraded });
}
