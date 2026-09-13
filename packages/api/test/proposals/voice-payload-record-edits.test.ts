/**
 * The RECORD-EDIT half of the voice payload contract: `update_customer`,
 * `update_job`, `send_estimate_nudge`, `send_payment_reminder`.
 *
 * All four were caught by the hermetic in-app 50-case register
 * (`fixtures/voice/inapp-50-cases.json`, cases cust-02 / job-02 / est-06 /
 * inv-08) failing in one of the two ways a payload builder can fail an
 * operator:
 *
 *   1. THE SILENT NO-OP — the payload validated but carried NO CHANGE.
 *      `updateCustomerPayloadSchema` requires only `customerId`, and the
 *      classifier's `updatedEmail`/`updatedPhone`/`updatedName`/
 *      `updatedAddress` were never aliased onto `email`/`phone`/`name`/
 *      `address`, so "update Khan's email to accounts@khan.test" minted a
 *      perfectly valid proposal that changed nothing on approval (cust-02).
 *
 *   2. THE APPROVE-TO-FAIL CARD — the payload failed a WHOLE-OBJECT refine,
 *      which Zod reports with `path: []`, so `fieldPathsFrom` could name no
 *      field and `missingFieldPaths` came back EMPTY. The draft persisted
 *      with `missingFields: []`, `approveProposal` had nothing to refuse on,
 *      and the operator's tap reached an execution handler that throws
 *      (job-02's `update_job` with no field to change; est-06's
 *      `send_estimate_nudge` with neither an estimateId nor a reference).
 *
 * Both failure modes are invisible to a test that only asserts `ok`, so every
 * case below asserts the PAYLOAD CONTENT or the named gate.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';
import type { ProposalType } from '../../src/proposals/proposal';

const deps = { tenantId: 'tenant-1' };
const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';
const INVOICE_ID = '33333333-3333-3333-3333-333333333333';
const ESTIMATE_ID = '44444444-4444-4444-4444-444444444444';

function build(
  intent: string,
  proposalType: ProposalType,
  entities: Record<string, unknown>,
  utterance?: string,
) {
  return buildVoiceProposalPayload(
    {
      intent,
      proposalType,
      entities,
      envelope: { sessionId: 'sess-1' },
      ...(utterance ? { utterance } : {}),
    },
    deps,
  );
}

describe('update_customer — the classifier`s updated* fields reach the contract', () => {
  it.each([
    ['updatedEmail', 'accounts@khan.test', 'email'],
    ['updatedPhone', '+14805550123', 'phone'],
    ['updatedName', 'Amir Khan', 'name'],
    ['updatedAddress', '104 QA Cedar Avenue, Phoenix AZ', 'address'],
  ])('%s → payload.%s', async (source, value, target) => {
    const result = await build('update_customer', 'update_customer', {
      customerId: CUSTOMER_ID,
      customerName: 'Khan',
      [source]: value,
    });
    expect(result.ok).toBe(true);
    expect(result.payload[target]).toBe(value);
  });

  it('cust-02 end to end: "update Khan\'s email" carries the new email, not just a valid shell', async () => {
    const result = await build('update_customer', 'update_customer', {
      customerName: 'Khan',
      updatedEmail: 'accounts@khan.test',
      customerId: CUSTOMER_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      customerId: CUSTOMER_ID,
      email: 'accounts@khan.test',
    });
  });

  it('an edit that names NO new value is gated, never a silently valid no-op', async () => {
    const result = await build('update_customer', 'update_customer', {
      customerId: CUSTOMER_ID,
      customerName: 'Khan',
    });
    // The contract itself is SATISFIED — `updateCustomerPayloadSchema`
    // requires only `customerId` — which is exactly why the gate cannot live
    // on `ok`. `missingFieldPaths` answers the different question ("can a
    // human approve this as it stands"), so both surfaces persist an
    // editable draft `approveProposal` will refuse until a value is filled.
    expect(result.ok).toBe(true);
    expect(result.missingFieldPaths).toEqual(['updatedField']);
  });

  it('a completed edit carries no gate', async () => {
    const result = await build('update_customer', 'update_customer', {
      customerId: CUSTOMER_ID,
      updatedPhone: '+14805550123',
    });
    expect(result.ok).toBe(true);
    expect(result.missingFieldPaths).toEqual([]);
  });

  it('a value the drafting leg already put on the contract field wins over the alias', async () => {
    const result = await build('update_customer', 'update_customer', {
      customerId: CUSTOMER_ID,
      email: 'resolved@khan.test',
      updatedEmail: 'spoken@khan.test',
    });
    expect(result.ok).toBe(true);
    expect(result.payload.email).toBe('resolved@khan.test');
  });
});

describe('update_job — the spoken status/priority is parsed, or the card is gated', () => {
  it('job-02: "Set Johnson\'s water heater job to in progress" → status in_progress', async () => {
    const result = await build(
      'update_job',
      'update_job',
      { jobId: JOB_ID, jobReference: 'water heater job', customerName: 'Johnson' },
      "Set Johnson's water heater job to in progress",
    );
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ jobId: JOB_ID, status: 'in_progress' });
  });

  it('"mark the Henderson job as urgent priority" → priority urgent', async () => {
    const result = await build(
      'update_job',
      'update_job',
      { jobId: JOB_ID, jobReference: 'Henderson' },
      'Mark the Henderson job as urgent priority',
    );
    expect(result.ok).toBe(true);
    expect(result.payload.priority).toBe('urgent');
  });

  it('NO utterance and no field → gated on status, never minted invalid with an empty gate', async () => {
    const result = await build('update_job', 'update_job', {
      jobId: JOB_ID,
      jobReference: 'water heater job',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFieldPaths).toEqual(['status']);
  });

  it('an utterance naming no status/priority is gated, not guessed at', async () => {
    const result = await build(
      'update_job',
      'update_job',
      { jobId: JOB_ID },
      'Do something about the Johnson job',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFieldPaths).toEqual(['status']);
    expect(result.payload.status).toBeUndefined();
  });

  it('a status the drafting leg (UpdateJobTaskHandler) already set is never overwritten by the parse', async () => {
    const result = await build(
      'update_job',
      'update_job',
      { jobId: JOB_ID, status: 'completed' },
      // Says "in progress", but the memo leg already decided: it wins.
      'Set the Johnson job to in progress',
    );
    expect(result.ok).toBe(true);
    expect(result.payload.status).toBe('completed');
  });
});

describe('send_estimate_nudge — never an ungated contract failure', () => {
  it('est-06: a customer-only nudge with no resolved estimate is gated on estimateId', async () => {
    const result = await build('send_estimate_nudge', 'send_estimate_nudge', {
      customerName: 'Khan',
      customerId: CUSTOMER_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFieldPaths).toEqual(['estimateId']);
  });

  it('the customer-anchored estimate lookup having resolved an id clears the gate', async () => {
    const result = await build('send_estimate_nudge', 'send_estimate_nudge', {
      customerName: 'Khan',
      customerId: CUSTOMER_ID,
      estimateId: ESTIMATE_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.payload.estimateId).toBe(ESTIMATE_ID);
  });

  it('a spoken estimate reference alone satisfies the contract (the refine accepts either)', async () => {
    const result = await build('send_estimate_nudge', 'send_estimate_nudge', {
      estimateReference: 'EST-0001',
    });
    expect(result.ok).toBe(true);
  });
});

describe('send_payment_reminder — the manual dunning-step defaults', () => {
  it('inv-08: a resolved invoice + manual step defaults satisfy the contract', async () => {
    const result = await build('send_payment_reminder', 'send_payment_reminder', {
      customerName: 'Johnson',
      customerId: CUSTOMER_ID,
      invoiceId: INVOICE_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      invoiceId: INVOICE_ID,
      // The exact shape SendPaymentReminderExecutionHandler reads as ad-hoc.
      stepKey: 'manual',
      offsetDays: 0,
      channel: 'sms',
      invoiceReference: 'Johnson',
    });
  });

  it('a spoken channel wins over the sms default (same precedence as the task handler)', async () => {
    const result = await build('send_payment_reminder', 'send_payment_reminder', {
      customerId: CUSTOMER_ID,
      invoiceId: INVOICE_ID,
      sendChannel: 'email',
    });
    expect(result.ok).toBe(true);
    expect(result.payload.channel).toBe('email');
  });

  it('a spoken jobReference is preferred over the customer name for invoiceReference', async () => {
    const result = await build('send_payment_reminder', 'send_payment_reminder', {
      customerName: 'Johnson',
      jobReference: 'INV-0042',
      customerId: CUSTOMER_ID,
      invoiceId: INVOICE_ID,
    });
    expect(result.payload.invoiceReference).toBe('INV-0042');
  });

  it('no resolved invoice keeps its existing invoiceId gate (defaults never mask it)', async () => {
    const result = await build('send_payment_reminder', 'send_payment_reminder', {
      customerName: 'Johnson',
      customerId: CUSTOMER_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFieldPaths).toContain('invoiceId');
  });
});
