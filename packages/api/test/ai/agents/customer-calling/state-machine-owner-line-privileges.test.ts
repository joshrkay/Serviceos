/**
 * B3-1 — CallingAgentStateMachine.setOwnerLinePrivileges, directly.
 *
 * The voice turn processor's per-turn owner-line re-check (`refreshOwnerLine`)
 * sets the FSM's two owner-line flags through this method. Covered end to end
 * by the Gather and media-streams owner-line tests; pinned here on its own:
 * it sets or clears exactly those two flags, leaves the state and every other
 * context field alone, and a cleared flag is absent (the context of a caller
 * who was never recognised), not `false`.
 */
import { describe, it, expect } from 'vitest';
import { CallingAgentStateMachine } from '../../../../src/ai/agents/customer-calling/state-machine';

const TENANT = 't-fsm-owner-line';

function ownerLineMachine(): CallingAgentStateMachine {
  const fsm = new CallingAgentStateMachine({
    sessionId: 's-owner-line',
    tenantId: TENANT,
    channel: 'telephony',
    callSid: 'CA-owner-line',
    ownerSession: true,
    extendedIntents: true,
  });
  fsm.dispatch({ type: 'incoming_call', callSid: 'CA-owner-line', from: '+15125550100', to: '+15125550000', tenantId: TENANT });
  fsm.dispatch({ type: 'greeted_ok' });
  fsm.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  // Past pick-up, mid-call: the re-check runs on a live call, not at idle.
  expect(fsm.currentState).not.toBe('idle');
  return fsm;
}

describe('CallingAgentStateMachine.setOwnerLinePrivileges', () => {
  it('drops both flags: absent, not false, like a caller who was never recognised', () => {
    const fsm = ownerLineMachine();

    fsm.setOwnerLinePrivileges({ ownerSession: false, extendedIntents: false });

    expect(fsm.currentContext).not.toHaveProperty('ownerSession');
    expect(fsm.currentContext).not.toHaveProperty('extendedIntents');
  });

  it('keeps the owner session while dropping only the extended lookups', () => {
    const fsm = ownerLineMachine();

    fsm.setOwnerLinePrivileges({ ownerSession: true, extendedIntents: false });

    expect(fsm.currentContext.ownerSession).toBe(true);
    expect(fsm.currentContext).not.toHaveProperty('extendedIntents');
  });

  it('gives both back on a later turn', () => {
    const fsm = ownerLineMachine();
    fsm.setOwnerLinePrivileges({ ownerSession: false, extendedIntents: false });

    fsm.setOwnerLinePrivileges({ ownerSession: true, extendedIntents: true });

    expect(fsm.currentContext.ownerSession).toBe(true);
    expect(fsm.currentContext.extendedIntents).toBe(true);
  });

  // B4-4 — the extended owner lookups are an owner-line privilege
  // (establishment grants them only with ownerSession); the setter never
  // hands them to a caller who is not on the owner line.
  it('never grants the extended lookups without the owner line', () => {
    const fsm = ownerLineMachine();

    fsm.setOwnerLinePrivileges({ ownerSession: false, extendedIntents: true });

    expect(fsm.currentContext).not.toHaveProperty('ownerSession');
    expect(fsm.currentContext).not.toHaveProperty('extendedIntents');
  });

  it('changes no state and no other context field', () => {
    const fsm = ownerLineMachine();
    const stateBefore = fsm.currentState;
    const { ownerSession: _o, extendedIntents: _e, ...restBefore } = fsm.currentContext;

    fsm.setOwnerLinePrivileges({ ownerSession: false, extendedIntents: false });

    expect(fsm.currentState).toBe(stateBefore);
    expect(fsm.currentContext).toEqual(restBefore);
    expect(fsm.currentContext.customerId).toBe('cust-1');
  });

  it('replaces the context snapshot rather than mutating the one a caller holds', () => {
    const fsm = ownerLineMachine();
    const held = fsm.currentContext;

    fsm.setOwnerLinePrivileges({ ownerSession: false, extendedIntents: false });

    expect(held.ownerSession).toBe(true);
    expect(held.extendedIntents).toBe(true);
    expect(fsm.currentContext).not.toBe(held);
  });
});
