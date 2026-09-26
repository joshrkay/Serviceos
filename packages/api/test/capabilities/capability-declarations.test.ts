/**
 * #840 — the capability declaration is the single source every surface's
 * intent map derives from.
 *
 * The test of success the issue set is not "fewer files": it is that ADDING a
 * capability makes it available on every surface without anyone remembering
 * to. The negative controls below plant a brand-new declaration and assert it
 * reaches the phone/memo/in-app map AND the chat dispatch map with no other
 * edit — and that a surface opt-out is the only way to keep it off one.
 */
import { describe, it, expect } from 'vitest';

import {
  CAPABILITIES,
  CAPABILITY_SURFACES,
  deriveIntentToProposalType,
  deriveChatDispatch,
  type CapabilityDeclaration,
} from '../../src/capabilities/capabilities';
import { SUPPORTED_INTENTS } from '../../src/ai/orchestration/intent-classifier';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/proposals/voice-intent-map';
import {
  CHAT_INTENT_TO_REGISTRY_KEY,
  CHAT_DISPATCH_EXCLUDED_INTENTS,
} from '../../src/routes/assistant';
import { CHAT_DEDICATED_BRANCH_INTENTS } from '../../src/ai/voice-turn/coverage-table';

const entries = Object.entries(CAPABILITIES) as Array<[string, CapabilityDeclaration]>;

describe('#840 capability declarations — one per intent, the single source', () => {
  it('declares every classifier intent exactly once (and nothing the classifier cannot emit)', () => {
    const declared = Object.keys(CAPABILITIES).sort();
    const classifiable = SUPPORTED_INTENTS.filter((i) => i !== 'unknown').sort();
    expect(declared).toEqual(classifiable);
  });

  it('the three voice surfaces are phone, memo and chat — a capability targets "the phone", never a transport', () => {
    expect([...CAPABILITY_SURFACES]).toEqual(['phone', 'memo', 'chat']);
  });

  it('every surface opt-out carries a non-empty reason (a refusal someone chose, never a silent miss)', () => {
    for (const [intent, cap] of entries) {
      for (const [surface, reason] of Object.entries(cap.unavailableOn ?? {})) {
        expect(CAPABILITY_SURFACES as readonly string[], `${intent}: unknown surface ${surface}`).toContain(surface);
        expect(typeof reason === 'string' && reason.trim().length > 20, `${intent} opts out of ${surface} without a reason`).toBe(true);
      }
    }
  });

  it('every proposal and direct-act capability names a spoken example (the catalog renders it)', () => {
    for (const [intent, cap] of entries) {
      if (cap.kind === 'proposal' || cap.kind === 'direct_act') {
        expect(cap.example.trim().length, intent).toBeGreaterThan(5);
      }
    }
  });

  it('kind census matches the audit: 48 proposal, 20 lookup, 1 direct act, 3 approval, 5 dialogue', () => {
    const census: Record<string, number> = {};
    for (const [, cap] of entries) census[cap.kind] = (census[cap.kind] ?? 0) + 1;
    expect(census).toEqual({ proposal: 48, lookup: 20, direct_act: 1, approval: 3, dialogue: 5 });
  });

  it('a lookup_* intent is always a lookup capability, and nothing else is', () => {
    for (const [intent, cap] of entries) {
      expect(cap.kind === 'lookup', intent).toBe(intent.startsWith('lookup_'));
    }
  });
});

describe('#840 derivations — the per-surface maps are computed, not hand-kept', () => {
  it('INTENT_TO_PROPOSAL_TYPE (phone, memo, in-app) is derived from the declarations', () => {
    expect(INTENT_TO_PROPOSAL_TYPE).toEqual(deriveIntentToProposalType(CAPABILITIES));
    const proposalIntents = entries.filter(([, c]) => c.kind === 'proposal').map(([i]) => i).sort();
    expect(Object.keys(INTENT_TO_PROPOSAL_TYPE).sort()).toEqual(proposalIntents);
  });

  it('the chat dispatch map and its excluded set are derived from the declarations', () => {
    const derived = deriveChatDispatch(CAPABILITIES, CHAT_DEDICATED_BRANCH_INTENTS);
    expect(CHAT_INTENT_TO_REGISTRY_KEY).toEqual(derived.dispatch);
    expect([...CHAT_DISPATCH_EXCLUDED_INTENTS].sort()).toEqual([...derived.excluded].sort());
  });

  it('the chat exclusions are exactly the proposal capabilities that opt out of chat', () => {
    expect([...CHAT_DISPATCH_EXCLUDED_INTENTS].sort()).toEqual([
      'create_standing_instruction',
      'emergency_dispatch',
      'respond_to_review',
      'update_brand_voice',
    ]);
  });

  // ─── NEGATIVE CONTROLS — "available on every surface without remembering to" ───

  const planted = {
    ...CAPABILITIES,
    plant_new_capability: {
      kind: 'proposal',
      proposalType: 'add_note',
      example: 'A capability nobody wired anywhere else',
    },
  } as unknown as typeof CAPABILITIES;

  it('NEGATIVE CONTROL — a new declaration reaches the phone/memo/in-app map with no other edit', () => {
    const map = deriveIntentToProposalType(planted) as Record<string, string>;
    expect(map.plant_new_capability).toBe('add_note');
  });

  it('NEGATIVE CONTROL — a new declaration reaches chat dispatch with no other edit', () => {
    const { dispatch, excluded } = deriveChatDispatch(planted, CHAT_DEDICATED_BRANCH_INTENTS);
    expect((dispatch as Record<string, string>).plant_new_capability).toBe('add_note');
    expect(excluded.has('plant_new_capability')).toBe(false);
  });

  it('NEGATIVE CONTROL — only an explicit opt-out keeps a capability off a surface', () => {
    const optedOut = {
      ...planted,
      plant_new_capability: {
        kind: 'proposal',
        proposalType: 'add_note',
        example: 'A capability nobody wired anywhere else',
        unavailableOn: { chat: 'planted: deliberately not served on chat for this control' },
      },
    } as unknown as typeof CAPABILITIES;
    const { dispatch, excluded } = deriveChatDispatch(optedOut, CHAT_DEDICATED_BRANCH_INTENTS);
    expect(Object.prototype.hasOwnProperty.call(dispatch, 'plant_new_capability')).toBe(false);
    expect(excluded.has('plant_new_capability')).toBe(true);
    // The phone/memo/in-app map is unaffected by a chat-only opt-out.
    expect((deriveIntentToProposalType(optedOut) as Record<string, string>).plant_new_capability).toBe('add_note');
  });

  it('NEGATIVE CONTROL — a dedicated-branch intent is served on chat but not through the map', () => {
    const { dispatch, excluded } = deriveChatDispatch(CAPABILITIES, new Set(['create_customer']));
    expect(Object.prototype.hasOwnProperty.call(dispatch, 'create_customer')).toBe(false);
    expect(excluded.has('create_customer')).toBe(false);
  });
});
