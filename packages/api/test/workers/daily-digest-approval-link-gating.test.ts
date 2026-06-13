import { describe, it, expect } from 'vitest';
import {
  buildApprovalLinks,
  type DailyDigestWorkerDeps,
} from '../../src/workers/daily-digest-worker';
import type {
  DailyDigestPayload,
  DigestPendingApproval,
} from '../../src/digest/digest-service';

/**
 * Track-E money-gating regression: the End-of-Day digest texts the owner a
 * one-tap approve link per top pending approval. A one-tap link approves with
 * a SINGLE tap and no second factor, so it must be minted ONLY for
 * capture-class proposals. A money / comms / irreversible proposal in the
 * digest must surface in the list (for review) but must NOT carry a bare
 * approve link — otherwise a single tap approves an `issue_invoice` /
 * `send_invoice` / `cancel_appointment` with no confirmation.
 */
const deps = {
  oneTapSecret: 'test-secret',
  buildApproveUrl: (token: string) => `https://api.test/approve?token=${token}`,
} as unknown as DailyDigestWorkerDeps;

function payloadWithTop(top: DigestPendingApproval[]): DailyDigestPayload {
  return {
    pendingApprovals: { totalCount: top.length, top },
  } as unknown as DailyDigestPayload;
}

describe('buildApprovalLinks — money-gating', () => {
  it('mints one-tap approve links ONLY for capture-class proposals', () => {
    const top: DigestPendingApproval[] = [
      { proposalId: 'cap', proposalType: 'draft_estimate', summary: 'Draft estimate' },
      { proposalId: 'comms', proposalType: 'send_invoice', summary: 'Send invoice' },
      { proposalId: 'money', proposalType: 'issue_invoice', summary: 'Issue invoice' },
      { proposalId: 'irrev', proposalType: 'cancel_appointment', summary: 'Cancel appt' },
    ];

    const links = buildApprovalLinks('tenant-1', payloadWithTop(top), deps);

    expect(links.map((l) => l.approval.proposalId)).toEqual(['cap']);
  });

  it('mints no one-tap approve link for a money proposal (issue_invoice)', () => {
    const top: DigestPendingApproval[] = [
      { proposalId: 'money', proposalType: 'issue_invoice', summary: 'Issue invoice' },
    ];

    const links = buildApprovalLinks('tenant-1', payloadWithTop(top), deps);

    expect(links).toEqual([]);
  });

  it('still mints a one-tap approve link for a capture proposal (draft_estimate)', () => {
    const top: DigestPendingApproval[] = [
      { proposalId: 'cap', proposalType: 'draft_estimate', summary: 'Draft estimate' },
    ];

    const links = buildApprovalLinks('tenant-1', payloadWithTop(top), deps);

    expect(links).toHaveLength(1);
    expect(links[0].approval.proposalId).toBe('cap');
    expect(links[0].url).toContain('https://api.test/approve?token=');
  });
});
