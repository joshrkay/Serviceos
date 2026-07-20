import { describe, expect, it } from 'vitest';
import { approveGateFor } from './approveGate';

describe('approveGateFor (U1 lane-aware confirm gates)', () => {
  it('capture types stay one-tap', () => {
    for (const t of ['draft_invoice', 'create_customer', 'reschedule_appointment', 'add_note']) {
      expect(approveGateFor({ proposalType: t })).toEqual({ kind: 'one_tap' });
    }
  });

  it('comms types require a send confirm', () => {
    for (const t of ['send_invoice', 'send_estimate', 'notify_delay', 'send_payment_reminder']) {
      const gate = approveGateFor({ proposalType: t });
      expect(gate.kind).toBe('confirm');
      if (gate.kind === 'confirm') {
        expect(gate.lane).toBe('comms');
        expect(gate.destructive).toBe(false);
        expect(gate.title).toMatch(/messages your customer/);
        expect(gate.confirmLabel).toBe('Send it');
      }
    }
  });

  it('money types require a money confirm', () => {
    for (const t of ['issue_invoice', 'record_payment', 'apply_late_fee']) {
      const gate = approveGateFor({ proposalType: t });
      expect(gate.kind).toBe('confirm');
      if (gate.kind === 'confirm') {
        expect(gate.lane).toBe('money');
        expect(gate.destructive).toBe(false);
        expect(gate.title).toMatch(/moves money/);
      }
    }
  });

  it('irreversible types get a destructive confirm', () => {
    for (const t of ['cancel_appointment', 'emergency_dispatch']) {
      const gate = approveGateFor({ proposalType: t });
      expect(gate.kind).toBe('confirm');
      if (gate.kind === 'confirm') {
        expect(gate.lane).toBe('irreversible');
        expect(gate.destructive).toBe(true);
        expect(gate.title).toMatch(/can't be undone/);
      }
    }
  });

  it('unknown/new types fail closed to a neutral explicit confirm — never one-tap', () => {
    const gate = approveGateFor({ proposalType: 'some_future_type' });
    expect(gate.kind).toBe('confirm');
    if (gate.kind === 'confirm') {
      expect(gate.lane).toBe('unknown');
      expect(gate.destructive).toBe(false);
      expect(gate.title).toMatch(/review carefully/i);
    }
  });

  it('titles name the action via the friendly type label', () => {
    const gate = approveGateFor({ proposalType: 'send_invoice' });
    if (gate.kind === 'confirm') expect(gate.title).toMatch(/^Send invoice — /);
    const late = approveGateFor({ proposalType: 'apply_late_fee' });
    // U5 added the friendly TYPE_LABEL ("Late fee"); the money-lane confirm now
    // names the action with it instead of the de-underscored fallback.
    if (late.kind === 'confirm') expect(late.title).toMatch(/^Late fee — /);
  });
});
