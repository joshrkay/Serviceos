import { describe, it, expect, beforeEach } from 'vitest';
import { createLead, shouldAutoRespondToLead } from '../../src/leads/lead-service';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryQueue } from '../../src/queues/queue';
import { LEAD_AUTO_RESPONSE_JOB_TYPE } from '../../src/workers/lead-auto-response';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('createLead — speed-to-lead enqueue (LC-3)', () => {
  let leadRepo: InMemoryLeadRepository;
  let queue: InMemoryQueue;

  beforeEach(() => {
    leadRepo = new InMemoryLeadRepository();
    queue = new InMemoryQueue();
  });

  it('enqueues an auto-response for an inbound web_form lead with a contact channel', async () => {
    await createLead(
      { tenantId: TENANT, firstName: 'Ada', primaryPhone: '5125550100', source: 'web_form', createdBy: 'x', queue },
      leadRepo,
    );
    expect(queue.size()).toBe(1);
    const job = await queue.receive();
    expect(job?.type).toBe(LEAD_AUTO_RESPONSE_JOB_TYPE);
    expect((job?.payload as { tenantId: string }).tenantId).toBe(TENANT);
  });

  it('does not enqueue for a phone_call lead (the call handles the reply)', async () => {
    await createLead(
      { tenantId: TENANT, firstName: 'Ada', primaryPhone: '5125550100', source: 'phone_call', createdBy: 'x', queue },
      leadRepo,
    );
    expect(queue.size()).toBe(0);
  });

  it('does not enqueue when there is no contact channel', async () => {
    await createLead(
      { tenantId: TENANT, companyName: 'Acme', source: 'web_form', createdBy: 'x', queue },
      leadRepo,
    );
    expect(queue.size()).toBe(0);
  });

  it('does not throw and does not enqueue when no queue is wired', async () => {
    const lead = await createLead(
      { tenantId: TENANT, firstName: 'Ada', primaryPhone: '5125550100', source: 'web_form', createdBy: 'x' },
      leadRepo,
    );
    expect(lead.id).toBeTruthy();
  });

  it('shouldAutoRespondToLead gates on inbound source + contact channel', () => {
    expect(shouldAutoRespondToLead({ source: 'web_form', primaryPhone: '5125550100' })).toBe(true);
    expect(shouldAutoRespondToLead({ source: 'marketplace', email: 'a@b.com' })).toBe(true);
    expect(shouldAutoRespondToLead({ source: 'phone_call', primaryPhone: '5125550100' })).toBe(false);
    expect(shouldAutoRespondToLead({ source: 'walk_in', primaryPhone: '5125550100' })).toBe(false);
    expect(shouldAutoRespondToLead({ source: 'web_form' })).toBe(false);
  });
});
