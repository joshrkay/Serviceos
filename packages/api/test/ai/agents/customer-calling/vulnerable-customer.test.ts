import { describe, it, expect } from 'vitest';
import {
  buildMarkCustomerVulnerablePayload,
  composeVulnerabilityNote,
  isVulnerableCustomer,
  VULNERABILITY_NOTE_MARKER,
} from '../../../../src/ai/agents/customer-calling/vulnerable-customer';
import { validateProposalPayload } from '../../../../src/proposals/contracts';
import { UpdateCustomerExecutionHandler } from '../../../../src/proposals/execution/handlers';
import { InMemoryCustomerRepository } from '../../../../src/customers/customer';
import { createCustomer } from '../../../../src/customers/customer';
import type { Proposal } from '../../../../src/proposals/proposal';
import type { TriageDecision } from '@ai-service-os/shared';

const DECISION: Pick<TriageDecision, 'reason' | 'score'> = {
  reason: 'vulnerability (score 1) with critical urgency',
  score: {
    signals: [{ kind: 'medical', evidence: 'caller mentioned oxygen', weight: 1 }],
    total: 1,
    weatherUnavailable: true,
  },
};
const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NOW = new Date('2026-06-11T12:00:00Z');

describe('RV-123 — buildMarkCustomerVulnerablePayload', () => {
  it('produces a valid EXISTING update_customer payload (no contract change)', () => {
    const payload = buildMarkCustomerVulnerablePayload(CUSTOMER_ID, DECISION, undefined, NOW);
    expect(payload).not.toBeNull();
    expect(payload!.notes).toContain(VULNERABILITY_NOTE_MARKER);
    expect(payload!.notes).toContain('caller mentioned oxygen');
    expect(validateProposalPayload('update_customer', payload!).valid).toBe(true);
  });

  it('preserves existing notes by prepending', () => {
    const payload = buildMarkCustomerVulnerablePayload(
      CUSTOMER_ID,
      DECISION,
      'gate code 1234',
      NOW,
    );
    expect(payload!.notes.startsWith(VULNERABILITY_NOTE_MARKER)).toBe(true);
    expect(payload!.notes).toContain('gate code 1234');
  });

  it('returns null when the customer is already marked (idempotent)', () => {
    const payload = buildMarkCustomerVulnerablePayload(
      CUSTOMER_ID,
      DECISION,
      `${VULNERABILITY_NOTE_MARKER} prior flag`,
      NOW,
    );
    expect(payload).toBeNull();
  });

  it('round-trips through the existing UpdateCustomerExecutionHandler into communicationNotes', async () => {
    const repo = new InMemoryCustomerRepository();
    const customer = await createCustomer(
      {
        tenantId: 't1',
        firstName: 'Pat',
        lastName: 'Jones',
        createdBy: 'test',
      },
      repo,
    );
    const payload = buildMarkCustomerVulnerablePayload(customer.id, DECISION, undefined, NOW)!;
    const handler = new UpdateCustomerExecutionHandler(repo);
    const proposal = {
      id: 'p1',
      tenantId: 't1',
      proposalType: 'update_customer',
      status: 'approved',
      payload: payload as unknown as Record<string, unknown>,
      summary: 'flag vulnerable',
      createdBy: 'system:vulnerability-triage',
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as Proposal;
    const result = await handler.execute(proposal, { tenantId: 't1', executedBy: 'owner' });
    expect(result.success).toBe(true);
    const updated = await repo.findById('t1', customer.id);
    expect(updated?.communicationNotes).toContain(VULNERABILITY_NOTE_MARKER);
    // The derived accessor now reads the flag.
    expect(isVulnerableCustomer(updated)).toBe(true);
  });
});

describe('RV-123 — isVulnerableCustomer accessor', () => {
  it('derives the flag from a marked note', () => {
    expect(
      isVulnerableCustomer({ communicationNotes: `${VULNERABILITY_NOTE_MARKER} x` }),
    ).toBe(true);
  });

  it('derives the flag from m113 dateOfBirth (age >= 65)', () => {
    expect(
      isVulnerableCustomer({ dateOfBirth: new Date('1950-01-01') }, NOW),
    ).toBe(true);
    expect(
      isVulnerableCustomer({ dateOfBirth: new Date('1990-01-01') }, NOW),
    ).toBe(false);
  });

  it('false for unmarked / missing customers', () => {
    expect(isVulnerableCustomer(null)).toBe(false);
    expect(isVulnerableCustomer({ communicationNotes: 'gate code' })).toBe(false);
  });
});

describe('composeVulnerabilityNote', () => {
  it('is NON-PII: only the decision reason + evidence strings + date', () => {
    const note = composeVulnerabilityNote(DECISION, NOW);
    expect(note).toContain('2026-06-11');
    expect(note).toContain('caller mentioned oxygen');
  });
});
