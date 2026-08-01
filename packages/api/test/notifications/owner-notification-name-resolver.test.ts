import { describe, it, expect, afterEach } from 'vitest';
import {
  setOwnerNotificationNameResolvers,
  resolveInvoiceCustomerName,
  resolveAppointmentCustomerName,
} from '../../src/notifications/owner-notification-name-resolver';

afterEach(() => setOwnerNotificationNameResolvers({}));

describe('owner-notification name resolver', () => {
  it('returns undefined when nothing is registered (caller falls back to a generic label)', async () => {
    expect(await resolveInvoiceCustomerName('t', 'inv-1')).toBeUndefined();
    expect(await resolveAppointmentCustomerName('t', 'appt-1')).toBeUndefined();
  });

  it('resolves the registered invoice / appointment customer name', async () => {
    setOwnerNotificationNameResolvers({
      invoiceCustomerName: async (_t, id) => (id === 'inv-1' ? 'Acme Co' : undefined),
      appointmentCustomerName: async (_t, id) => (id === 'appt-1' ? 'Jane Doe' : undefined),
    });
    expect(await resolveInvoiceCustomerName('t', 'inv-1')).toBe('Acme Co');
    expect(await resolveAppointmentCustomerName('t', 'appt-1')).toBe('Jane Doe');
    expect(await resolveInvoiceCustomerName('t', 'other')).toBeUndefined();
  });

  it('swallows resolver errors → undefined (a name lookup never breaks the push)', async () => {
    setOwnerNotificationNameResolvers({
      invoiceCustomerName: async () => {
        throw new Error('db down');
      },
    });
    expect(await resolveInvoiceCustomerName('t', 'inv-1')).toBeUndefined();
  });
});
