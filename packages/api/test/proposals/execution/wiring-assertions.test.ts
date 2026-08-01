/**
 * U5 — boot-time voice handler wiring guard.
 *
 * Proves the guard catches a persist-critical voice handler running in its
 * degraded (synthetic-id, saves-nothing) mode: it throws when a Postgres pool
 * is configured (real deployment) and only warns in pool-less dev.
 */
import { describe, it, expect, vi } from 'vitest';
import { createExecutionHandlerRegistry } from '../../../src/proposals/execution/handlers';
import {
  assertVoiceHandlersWired,
  findDegradedVoiceHandlers,
} from '../../../src/proposals/execution/wiring-assertions';
import { ProposalType } from '../../../src/proposals/proposal';

const VOICE_TYPES: ProposalType[] = ['draft_invoice', 'create_job', 'create_appointment'];

function fullyWiredRegistry() {
  return createExecutionHandlerRegistry({
    invoiceRepo: {} as any,
    settingsRepo: {} as any,
    jobRepo: {} as any,
    locationRepo: {} as any,
    appointmentRepo: {} as any,
  });
}

describe('U5: voice handler wiring guard', () => {
  it('reports no degraded handlers when the persist deps are wired', () => {
    expect(findDegradedVoiceHandlers(fullyWiredRegistry(), VOICE_TYPES)).toEqual([]);
  });

  it('flags invoice/job/appointment when their repos are absent', () => {
    const degraded = findDegradedVoiceHandlers(createExecutionHandlerRegistry({}), VOICE_TYPES);
    expect(degraded).toContain('draft_invoice');
    expect(degraded).toContain('create_job');
    expect(degraded).toContain('create_appointment');
  });

  it('throws on boot when a pool is configured and a persist handler is degraded', () => {
    // Everything wired except invoiceRepo → draft_invoice degrades.
    const registry = createExecutionHandlerRegistry({
      settingsRepo: {} as any,
      jobRepo: {} as any,
      locationRepo: {} as any,
      appointmentRepo: {} as any,
    });
    expect(() =>
      assertVoiceHandlersWired(registry, VOICE_TYPES, { poolConfigured: true }),
    ).toThrow(/draft_invoice/);
  });

  it('warns (does not throw) in pool-less dev when a handler is degraded', () => {
    const warn = vi.fn();
    expect(() =>
      assertVoiceHandlersWired(createExecutionHandlerRegistry({}), VOICE_TYPES, {
        poolConfigured: false,
        logger: { warn },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('flags a voice type that has no execution handler at all', () => {
    // 'callback' has no execution handler (operator-manual); if a voice
    // intent ever mapped to it, the guard must flag it as non-persisting.
    expect(
      findDegradedVoiceHandlers(fullyWiredRegistry(), ['callback' as ProposalType]),
    ).toEqual(['callback']);
  });

  it('ignores undefined entries (Object.values of the Partial intent map)', () => {
    expect(
      findDegradedVoiceHandlers(fullyWiredRegistry(), [undefined, 'draft_invoice']),
    ).toEqual([]);
  });
});

// WS3 — the four consent/entity-audit handlers (and the broader persistence
// set) now report isFullyWired, so an unwired registry flags them and a
// pool-configured boot fails loudly instead of silently no-opping.
describe('WS3: expanded voice persistence wiring guard', () => {
  const WS3_TYPES: ProposalType[] = [
    'update_customer',
    'add_note',
    'confirm_appointment',
    'request_feedback',
    'record_payment',
    'draft_estimate',
    'create_customer',
    'mark_lead_lost',
    'add_service_location',
    'log_time_entry',
    'log_expense',
  ];

  it('flags every WS3 persistence handler when its dep is absent', () => {
    const degraded = findDegradedVoiceHandlers(createExecutionHandlerRegistry({}), WS3_TYPES);
    for (const type of WS3_TYPES) {
      expect(degraded).toContain(type);
    }
  });

  it('reports none degraded once every persistence dep is wired', () => {
    const registry = createExecutionHandlerRegistry({
      customerRepo: {} as any,
      noteRepo: {} as any,
      appointmentRepo: {} as any,
      feedbackRepo: {} as any,
      paymentRepo: {} as any,
      invoiceRepo: {} as any,
      estimateRepo: {} as any,
      settingsRepo: {} as any,
      leadRepo: {} as any,
      locationRepo: {} as any,
      timeEntryService: {} as any,
      expenseRepo: {} as any,
      auditRepo: {} as any,
    });
    expect(findDegradedVoiceHandlers(registry, WS3_TYPES)).toEqual([]);
  });

  it('fails boot when a pool is configured but update_customer is unwired', () => {
    const registry = createExecutionHandlerRegistry({
      noteRepo: {} as any,
      appointmentRepo: {} as any,
      feedbackRepo: {} as any,
    });
    expect(() =>
      assertVoiceHandlersWired(registry, ['update_customer' as ProposalType], {
        poolConfigured: true,
      }),
    ).toThrow(/update_customer/);
  });
});
