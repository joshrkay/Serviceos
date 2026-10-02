/**
 * #1564 — the A2P 10DLC registration state machine.
 *
 * Seam: advanceA2pRegistration(...) — one call advances a tenant's
 * registration as far as Twilio allows right now. Twilio is the fake in
 * ./fake-twilio-a2p (the external boundary); nothing reaches twilio.com.
 */
import { describe, it, expect } from 'vitest';
import type { A2pRegistrationProgress } from '../../../src/integrations/twilio/a2p-10dlc/registration';
import { FakeTwilioA2p } from './fake-twilio-a2p';
import {
  advanceA2pRegistration,
  initialA2pProgress,
  type A2pBusinessDetails,
} from '../../../src/integrations/twilio/a2p-10dlc/registration';

const details: A2pBusinessDetails = {
  legalBusinessName: 'Acme Plumbing LLC',
  ein: '123456789',
  businessType: 'Limited Liability Corporation',
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: 'https://acme-plumbing.example.com',
  address: { street: '1 Main St', street2: null, city: 'Austin', region: 'TX', postalCode: '78701' },
  contact: {
    firstName: 'Pat',
    lastName: 'Owner',
    email: 'pat@example.com',
    phone: '+15125550100',
    title: 'Owner',
    jobPosition: 'CEO',
  },
};

const isv = { primaryProfileSid: 'BUprimary0000000000000000000000000', notificationEmail: 'compliance@example.com' };
const creds = { accountSid: 'ACsub', authToken: 'subtok' };

function run(twilio: FakeTwilioA2p, progress = initialA2pProgress()) {
  return advanceA2pRegistration({
    progress,
    details,
    creds,
    messagingServiceSid: 'MGservice',
    isv,
    client: twilio,
  });
}

describe('advanceA2pRegistration', () => {
  it('drives profile → brand → campaign → approved as Twilio approves each stage', async () => {
    const twilio = new FakeTwilioA2p();

    const afterSubmit = await run(twilio);
    expect(afterSubmit.status).toBe('brand_pending');
    expect(twilio.brands).toHaveLength(1);
    expect(twilio.submittedProfiles).toEqual([twilio.brands[0].customerProfileBundleSid]);
    expect(twilio.submittedTrustProducts).toEqual([twilio.brands[0].a2pProfileBundleSid]);

    const stillPending = await run(twilio, afterSubmit);
    expect(stillPending.status).toBe('brand_pending');
    expect(twilio.campaigns).toHaveLength(0);

    twilio.brandStatus = 'APPROVED';
    const afterBrand = await run(twilio, stillPending);
    expect(afterBrand.status).toBe('campaign_pending');
    expect(twilio.campaigns).toHaveLength(1);
    expect(twilio.campaigns[0].messagingServiceSid).toBe('MGservice');
    expect(twilio.campaigns[0].input.brandRegistrationSid).toBe(twilio.brands[0].sid);

    twilio.campaignStatus = 'VERIFIED';
    const done = await run(twilio, afterBrand);
    expect(done.status).toBe('approved');
    expect(done.failureReasons).toEqual([]);
    expect(twilio.brands).toHaveLength(1);
    expect(twilio.campaigns).toHaveLength(1);
    expect(twilio.credsSeen.every((c) => c.accountSid === 'ACsub')).toBe(true);
  });

  it("fails with Twilio's own reasons when TCR rejects the Brand, and never registers a campaign", async () => {
    const twilio = new FakeTwilioA2p();
    const pending = await run(twilio);

    twilio.brandStatus = 'FAILED';
    twilio.brandErrors = [
      { code: 30794, description: 'Legal business name does not match the EIN on file.' },
      { code: 30795, description: 'Website is not reachable.' },
    ];
    const failed = await run(twilio, pending);

    expect(failed.status).toBe('failed');
    expect(failed.failureReasons).toEqual([
      'Legal business name does not match the EIN on file.',
      'Website is not reachable.',
    ]);
    expect(twilio.campaigns).toHaveLength(0);
  });

  it('fails with the campaign rejection reasons when TCR rejects the campaign', async () => {
    const twilio = new FakeTwilioA2p();
    const pending = await run(twilio);
    twilio.brandStatus = 'APPROVED';
    const campaignPending = await run(twilio, pending);

    twilio.campaignStatus = 'FAILED';
    twilio.campaignErrors = [{ code: 30886, description: 'Opt-in flow does not describe how consent is collected.' }];
    const failed = await run(twilio, campaignPending);

    expect(failed.status).toBe('failed');
    expect(failed.failureReasons).toEqual(['Opt-in flow does not describe how consent is collected.']);
  });

  it('fails with the evaluation findings — and creates no Brand — when the profile is noncompliant', async () => {
    const twilio = new FakeTwilioA2p();
    twilio.profileEvaluation = {
      status: 'noncompliant',
      results: [
        {
          friendly_name: 'Business Information',
          valid: false,
          fields: [{ friendly_name: 'Website URL', valid: false, failure_reason: 'Website URL is required' }],
        },
      ],
    };

    const failed = await run(twilio);

    expect(failed.status).toBe('failed');
    expect(failed.failureReasons).toEqual(['Website URL is required']);
    expect(twilio.submittedProfiles).toEqual([]);
    expect(twilio.brands).toHaveLength(0);
  });

  it('fails the same way when the A2P trust product evaluation is noncompliant', async () => {
    const twilio = new FakeTwilioA2p();
    twilio.trustProductEvaluation = {
      status: 'noncompliant',
      results: [{ valid: false, failure_reason: 'company_type is invalid' }],
    };

    const failed = await run(twilio);

    expect(failed.status).toBe('failed');
    expect(failed.failureReasons).toEqual(['company_type is invalid']);
    expect(twilio.brands).toHaveLength(0);
  });

  it('resumes from its last checkpoint after a crash without re-creating (or re-paying for) anything', async () => {
    const twilio = new FakeTwilioA2p();
    const checkpoints: A2pRegistrationProgress[] = [];
    twilio.failNext = { method: 'createBrandRegistration', error: Object.assign(new Error('socket hang up'), { status: 503 }) };

    await expect(
      advanceA2pRegistration({
        progress: initialA2pProgress(),
        details,
        creds,
        messagingServiceSid: 'MGservice',
        isv,
        client: twilio,
        checkpoint: async (p) => {
          checkpoints.push(p);
        },
      }),
    ).rejects.toThrow('socket hang up');

    const resumed = await run(twilio, checkpoints[checkpoints.length - 1]);

    expect(resumed.status).toBe('brand_pending');
    expect(twilio.brands).toHaveLength(1);
    expect(twilio.endUsers).toHaveLength(3);
    expect(twilio.submittedProfiles).toHaveLength(1);
    expect(twilio.submittedTrustProducts).toHaveLength(1);
    expect(twilio.profileAssignments).toHaveLength(4);
    expect(twilio.profileAssignments.map((a) => a.objectSid)).toContain(isv.primaryProfileSid);
  });

  it('waits (stays brand_pending) when the Brand is approved but the tenant has no Messaging Service yet', async () => {
    const twilio = new FakeTwilioA2p();
    const pending = await run(twilio);
    twilio.brandStatus = 'APPROVED';

    const waiting = await advanceA2pRegistration({
      progress: pending,
      details,
      creds,
      messagingServiceSid: null,
      isv,
      client: twilio,
    });

    expect(waiting.status).toBe('brand_pending');
    expect(twilio.campaigns).toHaveLength(0);
  });
});
