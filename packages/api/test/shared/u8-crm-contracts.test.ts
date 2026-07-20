/**
 * U8 (C3–C6) wire-contract pins.
 *
 * The mobile CRM client fns (packages/mobile/src/api/leads.ts + customers.ts)
 * post to DIRECT audited routes — convert_lead / mark_lead_lost /
 * add_service_location / add_note are NOT on the POST /api/proposals whitelist.
 * The mobile client tests mock `fetch`, so they can't prove the body shape the
 * server actually accepts. This test pins the exact JSON bodies those fns emit
 * against the REAL server Zod schemas (the "mocked-client-shape" learning:
 * mock-only tests once shipped nonexistent columns). If a column is renamed
 * server-side, the matching mobile client body fails here.
 *
 * Pinned API-side (not in the mobile test) on purpose: importing the shared/api
 * contracts into a mobile vitest drags Clerk transitive types through mobile
 * tsc (the U7 finding), so the cross-wire pin lives here.
 */
import { describe, expect, it } from 'vitest';
import { createServiceLocationSchema, createNoteSchema } from '../../src/shared/contracts';
import { convertLeadAddressSchema, loseLeadSchema } from '../../src/leads/enums';

describe('U8 CRM wire contracts', () => {
  describe('createServiceLocation → createServiceLocationSchema (C3)', () => {
    it('accepts the mobile client body (customerId + required address + optional label)', () => {
      const body = {
        customerId: 'c1',
        street1: '1 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        label: 'Rental unit',
      };
      expect(createServiceLocationSchema.parse(body)).toMatchObject(body);
    });

    it('accepts the minimal body without a label', () => {
      expect(() =>
        createServiceLocationSchema.parse({
          customerId: 'c1',
          street1: '1 Main St',
          city: 'Austin',
          state: 'TX',
          postalCode: '78701',
        }),
      ).not.toThrow();
    });

    it('rejects a body missing a required address field (empty city)', () => {
      expect(() =>
        createServiceLocationSchema.parse({
          customerId: 'c1',
          street1: '1 Main St',
          city: '',
          state: 'TX',
          postalCode: '78701',
        }),
      ).toThrow();
    });
  });

  describe('addCustomerNote → createNoteSchema (C6)', () => {
    it('accepts the entityType customer body', () => {
      const body = { entityType: 'customer', entityId: 'c1', content: 'Called back' };
      expect(createNoteSchema.parse(body)).toMatchObject(body);
    });

    it('accepts an optional isPinned flag', () => {
      expect(() =>
        createNoteSchema.parse({ entityType: 'customer', entityId: 'c1', content: 'Watch this', isPinned: true }),
      ).not.toThrow();
    });

    it('rejects empty content and an unknown entityType', () => {
      expect(() => createNoteSchema.parse({ entityType: 'customer', entityId: 'c1', content: '' })).toThrow();
      expect(() => createNoteSchema.parse({ entityType: 'widget', entityId: 'c1', content: 'x' })).toThrow();
    });
  });

  describe('markLeadLost → loseLeadSchema (C5)', () => {
    it('accepts a non-empty reason', () => {
      expect(loseLeadSchema.parse({ reason: 'went with a competitor' })).toEqual({
        reason: 'went with a competitor',
      });
    });

    it('rejects an empty reason (mirrors the reject-reason gate)', () => {
      expect(() => loseLeadSchema.parse({ reason: '' })).toThrow();
    });
  });

  describe('convertLead → convertLeadAddressSchema (C4)', () => {
    it('accepts a complete address override', () => {
      expect(() =>
        convertLeadAddressSchema.parse({ street1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' }),
      ).not.toThrow();
    });

    it('rejects a partial address (server completeness gate)', () => {
      expect(() => convertLeadAddressSchema.parse({ street1: '1 Main St' })).toThrow();
    });
  });
});
