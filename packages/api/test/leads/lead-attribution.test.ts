/**
 * Lead → cash source-attribution chain tests.
 *
 * Proves: a lead created with UTM data threads its lead.id forward through
 * customer → job → invoice, so a payment can be traced back to the
 * originating campaign.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import {
  convertToCustomer,
  createLead,
} from '../../src/leads/lead-service';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import {
  InMemoryInvoiceRepository,
  createInvoice,
} from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLeadSchema } from '../../src/leads/enums';

const TENANT = '00000000-0000-4000-8000-0000000000ab';

describe('lead-to-cash source attribution', () => {
  let leadRepo: InMemoryLeadRepository;
  let customerRepo: InMemoryCustomerRepository;
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    leadRepo = new InMemoryLeadRepository();
    customerRepo = new InMemoryCustomerRepository();
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('round-trips UTM + attribution fields through createLead', async () => {
    const lead = await createLead(
      {
        tenantId: TENANT,
        firstName: 'Test',
        source: 'web_form',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring_promo',
        attribution: { gclid: 'abc123', referrer: 'https://google.com/' },
        createdBy: 'public_intake',
      },
      leadRepo,
      auditRepo
    );

    expect(lead.utmSource).toBe('google');
    expect(lead.utmMedium).toBe('cpc');
    expect(lead.utmCampaign).toBe('spring_promo');
    expect(lead.attribution).toEqual({ gclid: 'abc123', referrer: 'https://google.com/' });

    const events = await auditRepo.findByEntity(TENANT, 'lead', lead.id);
    const created = events.find((e) => e.eventType === 'lead.created');
    expect(created?.metadata).toMatchObject({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'spring_promo',
    });
  });

  it('threads lead.id forward: lead → customer → job → invoice', async () => {
    // 1. Create lead with attribution.
    const lead = await createLead(
      {
        tenantId: TENANT,
        firstName: 'Sandra',
        lastName: 'Wu',
        primaryPhone: '+15125550100',
        source: 'web_form',
        utmSource: 'google',
        utmCampaign: 'spring_promo',
        createdBy: 'public_intake',
      },
      leadRepo,
      auditRepo
    );

    // 2. Convert to customer — originatingLeadId must be set.
    const conversion = await convertToCustomer(
      TENANT,
      lead.id,
      leadRepo,
      customerRepo,
      'user-1',
      'owner',
      auditRepo
    );
    expect(conversion).not.toBeNull();
    expect(conversion!.customer.originatingLeadId).toBe(lead.id);

    // The lead.converted audit metadata carries the campaign.
    const convertedEvents = await auditRepo.findByEntity(TENANT, 'lead', lead.id);
    const converted = convertedEvents.find((e) => e.eventType === 'lead.converted');
    expect(converted?.metadata).toMatchObject({ utmCampaign: 'spring_promo' });

    // 3. Create a job for that customer with originatingLeadId passed through
    //    (in production this is auto-resolved by the route from the customer).
    const job = await createJob(
      {
        tenantId: TENANT,
        customerId: conversion!.customer.id,
        locationId: 'loc-1',
        summary: 'Replace AC unit',
        originatingLeadId: conversion!.customer.originatingLeadId,
        createdBy: 'user-1',
      },
      jobRepo,
      auditRepo
    );
    expect(job.originatingLeadId).toBe(lead.id);

    // 4. Create an invoice for that job, propagating the same id.
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: job.id,
        invoiceNumber: 'INV-0001',
        lineItems: [
          { id: crypto.randomUUID(), description: 'AC unit', quantity: 1, unitPriceCents: 250000, totalCents: 250000, category: 'equipment', sortOrder: 0, taxable: false },
        ],
        originatingLeadId: job.originatingLeadId,
        createdBy: 'user-1',
      },
      invoiceRepo,
      auditRepo
    );
    expect(invoice.originatingLeadId).toBe(lead.id);

    // 5. Final assertion: from the invoice we can reach the originating campaign.
    const originLead = await leadRepo.findById(TENANT, invoice.originatingLeadId!);
    expect(originLead?.utmCampaign).toBe('spring_promo');
    expect(originLead?.utmSource).toBe('google');
  });

  it('createLeadSchema accepts UTM fields and rejects oversized attribution', () => {
    const ok = createLeadSchema.safeParse({
      firstName: 'A',
      source: 'web_form',
      utmSource: 'google',
      utmCampaign: 'x'.repeat(200),
      attribution: { gclid: 'abc', referrer: 'https://x.com' },
    });
    expect(ok.success).toBe(true);

    const tooBig = createLeadSchema.safeParse({
      firstName: 'A',
      source: 'web_form',
      attribution: Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`k${i}`, 'v'])
      ),
    });
    expect(tooBig.success).toBe(false);
  });
});
