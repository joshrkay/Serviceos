/**
 * #962 (PR-A) — the SPANNING drafting-parity audit.
 *
 * Generalizes `test/routes/assistant-dropped-intents.test.ts`'s mechanical
 * derivation (Task 15 found 18 silently-dropped chat intents by checking
 * every `INTENT_TO_PROPOSAL_TYPE` key against the chat dispatch map) from a
 * one-off migration check into a standing invariant:
 *
 *   Every drafting handler in the shared registry
 *   (`ai/orchestration/handler-registry.ts#buildTaskHandlers`) must be
 *   REACHABLE or REFUSED-ON-PURPOSE from every drafting surface —
 *   voice/memo via `proposals/voice-intent-map.ts#INTENT_TO_PROPOSAL_TYPE`,
 *   chat via `routes/assistant.ts#CHAT_INTENT_TO_REGISTRY_KEY` plus its
 *   dedicated-branch and excluded-intent declarations.
 *
 * "Refused on purpose" means a membership in a DECLARED exception set
 * (`CHAT_DISPATCH_EXCLUDED_INTENTS`, `CHAT_DEDICATED_BRANCH_INTENTS`,
 * `MEMO_ONLY_PROPOSAL_TYPES`) — never a silent miss. A new handler or a new
 * intent that lands on one surface and not another fails here until the
 * divergence is either wired or declared, which is the whole point: drift
 * becomes a visible, reviewable act.
 *
 * NO LIVE LLM CALLS — `buildTaskHandlers` is composed with a gateway stub
 * that throws on use (the audit only inspects registry KEYS).
 */
import { describe, it, expect } from 'vitest';

import { buildTaskHandlers } from '../../src/ai/orchestration/handler-registry';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/proposals/voice-intent-map';
import {
  CHAT_INTENT_TO_REGISTRY_KEY,
  CHAT_DISPATCH_EXCLUDED_INTENTS,
} from '../../src/routes/assistant';
import {
  CHAT_DEDICATED_BRANCH_INTENTS,
  MEMO_ONLY_PROPOSAL_TYPES,
} from '../../src/ai/voice-turn/coverage-table';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { ProposalType } from '../../src/proposals/proposal';

/** The audit never drafts — a gateway call is a bug in the audit itself. */
const inertGateway = {
  complete: async () => {
    throw new Error('drafting-surface-parity audit must never call the gateway');
  },
} as unknown as LLMGateway;

const registry = buildTaskHandlers({ gateway: inertGateway });
const registryKeys = [...registry.keys()].sort();

/** proposal type → the classifier intents that feed it on the voice/memo map. */
const memoPreimage = new Map<string, string[]>();
for (const [intent, proposalType] of Object.entries(INTENT_TO_PROPOSAL_TYPE)) {
  const list = memoPreimage.get(proposalType) ?? [];
  list.push(intent);
  memoPreimage.set(proposalType, list);
}

const chatReachableTypes = new Set<string>(Object.values(CHAT_INTENT_TO_REGISTRY_KEY));
const chatIntents = new Set<string>(Object.keys(CHAT_INTENT_TO_REGISTRY_KEY));

describe('spanning drafting-parity — every registry handler, every drafting surface (#962)', () => {
  it('sanity: the registry is non-trivial (the audit is not vacuously green)', () => {
    expect(registryKeys.length).toBeGreaterThanOrEqual(40);
  });

  it('voice/memo: EVERY registry handler is reachable through INTENT_TO_PROPOSAL_TYPE (no declared exceptions exist today)', () => {
    const unreachable = registryKeys.filter((key) => !memoPreimage.has(key));
    expect(
      unreachable,
      `registry handlers no voice/memo intent maps to (wire an intent in voice-intent-map.ts or declare the exception in coverage-table.ts):\n  ${unreachable.join('\n  ')}`,
    ).toEqual([]);
  });

  it('chat: EVERY registry handler is reachable (map or dedicated branch) or refused-on-purpose (every feeding intent chat-excluded)', () => {
    const silent = registryKeys.filter((key) => {
      if (chatReachableTypes.has(key)) return false; // reachable via the map
      const feeders = memoPreimage.get(key) ?? [];
      // Reachable via a dedicated chat branch (create_customer today).
      if (feeders.some((i) => CHAT_DEDICATED_BRANCH_INTENTS.has(i))) return false;
      // Refused on purpose: every intent that could feed it is excluded by
      // declaration (emergency_dispatch today).
      if (feeders.length > 0 && feeders.every((i) => CHAT_DISPATCH_EXCLUDED_INTENTS.has(i))) {
        return false;
      }
      return true; // neither reachable nor declared — a silent chat miss
    });
    expect(
      silent,
      `registry handlers silently unreachable from chat (wire them in CHAT_INTENT_TO_REGISTRY_KEY or declare them in CHAT_DISPATCH_EXCLUDED_INTENTS / CHAT_DEDICATED_BRANCH_INTENTS):\n  ${silent.join('\n  ')}`,
    ).toEqual([]);
  });

  it('intent level: EVERY voice/memo-mapped intent is chat-dispatched, chat-excluded, or dedicated-branch — never silently missing', () => {
    const silent = Object.keys(INTENT_TO_PROPOSAL_TYPE).filter(
      (intent) =>
        !chatIntents.has(intent) &&
        !CHAT_DISPATCH_EXCLUDED_INTENTS.has(intent) &&
        !CHAT_DEDICATED_BRANCH_INTENTS.has(intent),
    );
    expect(
      silent,
      `voice/memo intents with no declared chat disposition:\n  ${silent.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reverse: every chat map value resolves to a shared-registry handler (no undefined! landmine)', () => {
    for (const [intent, proposalType] of Object.entries(CHAT_INTENT_TO_REGISTRY_KEY)) {
      expect(registry.has(proposalType), `${intent} -> ${proposalType}`).toBe(true);
    }
  });

  it('reverse: every voice/memo map value resolves to a shared-registry handler OR a declared memo-only extension', () => {
    const dangling = [...memoPreimage.keys()].filter(
      (proposalType) =>
        !registry.has(proposalType as ProposalType) && !MEMO_ONLY_PROPOSAL_TYPES.has(proposalType),
    );
    expect(
      dangling,
      `voice/memo-mapped proposal types with neither a shared handler nor a memo-only declaration:\n  ${dangling.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the memo-only declarations are honest: absent from the shared registry, absent from the chat map, and every feeding intent is chat-excluded', () => {
    for (const proposalType of MEMO_ONLY_PROPOSAL_TYPES) {
      expect(registry.has(proposalType as ProposalType), `${proposalType} must NOT be in the shared registry`).toBe(false);
      expect(chatReachableTypes.has(proposalType), `${proposalType} must NOT be a chat map value`).toBe(false);
      const feeders = memoPreimage.get(proposalType) ?? [];
      expect(feeders.length, `${proposalType} must be fed by at least one memo intent`).toBeGreaterThan(0);
      for (const intent of feeders) {
        expect(
          CHAT_DISPATCH_EXCLUDED_INTENTS.has(intent),
          `${intent} feeds memo-only ${proposalType} and must be chat-excluded by declaration`,
        ).toBe(true);
      }
    }
  });

  it('the dedicated-branch declaration is honest: its intents are NOT in the chat map (they dispatch from their own branch)', () => {
    for (const intent of CHAT_DEDICATED_BRANCH_INTENTS) {
      expect(chatIntents.has(intent), `${intent} must not ALSO be a chat map key`).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(INTENT_TO_PROPOSAL_TYPE, intent),
        `${intent} must still be voice/memo-mapped`,
      ).toBe(true);
    }
  });
});
