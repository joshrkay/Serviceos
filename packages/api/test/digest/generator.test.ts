import { describe, it, expect } from 'vitest';
import { buildDigestSections, renderDigestSms } from '../../src/digest/generator';
import { createProposal } from '../../src/proposals/proposal';

describe('P5-020 — digest generator', () => {
  it('omits uncertain section on zero-marker day', () => {
    const sections = buildDigestSections({
      businessName: 'Miller HVAC',
      localDate: '2026-06-11',
      stats: {
        jobsCompleted: 2,
        invoicedCents: 100_000,
        collectedCents: 50_000,
        quotesSent: 1,
        quotesValueCents: 80_000,
        followUpsSent: 0,
        tomorrowAppointmentCount: 3,
        tomorrowFirst: '8am',
        tomorrowLast: '4pm',
      },
      markerProposals: [],
      lessons: [],
    });
    expect(sections.uncertain).toBeUndefined();
    expect(sections.learned).toBeUndefined();
    const sms = renderDigestSms(sections, 'Miller HVAC');
    expect(sms).toContain('LOOKS GOOD');
    expect(sms.length).toBeLessThanOrEqual(320);
  });

  it('includes uncertain section when markers exist', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'draft_estimate',
      summary: 'Estimate for Jane',
      payload: {
        lineItems: [{ description: 'Gasket', pricingSource: 'uncatalogued', unitPriceCents: 1000 }],
      },
      createdBy: 'u1',
    });
    const sections = buildDigestSections({
      businessName: 'Miller HVAC',
      localDate: '2026-06-11',
      stats: {
        jobsCompleted: 0,
        invoicedCents: 0,
        collectedCents: 0,
        quotesSent: 0,
        quotesValueCents: 0,
        followUpsSent: 0,
        tomorrowAppointmentCount: 0,
      },
      markerProposals: [proposal],
      lessons: [],
    });
    expect(sections.uncertain).toContain('Not sure');
  });
});
