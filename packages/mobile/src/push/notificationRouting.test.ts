import { describe, expect, it } from 'vitest';
import type { NotificationType } from '@ai-service-os/shared';
import { routeForNotification } from './notificationRouting';

describe('routeForNotification', () => {
  it('uses an explicit allowlisted screen path when present', () => {
    expect(
      routeForNotification({
        type: 'proposal_needs_approval',
        screen: '/proposals/p1',
        proposalId: 'p1',
        kind: 'needs_approval',
      }),
    ).toBe('/proposals/p1');
  });

  it('derives the review route from proposalId when screen is absent', () => {
    expect(routeForNotification({ proposalId: 'abc', kind: 'executed' })).toBe('/proposals/abc');
  });

  it('allows the Today tab for technician schedule reminders', () => {
    expect(routeForNotification({ screen: '/today' })).toBe('/today');
  });

  // Each notification type carries the producer-set `screen`; the router returns
  // it verbatim once it passes the allowlist. One case per NotificationType.
  const perTypeCases: Array<{ type: NotificationType; screen: string; expected: string }> = [
    { type: 'incoming_call', screen: '/customers/c1', expected: '/customers/c1' },
    { type: 'inbound_sms', screen: '/messages/m1', expected: '/messages/m1' },
    { type: 'appointment_reminder', screen: '/schedule', expected: '/schedule' },
    { type: 'appointment_cancellation', screen: '/schedule', expected: '/schedule' },
    { type: 'payment_received', screen: '/invoices', expected: '/invoices' },
    { type: 'invoice_overdue', screen: '/invoices', expected: '/invoices' },
    { type: 'lead_captured', screen: '/customers/c2', expected: '/customers/c2' },
    { type: 'escalation', screen: '/approvals', expected: '/approvals' },
    { type: 'emergency', screen: '/proposals/p2', expected: '/proposals/p2' },
    { type: 'proposal_needs_approval', screen: '/proposals/p3', expected: '/proposals/p3' },
    { type: 'proposal_executed', screen: '/proposals/p4', expected: '/proposals/p4' },
  ];

  it.each(perTypeCases)('routes $type → $expected', ({ type, screen, expected }) => {
    expect(routeForNotification({ type, screen })).toBe(expected);
  });

  it('falls back to Home for a screen outside the allowlist', () => {
    // Unknown top-level route.
    expect(routeForNotification({ type: 'incoming_call', screen: '/settings/secret' })).toBe('/');
    // A list route that isn't allowlisted.
    expect(routeForNotification({ type: 'payment_received', screen: '/estimates' })).toBe('/');
    // A detail prefix with no id segment.
    expect(routeForNotification({ type: 'inbound_sms', screen: '/messages/' })).toBe('/');
    // A detail prefix with a nested path (would escape the known screen).
    expect(routeForNotification({ type: 'inbound_sms', screen: '/messages/m1/edit' })).toBe('/');
    // An exact-route prefix used as a detail route is not allowlisted.
    expect(routeForNotification({ type: 'invoice_overdue', screen: '/invoices/i1' })).toBe('/');
  });

  it('falls back to Home for empty / malformed payloads', () => {
    expect(routeForNotification(null)).toBe('/');
    expect(routeForNotification(undefined)).toBe('/');
    expect(routeForNotification({})).toBe('/');
    expect(routeForNotification({ kind: 'executed' })).toBe('/');
    expect(routeForNotification({ proposalId: '' })).toBe('/');
    // Not an absolute path → rejected, then no proposalId → Home.
    expect(routeForNotification({ screen: 'proposals/p1' })).toBe('/');
    // A non-string screen must not throw.
    expect(routeForNotification({ screen: 42 as unknown as string })).toBe('/');
  });

  it('prefers an allowlisted screen over the legacy proposalId', () => {
    expect(
      routeForNotification({ type: 'inbound_sms', screen: '/messages/m9', proposalId: 'p9' }),
    ).toBe('/messages/m9');
  });

  it('uses the legacy proposalId when the screen is present but disallowed', () => {
    expect(
      routeForNotification({ type: 'emergency', screen: '/danger', proposalId: 'p7' }),
    ).toBe('/proposals/p7');
  });
});
