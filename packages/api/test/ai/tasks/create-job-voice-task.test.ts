/**
 * B6 fix 1 — CreateJobVoiceTaskHandler consumes the router's resolved
 * customerId instead of unconditionally gating it.
 *
 * Before this fix, the handler read only `entitiesFrom(context).customerName`
 * (the spoken reference) and ALWAYS pushed `customerId` onto `missing`, even
 * when the router's entity resolver (workers/voice-action-router.ts) had
 * already resolved a unique customer match onto
 * `context.existingEntities.customerId`. Every create_job stalled at review
 * even on an unambiguous resolution. Mirrors
 * LogTimeEntryTaskHandler/CreateInvoiceScheduleTaskHandler's resolved-id
 * consumption pattern (full-app-voice-tasks.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { CreateJobVoiceTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'create a job for the Henderson account',
    ...overrides,
  };
}

const RESOLVED_CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

describe('CreateJobVoiceTaskHandler', () => {
  it('consumes a router-resolved customerId — not gated, lands on the payload', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({
        existingEntities: {
          customerId: RESOLVED_CUSTOMER_ID,
          customerName: 'Henderson',
          jobTitle: 'Kitchen remodel',
        },
      }),
    );

    expect((proposal.payload as Record<string, unknown>).customerId).toBe(RESOLVED_CUSTOMER_ID);
    // The spoken reference is still carried for display/traceability.
    expect((proposal.payload as Record<string, unknown>).customerReference).toBe('Henderson');
    expect(missingFieldsFor(proposal)).not.toContain('customerId');
  });

  it('gates customerId when the router resolved no id (name-only reference)', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({
        existingEntities: {
          customerName: 'Henderson',
          jobTitle: 'Kitchen remodel',
        },
      }),
    );

    expect((proposal.payload as Record<string, unknown>).customerId).toBeUndefined();
    expect((proposal.payload as Record<string, unknown>).customerReference).toBe('Henderson');
    expect(missingFieldsFor(proposal)).toContain('customerId');
  });

  it('gates customerId when existingEntities is entirely absent', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({ existingEntities: { jobTitle: 'Kitchen remodel' } }),
    );

    expect(missingFieldsFor(proposal)).toContain('customerId');
  });

  it('ignores a non-string existingEntities.customerId (defensive)', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({
        existingEntities: {
          customerId: 12345, // deliberately malformed to prove the type guard
          customerName: 'Henderson',
          jobTitle: 'Kitchen remodel',
        },
      }),
    );

    expect((proposal.payload as Record<string, unknown>).customerId).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('customerId');
  });

  it('title gating is unchanged: jobTitle maps to title', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({
        existingEntities: {
          customerId: RESOLVED_CUSTOMER_ID,
          jobTitle: 'Kitchen remodel',
        },
      }),
    );

    expect((proposal.payload as Record<string, unknown>).title).toBe('Kitchen remodel');
    expect(missingFieldsFor(proposal)).not.toContain('title');
  });

  it('title gating is unchanged: falls back to jobReference when jobTitle is absent', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({
        existingEntities: {
          customerId: RESOLVED_CUSTOMER_ID,
          jobReference: 'the kitchen job',
        },
      }),
    );

    expect((proposal.payload as Record<string, unknown>).title).toBe('the kitchen job');
    expect(missingFieldsFor(proposal)).not.toContain('title');
  });

  it('title gating is unchanged: flags title missing when neither jobTitle nor jobReference is present', async () => {
    const { proposal } = await new CreateJobVoiceTaskHandler().handle(
      ctx({ existingEntities: { customerId: RESOLVED_CUSTOMER_ID } }),
    );

    expect((proposal.payload as Record<string, unknown>).title).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('title');
  });
});
