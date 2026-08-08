/**
 * Tradesperson wave 1, Task 5 — send_customer_message proposal type.
 *
 * `send_customer_message` is a NEW comms-class proposal type for a
 * free-form, owner-approved outbound customer message ("Text the
 * Hendersons the part arrived", "Email the Garcias that the inspection
 * passed"). The AI drafts the exact text; the owner ALWAYS approves it
 * before a customer sees it — comms-class never auto-approves at any
 * trust tier (D3), same as notify_delay / send_invoice / request_feedback.
 *
 * The execution handler routes through a `CustomerMessenger` structural
 * dependency — production wires `TwilioCustomerMessageService`
 * (notifications/twilio-customer-message-service.ts), which sends through
 * the SAME `MessageDeliveryProvider` (and its TCPA consent + DNC + kill-
 * switch gates) `TwilioDelayNotificationService` already uses. A thrown
 * gate refusal (no consent, DNC, channel disabled, no phone/email on file)
 * must surface as `{ success: false, error }`, never a silent success.
 */
import { describe, it, expect } from 'vitest';
import {
  Proposal,
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import {
  SendCustomerMessageExecutionHandler,
  type CustomerMessenger,
  type CustomerMessengerInput,
} from '../../src/proposals/execution/send-customer-message-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT_ID = 't-1';
const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: TENANT_ID,
    proposalType: 'send_customer_message',
    status: 'approved',
    payload,
    summary: 'Message the Hendersons',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('send_customer_message proposal type', () => {
  it('is a valid proposal type classified as comms (never auto-approves)', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('send_customer_message');
    expect(actionClassForProposalType('send_customer_message')).toBe('comms');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('send_customer_message', {
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: 'Your part arrived — we can come Thursday morning.',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an empty body', () => {
    const result = validateProposalPayload('send_customer_message', {
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: '',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a whitespace-only body', () => {
    const result = validateProposalPayload('send_customer_message', {
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: '   ',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown channel', () => {
    const result = validateProposalPayload('send_customer_message', {
      customerId: CUSTOMER_ID,
      channel: 'carrier_pigeon',
      body: 'hello',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a body over 1000 characters', () => {
    const result = validateProposalPayload('send_customer_message', {
      customerId: CUSTOMER_ID,
      channel: 'sms',
      body: 'x'.repeat(1001),
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a body at exactly 1000 characters', () => {
    const result = validateProposalPayload('send_customer_message', {
      customerId: CUSTOMER_ID,
      channel: 'email',
      body: 'x'.repeat(1000),
      subject: 'Your inspection results',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a missing customerId', () => {
    const result = validateProposalPayload('send_customer_message', {
      channel: 'sms',
      body: 'hello',
    });
    expect(result.valid).toBe(false);
  });

  it('degrades to a synthetic id without a messenger wired', async () => {
    const handler = new SendCustomerMessageExecutionHandler();
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(
      makeProposal({ customerId: CUSTOMER_ID, channel: 'sms', body: 'Your part arrived.' }),
      { tenantId: TENANT_ID, executedBy: 'u-1' },
    );
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });

  describe('wired against a stubbed CustomerMessenger', () => {
    it('reports isFullyWired() true once a messenger is supplied', () => {
      const messenger: CustomerMessenger = {
        sendCustomMessage: async () => ({ dispatchId: 'd1' }),
      };
      const handler = new SendCustomerMessageExecutionHandler(messenger);
      expect(handler.isFullyWired()).toBe(true);
    });

    it('sends through the messenger, passing tenantId/customerId/channel/body/actorId/idempotencyKey, and reports success', async () => {
      let received: CustomerMessengerInput | undefined;
      const messenger: CustomerMessenger = {
        sendCustomMessage: async (input) => {
          received = input;
          return { dispatchId: 'd1' };
        },
      };
      const auditRepo = new InMemoryAuditRepository();
      const handler = new SendCustomerMessageExecutionHandler(messenger, auditRepo);

      const result = await handler.execute(
        makeProposal({
          customerId: CUSTOMER_ID,
          channel: 'sms',
          body: 'Your part arrived — we can come Thursday morning.',
        }),
        { tenantId: TENANT_ID, executedBy: 'u-1' },
      );

      expect(result.success).toBe(true);
      expect(received).toEqual({
        tenantId: TENANT_ID,
        customerId: CUSTOMER_ID,
        channel: 'sms',
        body: 'Your part arrived — we can come Thursday morning.',
        actorId: 'u-1',
        // Provider-level dedup key (quality-review fix) — closes the
        // crash-between-send-and-marker double-text window. Mirrors
        // TwilioDelayNotificationService's idempotencyKey pass-through.
        idempotencyKey: 'send_customer_message:prop-1:sms',
      });

      const events = auditRepo.getAll();
      const sent = events.find((e) => e.eventType === 'customer_message.sent');
      expect(sent).toBeDefined();
      expect(sent?.entityType).toBe('customer');
      expect(sent?.entityId).toBe(CUSTOMER_ID);
      expect(sent?.metadata).toMatchObject({
        proposalId: 'prop-1',
        channel: 'sms',
        dispatchId: 'd1',
      });
    });

    it('derives a channel-scoped idempotencyKey (email proposal → :email suffix, not :sms)', async () => {
      let received: CustomerMessengerInput | undefined;
      const messenger: CustomerMessenger = {
        sendCustomMessage: async (input) => {
          received = input;
          return { dispatchId: 'd3' };
        },
      };
      const handler = new SendCustomerMessageExecutionHandler(messenger);

      await handler.execute(
        makeProposal({ customerId: CUSTOMER_ID, channel: 'email', body: 'Inspection passed.' }),
        { tenantId: TENANT_ID, executedBy: 'u-1' },
      );

      expect(received?.idempotencyKey).toBe('send_customer_message:prop-1:email');
    });

    it('threads an optional subject through when present (email)', async () => {
      let received: CustomerMessengerInput | undefined;
      const messenger: CustomerMessenger = {
        sendCustomMessage: async (input) => {
          received = input;
          return { dispatchId: 'd2' };
        },
      };
      const handler = new SendCustomerMessageExecutionHandler(messenger);

      await handler.execute(
        makeProposal({
          customerId: CUSTOMER_ID,
          channel: 'email',
          body: 'The inspection passed.',
          subject: 'Inspection results',
        }),
        { tenantId: TENANT_ID, executedBy: 'u-1' },
      );

      expect(received?.subject).toBe('Inspection results');
    });

    it('surfaces a thrown consent/TCPA gate refusal as an honest failure, never a silent success', async () => {
      const messenger: CustomerMessenger = {
        sendCustomMessage: async () => {
          throw new Error('SMS suppressed: no_consent');
        },
      };
      const handler = new SendCustomerMessageExecutionHandler(messenger);

      const result = await handler.execute(
        makeProposal({ customerId: CUSTOMER_ID, channel: 'sms', body: 'Your part arrived.' }),
        { tenantId: TENANT_ID, executedBy: 'u-1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('SMS suppressed: no_consent');
    });

    it('rejects an invalid payload without touching the messenger', async () => {
      let called = false;
      const messenger: CustomerMessenger = {
        sendCustomMessage: async () => {
          called = true;
          return {};
        },
      };
      const handler = new SendCustomerMessageExecutionHandler(messenger);

      const result = await handler.execute(
        makeProposal({ customerId: 'not-a-uuid', channel: 'sms', body: 'hi' }),
        { tenantId: TENANT_ID, executedBy: 'u-1' },
      );

      expect(result.success).toBe(false);
      expect(called).toBe(false);
    });
  });
});
