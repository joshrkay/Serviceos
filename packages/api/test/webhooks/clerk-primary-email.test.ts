import { describe, it, expect } from 'vitest';
import { clerkPrimaryEmail } from '../../src/webhooks/clerk-primary-email';
import { clerkUserCreatedEvent } from '../support/clerk-user-created';

describe('clerkPrimaryEmail', () => {
  it('returns the primary address and verified=true when Clerk reports it verified', () => {
    const { data } = clerkUserCreatedEvent({
      userId: 'user_1',
      emails: [{ address: 'pat@example.com', status: 'verified' }],
    });
    expect(clerkPrimaryEmail(data)).toEqual({ address: 'pat@example.com', verified: true });
  });

  it.each(['unverified', 'transferable', 'failed', 'expired', null] as const)(
    'reports verified=false for a primary whose verification is %s',
    (status) => {
      const { data } = clerkUserCreatedEvent({
        userId: 'user_1',
        emails: [{ address: 'pat@example.com', status }],
      });
      expect(clerkPrimaryEmail(data)).toEqual({ address: 'pat@example.com', verified: false });
    },
  );

  it('picks the address named by primary_email_address_id, not the first entry', () => {
    const { data } = clerkUserCreatedEvent({
      userId: 'user_1',
      emails: [
        { address: 'first@example.com', status: 'unverified' },
        { address: 'primary@example.com', status: 'verified' },
      ],
      primaryIndex: 1,
    });
    expect(clerkPrimaryEmail(data)).toEqual({ address: 'primary@example.com', verified: true });
  });

  it('does not borrow verification from a non-primary address', () => {
    const { data } = clerkUserCreatedEvent({
      userId: 'user_1',
      emails: [
        { address: 'other@example.com', status: 'verified' },
        { address: 'primary@example.com', status: 'unverified' },
      ],
      primaryIndex: 1,
    });
    expect(clerkPrimaryEmail(data)).toEqual({ address: 'primary@example.com', verified: false });
  });

  it('falls back to the first address when the payload names no primary', () => {
    const { data } = clerkUserCreatedEvent({
      userId: 'user_1',
      emails: [{ address: 'only@example.com', status: 'verified' }],
      primaryIndex: null,
    });
    expect(clerkPrimaryEmail(data)).toEqual({ address: 'only@example.com', verified: true });
  });

  it('keeps the first address but never verified when the named primary is missing from the list', () => {
    const data = {
      id: 'user_1',
      primary_email_address_id: 'idn_missing',
      email_addresses: [
        { id: 'idn_other', email_address: 'other@example.com', verification: { status: 'verified' } },
      ],
    };
    expect(clerkPrimaryEmail(data)).toEqual({ address: 'other@example.com', verified: false });
  });

  it('treats the legacy bare { email_address } shape as unverified', () => {
    expect(clerkPrimaryEmail({ email_addresses: [{ email_address: 'bare@example.com' }] })).toEqual({
      address: 'bare@example.com',
      verified: false,
    });
  });

  it.each([
    ['no email_addresses', {}],
    ['an empty list', { email_addresses: [] }],
    ['a non-array', { email_addresses: 'pat@example.com' }],
    ['a blank address', { email_addresses: [{ email_address: '   ' }] }],
    ['a non-string address', { email_addresses: [{ email_address: 42 }] }],
    ['a null entry', { email_addresses: [null] }],
    ['a non-object payload', null],
  ])('returns null for %s', (_label, data) => {
    expect(clerkPrimaryEmail(data)).toBeNull();
  });
});
