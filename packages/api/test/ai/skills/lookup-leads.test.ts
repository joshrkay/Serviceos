import { describe, it, expect } from 'vitest';
import { lookupLeads } from '../../../src/ai/skills/lookup-leads';
import { InMemoryLeadRepository } from '../../../src/leads/lead';
import { createLead } from '../../../src/leads/lead-service';

describe('lookupLeads skill', () => {
  it('reports an empty pipeline when there are no open leads', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const res = await lookupLeads({ tenantId: 't-1' }, { leadRepo });
    expect(res.status).toBe('none');
    expect(res.data.openCount).toBe(0);
    expect(res.summary).toMatch(/no open leads/i);
  });

  it('counts only open (non-converted, non-lost) leads', async () => {
    const leadRepo = new InMemoryLeadRepository();
    await createLead(
      { tenantId: 't-1', firstName: 'Open', lastName: 'One', source: 'phone_call', createdBy: 'u-1' },
      leadRepo,
    );
    await createLead(
      { tenantId: 't-1', firstName: 'Open', lastName: 'Two', source: 'referral', createdBy: 'u-1' },
      leadRepo,
    );

    const res = await lookupLeads({ tenantId: 't-1' }, { leadRepo });
    expect(res.status).toBe('found');
    expect(res.data.openCount).toBe(2);
    expect(res.summary).toContain('2 open leads');
  });

  it('is tenant-scoped', async () => {
    const leadRepo = new InMemoryLeadRepository();
    await createLead(
      { tenantId: 't-other', firstName: 'Other', lastName: 'Tenant', source: 'phone_call', createdBy: 'u-1' },
      leadRepo,
    );
    const res = await lookupLeads({ tenantId: 't-1' }, { leadRepo });
    expect(res.data.openCount).toBe(0);
  });
});
