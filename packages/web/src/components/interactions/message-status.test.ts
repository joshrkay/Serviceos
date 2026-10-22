import { describe, it, expect } from 'vitest';
import { blockReasonLabel, summarizeMessage, type MessageDispatch } from './message-status';

const TZ = 'America/New_York';

function dispatch(overrides: Partial<MessageDispatch>): MessageDispatch {
  return {
    id: 'd1',
    entityType: 'thank_you',
    entityId: 'job-1',
    channel: 'sms',
    recipient: '+15125550100',
    provider: 'twilio',
    status: 'sent',
    sentAt: '2026-10-21T18:00:00Z',
    ...overrides,
  };
}

describe('summarizeMessage', () => {
  it('a sent text reads as sent, in good standing', () => {
    const s = summarizeMessage(dispatch({}), TZ);
    expect(s.headline).toBe('Text sent');
    expect(s.tone).toBe('ok');
    expect(s.when).toMatch(/2:00/);
  });

  it('a delivered text uses the delivery time', () => {
    const s = summarizeMessage(dispatch({ status: 'delivered', deliveredAt: '2026-10-21T19:30:00Z' }), TZ);
    expect(s.headline).toBe('Text delivered');
    expect(s.when).toMatch(/3:30/);
  });

  it('a held text says when it goes out', () => {
    const s = summarizeMessage(
      dispatch({ status: 'scheduled', scheduledFor: '2026-10-22T12:00:00Z', provider: 'unknown' }),
      TZ,
    );
    expect(s.headline).toBe('Text held until morning');
    expect(s.tone).toBe('pending');
    expect(s.when).toMatch(/^Goes out .*8:00/);
  });

  it('a blocked text gives the reason in plain words', () => {
    const s = summarizeMessage(dispatch({ status: 'blocked', blockReason: 'revoked' }), TZ);
    expect(s.headline).toBe('Text not sent: the customer opted out of texts');
    expect(s.tone).toBe('problem');
  });

  it('a blocked text with no recorded reason says so instead of going quiet', () => {
    const s = summarizeMessage(dispatch({ status: 'blocked' }), TZ);
    expect(s.headline).toBe('Text not sent: no reason was recorded');
  });

  it('failed and bounced read as problems; email says Email', () => {
    expect(summarizeMessage(dispatch({ status: 'failed' }), TZ)).toMatchObject({ headline: 'Text failed', tone: 'problem' });
    expect(summarizeMessage(dispatch({ status: 'bounced', channel: 'email' }), TZ)).toMatchObject({
      headline: 'Email bounced',
      tone: 'problem',
    });
  });
});

describe('blockReasonLabel', () => {
  it('names every reason outbound messaging can block with', () => {
    for (const reason of [
      'no_consent', 'revoked', 'dnc', 'missing_consent_context', 'channel_disabled',
      'recipient_volume_cap', 'customer_not_found', 'no_phone', 'no_marketing_consent', 'send_failed',
    ]) {
      expect(blockReasonLabel(reason)).not.toContain('_');
    }
  });

  it('falls back to the raw reason, made readable, for one it does not know', () => {
    expect(blockReasonLabel('new_reason')).toBe('new reason');
  });
});
