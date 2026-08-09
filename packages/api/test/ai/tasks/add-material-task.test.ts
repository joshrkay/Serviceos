/**
 * Task 9 (2026-08-07 tradesperson plan) — AddMaterialTaskHandler
 * (drafting leg).
 *
 * `add_material` joins `JOB_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts): when a job is named
 * ("for the Patel job"), the voice-action-router resolves the spoken
 * jobReference to a verified jobId BEFORE this handler runs and stamps it
 * onto `context.existingEntities.jobId` — a ROUTER-INJECTED id, never an
 * LLM-extracted field (same house pattern as `apply_credit`'s invoiceId /
 * `create_change_order`'s jobId). Unlike `create_change_order`, jobId is
 * OPTIONAL here — a shopping-list item can be unlinked to any job — so an
 * unresolved reference never gates the proposal.
 */
import { describe, it, expect } from 'vitest';
import { AddMaterialTaskHandler } from '../../../src/ai/tasks/add-material-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';

const TENANT_ID = 't-1';
const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'add three boxes of half-inch PEX to the shopping list',
    ...overrides,
  };
}

describe('AddMaterialTaskHandler', () => {
  it('a spoken description drafts ungated with quantity defaulted to 1', async () => {
    const { proposal, taskType } = await new AddMaterialTaskHandler().handle(
      ctx({ existingEntities: { materialDescription: 'flue liner kit' } }),
    );

    expect(taskType).toBe('add_material');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('capture');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.description).toBe('flue liner kit');
    expect(payload.quantity).toBe(1);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('a spoken quantity overrides the default', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({
        existingEntities: { materialDescription: '1/2" PEX', materialQuantity: 3 },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.quantity).toBe(3);
  });

  it('a missing description gates with a FLAT description key', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({ existingEntities: { materialQuantity: 2 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('description');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a router-injected jobId (job was named) is carried onto the payload', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({
        existingEntities: { materialDescription: 'flue liner kit', jobId: JOB_ID } as never,
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBe(JOB_ID);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('no job named — jobId is simply absent, never gates (a shopping-list item can be unlinked)', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({ existingEntities: { materialDescription: 'flue liner kit' } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBeUndefined();
    expect(missingFieldsFor(proposal)).not.toContain('jobId');
  });

  it('a raw free-text jobReference alone (never router-resolved) does NOT satisfy jobId', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({
        existingEntities: { materialDescription: 'flue liner kit', jobReference: 'the Patel job' },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBeUndefined();
  });

  it('vendor passes through when spoken', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({
        existingEntities: {
          materialDescription: '40-gallon water heater',
          materialQuantity: 2,
          vendor: 'Ferguson',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.vendor).toBe('Ferguson');
  });

  it('omits vendor entirely when not spoken (never fabricated)', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({ existingEntities: { materialDescription: 'flue liner kit' } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.vendor).toBeUndefined();
  });

  it('a resolvable materialNeededBy phrase with an explicit day is parsed to an ISO date', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({
        existingEntities: {
          materialDescription: '40-gallon water heater',
          materialNeededBy: 'October 1st',
        },
        now: new Date('2026-08-08T12:00:00Z'),
      } as never),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.neededBy).toBe('2026-10-01');
  });

  it('an unparseable/ambiguous materialNeededBy phrase is omitted, never gates (informational field)', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({
        existingEntities: {
          materialDescription: '40-gallon water heater',
          materialNeededBy: 'soonish',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.neededBy).toBeUndefined();
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('never auto-approves — omits sourceTrustTier (a deterministic, non-LLM capture handler)', async () => {
    const { proposal } = await new AddMaterialTaskHandler().handle(
      ctx({ existingEntities: { materialDescription: 'flue liner kit' } }),
    );

    expect(proposal.status).toBe('draft');
  });
});
