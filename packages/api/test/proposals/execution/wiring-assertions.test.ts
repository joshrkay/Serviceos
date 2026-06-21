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
