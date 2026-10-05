/**
 * #1613 — the `update_customer` draft carries the address the caller meant,
 * not the recogniser's spoken form of it: "ops at acme dot com" is drafted
 * as `email: "ops@acme.com"` (the same normalisation the readback spells
 * from), and a value that is not an address is drafted exactly as heard so
 * the operator sees what the caller confirmed.
 *
 * Seam: `buildVoiceProposalPayload`, the live-turn payload builder both phone
 * and in-app voice share.
 */
import { describe, it, expect } from 'vitest';

import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const deps = { tenantId: 'tenant-1' };
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

const input = (entities: Record<string, unknown>) => ({
  intent: 'update_customer' as const,
  proposalType: 'update_customer' as const,
  entities,
  envelope: { sessionId: 'sess-1' },
  callerCustomerId: CUSTOMER_ID,
});

describe('#1613 — update_customer drafts the normalised email', () => {
  it('a spoken address is drafted as the address', async () => {
    const result = await buildVoiceProposalPayload(input({ updatedEmail: 'ops at acme dot com' }), deps);

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ customerId: CUSTOMER_ID, email: 'ops@acme.com' });
  });

  it('a written address keeps its form, lower-cased', async () => {
    const result = await buildVoiceProposalPayload(input({ updatedEmail: 'Ops@Acme.com' }), deps);

    expect(result.payload).toMatchObject({ email: 'ops@acme.com' });
  });
});
