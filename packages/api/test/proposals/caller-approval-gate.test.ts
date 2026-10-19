/**
 * OVAS-02 — auto-approval may never grant a requester more than their role
 * could do directly.
 *
 * Pattern from docs/solutions/logic-errors/phone-lookup-dispatch-had-no-
 * authorization-behind-the-prompt.md: enumerate every gate input in a table
 * and pin the count, so the next autonomous drafting site cannot slip in
 * without a permission entry.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTO_APPROVE_DIRECT_PERMISSION,
  holdIfCallerCannotApprove,
} from '../../src/proposals/caller-approval-gate';
import { hasPermission, type Role } from '../../src/auth/rbac';
import type { ProposalType } from '../../src/proposals/proposal';

const TASKS_DIR = join(__dirname, '../../src/ai/tasks');

/**
 * Every drafting handler that bears `sourceTrustTier: 'autonomous'`, the
 * number of such sites in its file, and the proposal types they draft. A new
 * autonomous site changes the scan and fails the first test below.
 */
const AUTONOMOUS_SITES: Record<string, { sites: number; types: ProposalType[] }> = {
  'estimate-task.ts': { sites: 1, types: ['draft_estimate'] },
  'mms-estimate-task.ts': { sites: 1, types: ['draft_estimate'] },
  'estimate-edit-task.ts': { sites: 1, types: ['update_estimate'] },
  'invoice-task.ts': { sites: 1, types: ['draft_invoice'] },
  'invoice-edit-task.ts': { sites: 1, types: ['update_invoice'] },
  'job-edit-task.ts': { sites: 1, types: ['update_job'] },
  'create-appointment-task.ts': { sites: 2, types: ['create_appointment', 'create_booking'] },
};

function autonomousSiteCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of readdirSync(TASKS_DIR).filter((f) => f.endsWith('.ts'))) {
    const code = readFileSync(join(TASKS_DIR, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const n = (code.match(/sourceTrustTier:\s*'autonomous'/g) ?? []).length;
    if (n > 0) counts[file] = n;
  }
  return counts;
}

const ROLES: Array<Role | 'system' | 'bogus' | null | undefined> = [
  'owner',
  'dispatcher',
  'technician',
  'system',
  'bogus',
  null,
  undefined,
];

function approved(proposalType: ProposalType) {
  return { proposalType, status: 'approved' as const, approvedAt: new Date('2026-10-01T00:00:00Z') };
}

describe('OVAS-02 — holdIfCallerCannotApprove', () => {
  it('the scan finds exactly the known autonomous drafting sites', () => {
    expect(autonomousSiteCounts()).toEqual(
      Object.fromEntries(Object.entries(AUTONOMOUS_SITES).map(([f, v]) => [f, v.sites])),
    );
  });

  it('every type an autonomous site drafts has a direct permission, and nothing else does', () => {
    const drafted = new Set(Object.values(AUTONOMOUS_SITES).flatMap((v) => v.types));
    expect(new Set(Object.keys(AUTO_APPROVE_DIRECT_PERMISSION))).toEqual(drafted);
  });

  for (const [type, permission] of Object.entries(AUTO_APPROVE_DIRECT_PERMISSION) as Array<
    [ProposalType, NonNullable<(typeof AUTO_APPROVE_DIRECT_PERMISSION)[ProposalType]>]
  >) {
    for (const role of ROLES) {
      const allowed =
        role === 'owner' || role === 'dispatcher' || role === 'technician'
          ? hasPermission(role, permission)
          : false;
      it(`${type} × ${String(role)} → ${allowed ? 'stays approved' : 'held for review'}`, () => {
        const result = holdIfCallerCannotApprove(approved(type), role);
        expect(result.status).toBe(allowed ? 'approved' : 'ready_for_review');
        if (!allowed) expect(result.approvedAt).toBeUndefined();
      });
    }
  }

  it('a technician is held on every billing / booking type and keeps only update_job', () => {
    const kept = (Object.keys(AUTO_APPROVE_DIRECT_PERMISSION) as ProposalType[]).filter(
      (t) => holdIfCallerCannotApprove(approved(t), 'technician').status === 'approved',
    );
    expect(kept).toEqual(['update_job']);
  });

  it('an unmapped type that was somehow born approved fails closed, even for an owner', () => {
    expect(holdIfCallerCannotApprove(approved('create_customer'), 'owner').status).toBe(
      'ready_for_review',
    );
  });

  it('never touches a proposal that was not auto-approved', () => {
    const draft = { proposalType: 'draft_estimate' as const, status: 'draft' as const, approvedAt: undefined };
    expect(holdIfCallerCannotApprove(draft, 'technician')).toBe(draft);
  });
});
