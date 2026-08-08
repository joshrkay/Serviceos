/**
 * U8 (C2) — boot guard fails closed: registry-enumeration proof.
 *
 * The voice-reachable surface is defined by Object.values(INTENT_TO_PROPOSAL_TYPE)
 * (proposals/voice-intent-map.ts) — NOT by a file grep: several files hold
 * multiple handler classes, so grep can neither prove coverage nor catch a
 * newly mapped intent whose handler ships without a probe. This suite
 * enumerates the REAL production registry (createExecutionHandlerRegistry)
 * against the REAL intent map and pins:
 *
 *   1. every voice-reachable proposal type has a registered handler,
 *   2. zero voice-reachable handlers are missing the isFullyWired() probe,
 *   3. a fully wired registry reports zero degraded voice handlers,
 *   4. dropping any single persistence/effect dep is DETECTED by
 *      findDegradedVoiceHandlers for exactly the types that depend on it
 *      (the executed effect of each probe, exercised through the same
 *      function the app.ts:2186 boot call uses).
 *
 * A new voice intent added to the map without a probed handler fails (1)/(2)
 * here before the boot-time default-fail flip can ever brick a deploy.
 */
import { describe, it, expect, vi } from 'vitest';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import {
  assertVoiceHandlersWired,
  findDegradedVoiceHandlers,
} from '../../src/proposals/execution/wiring-assertions';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/proposals/voice-intent-map';
import { ProposalType } from '../../src/proposals/proposal';

/** The voice-reachable set, exactly as boot computes it (app.ts:2186). */
const VOICE_REACHABLE = Object.values(INTENT_TO_PROPOSAL_TYPE);
const UNIQUE_VOICE_TYPES = Array.from(new Set(VOICE_REACHABLE)) as ProposalType[];

type RegistryDeps = NonNullable<Parameters<typeof createExecutionHandlerRegistry>[0]>;

/**
 * Every dep a voice-reachable handler's probe (or conditional registration)
 * consults, stubbed. Probes are Boolean-presence checks, so `{}` suffices —
 * no method is ever called at construction/probe time.
 */
function fullDeps(): RegistryDeps {
  return {
    customerRepo: {} as any,
    jobRepo: {} as any,
    // Tradesperson wave 1, Task 2 — update_catalog_item became voice-reachable
    // (proposals/voice-intent-map.ts), so its execution handler's
    // isFullyWired() probe (Boolean(this.catalogRepo)) is now exercised here.
    catalogRepo: {} as any,
    timelineRepo: {} as any,
    timeEntryRepo: {} as any,
    locationRepo: {} as any,
    appointmentRepo: {} as any,
    assignmentRepo: {} as any,
    invoiceRepo: {} as any,
    estimateRepo: {} as any,
    settingsRepo: {} as any,
    scheduleRepo: {} as any,
    proposalRepo: {} as any,
    dunningEventRepo: {} as any,
    transactionalComms: {} as any,
    noteRepo: {} as any,
    paymentRepo: {} as any,
    invoiceDeliveryProvider: {} as any,
    estimateDeliveryProvider: {} as any,
    expenseRepo: {} as any,
    auditRepo: {} as any,
    serviceCreditRepo: {} as any,
    googleReplyResolver: {} as any,
    reviewPrivateMessageSender: {} as any,
    leadRepo: {} as any,
    timeEntryService: {} as any,
    feedbackRepo: {} as any,
    delayNotificationService: {} as any,
    emergencySmsSender: {} as any,
    sendService: {} as any,
    dispatchRepo: {} as any,
    standingInstructionRepo: {} as any,
    brandVoiceRepo: {} as any,
  };
}

function registryWithout(...omit: (keyof RegistryDeps)[]) {
  const deps = fullDeps();
  for (const key of omit) delete deps[key];
  return createExecutionHandlerRegistry(deps);
}

describe('U8: voice-reachable registry enumeration', () => {
  const registry = createExecutionHandlerRegistry(fullDeps());

  it('every voice-reachable proposal type has a registered execution handler', () => {
    const missing = UNIQUE_VOICE_TYPES.filter((type) => !registry.get(type));
    expect(missing).toEqual([]);
  });

  it('zero voice-reachable handlers are missing the isFullyWired() probe', () => {
    const missingProbe = UNIQUE_VOICE_TYPES.filter(
      (type) => typeof registry.get(type)?.isFullyWired !== 'function',
    );
    expect(missingProbe).toEqual([]);
  });

  it('a fully wired registry reports zero degraded voice handlers', () => {
    // Same call shape as boot (app.ts:2186): the raw Object.values array,
    // duplicates and all.
    expect(findDegradedVoiceHandlers(registry, VOICE_REACHABLE)).toEqual([]);
    expect(() =>
      assertVoiceHandlersWired(registry, VOICE_REACHABLE, { poolConfigured: true }),
    ).not.toThrow();
  });
});

describe('U8: each newly probed handler is DETECTED when its effect dep is dropped', () => {
  // omit → the voice types whose probe (or registration) must flag. Each row
  // exercises the executed effect of a probe added in this unit through the
  // exact guard boot calls.
  const rows: Array<{ omit: (keyof RegistryDeps)[]; flags: ProposalType[] }> = [
    // Not registered at all without invoiceRepo → flagged via the no-handler path.
    { omit: ['invoiceRepo'], flags: ['update_invoice', 'issue_invoice', 'apply_late_fee'] },
    { omit: ['estimateRepo'], flags: ['update_estimate', 'send_estimate_nudge'] },
    { omit: ['proposalRepo'], flags: ['batch_invoice'] },
    {
      omit: ['assignmentRepo'],
      flags: ['reassign_appointment', 'add_crew_member', 'remove_crew_member'],
    },
    {
      omit: ['appointmentRepo'],
      flags: ['reschedule_appointment', 'cancel_appointment', 'reassign_appointment', 'add_crew_member'],
    },
    { omit: ['invoiceDeliveryProvider'], flags: ['send_invoice'] },
    { omit: ['estimateDeliveryProvider'], flags: ['send_estimate'] },
    { omit: ['sendService'], flags: ['send_estimate_nudge'] },
    { omit: ['transactionalComms'], flags: ['send_payment_reminder'] },
    { omit: ['emergencySmsSender'], flags: ['emergency_dispatch'] },
    { omit: ['delayNotificationService'], flags: ['notify_delay'] },
    { omit: ['scheduleRepo'], flags: ['create_invoice_schedule'] },
    { omit: ['googleReplyResolver'], flags: ['review_response_proposal'] },
    { omit: ['reviewPrivateMessageSender'], flags: ['review_response_proposal'] },
    { omit: ['serviceCreditRepo'], flags: ['review_response_proposal'] },
    // Tradesperson wave 1, Task 2 — without catalogRepo,
    // UpdateCatalogItemExecutionHandler.isFullyWired() reports false (its
    // dep-less mode is a synthetic passthrough that persists nothing).
    { omit: ['catalogRepo'], flags: ['update_catalog_item'] },
    // Tradesperson wave 1, Task 3 — record_refund reuses the SAME
    // paymentRepo record_payment already depends on (no new dep — see
    // RecordRefundExecutionHandler's doc comment). Without it,
    // RecordRefundExecutionHandler.isFullyWired() reports false (its
    // dep-less mode is a synthetic passthrough that persists nothing).
    { omit: ['paymentRepo'], flags: ['record_refund'] },
  ];

  for (const { omit, flags } of rows) {
    it(`without ${omit.join('+')} the guard flags ${flags.join(', ')}`, () => {
      const degraded = findDegradedVoiceHandlers(registryWithout(...omit), VOICE_REACHABLE);
      for (const type of flags) {
        expect(degraded).toContain(type);
      }
      // And the boot-time assertion fails closed under a configured pool,
      // naming the degraded type in the thrown message.
      expect(() =>
        assertVoiceHandlersWired(registryWithout(...omit), VOICE_REACHABLE, {
          poolConfigured: true,
        }),
      ).toThrow(new RegExp(flags[0]));
    });
  }

  it('pool-less dev still only warns for the same degradations', () => {
    const warn = vi.fn();
    expect(() =>
      assertVoiceHandlersWired(registryWithout('proposalRepo'), VOICE_REACHABLE, {
        poolConfigured: false,
        logger: { warn },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('U8 commit 2: a MISSING isFullyWired() probe counts as degraded (fail closed)', () => {
  // A synthetic voice-reachable handler that ships without the probe — the
  // exact shape the old default ("no probe = assume wired") let through.
  function registryWithProbelessHandler() {
    const registry = createExecutionHandlerRegistry(fullDeps());
    registry.set('draft_invoice', {
      proposalType: 'draft_invoice',
      execute: async () => ({ success: true, resultEntityId: 'synthetic' }),
      // no isFullyWired
    });
    return registry;
  }

  it('findDegradedVoiceHandlers flags a probe-less voice-reachable handler', () => {
    expect(
      findDegradedVoiceHandlers(registryWithProbelessHandler(), VOICE_REACHABLE),
    ).toEqual(['draft_invoice']);
  });

  it('boot fails closed on the missing probe when a pool is configured', () => {
    expect(() =>
      assertVoiceHandlersWired(registryWithProbelessHandler(), VOICE_REACHABLE, {
        poolConfigured: true,
      }),
    ).toThrow(/draft_invoice.*isFullyWired|isFullyWired.*draft_invoice/s);
  });

  it('pool-less dev boot still skips cleanly (warns, never throws)', () => {
    const warn = vi.fn();
    expect(() =>
      assertVoiceHandlersWired(registryWithProbelessHandler(), VOICE_REACHABLE, {
        poolConfigured: false,
        logger: { warn },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ degraded: ['draft_invoice'] });
  });

  it('a probe that exists but returns false is still degraded (flip did not weaken the old path)', () => {
    const registry = createExecutionHandlerRegistry(fullDeps());
    registry.set('draft_invoice', {
      proposalType: 'draft_invoice',
      execute: async () => ({ success: true }),
      isFullyWired: () => false,
    });
    expect(findDegradedVoiceHandlers(registry, VOICE_REACHABLE)).toEqual(['draft_invoice']);
  });
});
