/**
 * Full-app voice coverage — task handlers + execution for the new
 * update_customer / log_expense / convert_lead intents.
 *
 * These mirror the existing voice-extended-tasks pattern: the handler
 * is a passthrough from the classifier's ExtractedEntities to a typed
 * proposal payload, flagging missing fields so a partial payload can
 * never auto-execute.
 */
import { describe, it, expect } from 'vitest';
import {
  UpdateCustomerTaskHandler,
  LogExpenseTaskHandler,
  ConvertLeadTaskHandler,
} from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { ConvertLeadExecutionHandler } from '../../../src/proposals/execution/convert-lead-handler';
import { Proposal, ProposalType, missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemoryLeadRepository } from '../../../src/leads/lead';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import { createLead } from '../../../src/leads/lead-service';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'test transcript',
    ...overrides,
  };
}

describe('UpdateCustomerTaskHandler', () => {
  it('uses the identified caller id and maps updated fields onto the payload', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({
        customerId: 'cust-9',
        existingEntities: { updatedPhone: '+15555550143' },
      }),
    );
    expect(res.proposal.proposalType).toBe('update_customer');
    expect(res.proposal.payload.customerId).toBe('cust-9');
    expect(res.proposal.payload.phone).toBe('+15555550143');
    expect(missingFieldsFor(res.proposal)).not.toContain('customerId');
  });

  it('flags customerId missing on the operator path (no caller identity)', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Sarah', updatedEmail: 'a@b.co' } }),
    );
    expect(res.proposal.payload.customerReference).toBe('Sarah');
    expect(missingFieldsFor(res.proposal)).toContain('customerId');
  });

  it('flags an absent change as a missing updatedField', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({ customerId: 'cust-9', existingEntities: {} }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('updatedField');
  });
});

describe('LogExpenseTaskHandler', () => {
  it('maps amount, category and vendor; defaults spentAt to today', async () => {
    const res = await new LogExpenseTaskHandler().handle(
      ctx({
        existingEntities: {
          amount: 24000,
          expenseCategory: 'materials',
          vendor: 'Supply House',
          expenseDescription: 'water heater parts',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('log_expense');
    expect(res.proposal.payload.amountCents).toBe(24000);
    expect(res.proposal.payload.category).toBe('materials');
    expect(res.proposal.payload.vendor).toBe('Supply House');
    expect(res.proposal.payload.spentAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(missingFieldsFor(res.proposal)).not.toContain('amountCents');
  });

  it('flags amountCents missing and defaults category to other', async () => {
    const res = await new LogExpenseTaskHandler().handle(
      ctx({ existingEntities: {} }),
    );
    expect(res.proposal.payload.category).toBe('other');
    expect(missingFieldsFor(res.proposal)).toContain('amountCents');
  });
});

describe('ConvertLeadTaskHandler', () => {
  it('carries the lead reference and always flags leadId missing', async () => {
    const res = await new ConvertLeadTaskHandler().handle(
      ctx({ existingEntities: { leadReference: 'the Johnson lead' } }),
    );
    expect(res.proposal.proposalType).toBe('convert_lead');
    expect(res.proposal.payload.leadReference).toBe('the Johnson lead');
    expect(missingFieldsFor(res.proposal)).toContain('leadId');
  });
});

function approved(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType,
    status: 'approved',
    payload,
    summary: 'test',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('ConvertLeadExecutionHandler', () => {
  it('rejects when leadId is unresolved', async () => {
    const handler = new ConvertLeadExecutionHandler();
    const res = await handler.execute(approved('convert_lead', { leadReference: 'x' }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });
    expect(res.success).toBe(false);
  });

  it('converts a real lead into a customer via the shared service', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const lead = await createLead(
      {
        tenantId: 't-1',
        firstName: 'Jane',
        lastName: 'Smith',
        primaryPhone: '+15555550100',
        source: 'phone_call',
        createdBy: 'u-1',
      },
      leadRepo,
    );

    const handler = new ConvertLeadExecutionHandler(leadRepo, customerRepo);
    const res = await handler.execute(approved('convert_lead', { leadId: lead.id }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });

    expect(res.success).toBe(true);
    expect(res.resultEntityId).toBeDefined();
    const refreshed = await leadRepo.findById('t-1', lead.id);
    expect(refreshed?.convertedCustomerId).toBe(res.resultEntityId);
  });
});
