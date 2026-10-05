/**
 * #1613 — the memo/chat leg of `update_customer` (UpdateCustomerTaskHandler)
 * drafts the same normalised address the live-turn leg does
 * (proposals/voice-payload.ts): "ops at acme dot com" → `email: "ops@acme.com"`.
 *
 * Seam: the task handler's `handle`.
 */
import { describe, it, expect } from 'vitest';

import { UpdateCustomerTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';

describe('#1613 — UpdateCustomerTaskHandler drafts the normalised email', () => {
  it('a spoken address is drafted as the address', async () => {
    const res = await new UpdateCustomerTaskHandler().handle({
      tenantId: 't-1',
      userId: 'u-1',
      message: 'Please change the email on our account to ops at acme dot com.',
      customerId: 'cust-9',
      existingEntities: { updatedEmail: 'ops at acme dot com' },
    });

    expect(res.proposal.payload).toMatchObject({ customerId: 'cust-9', email: 'ops@acme.com' });
  });
});
