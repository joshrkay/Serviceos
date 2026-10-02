// #1564 — the per-tenant US A2P 10DLC registration state machine (Rivet as
// ISV; Rivet absorbs the Twilio fees, so nothing here bills the tenant).
//
// One call to advanceA2pRegistration() moves a tenant's registration as far as
// Twilio allows right now, then returns. The async worker calls it again on a
// delayed re-enqueue until the registration is terminal ('approved' / 'failed').
//
// Sequence (Twilio ISV guide for Standard / Low-Volume Standard Brands):
//   https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
//   1.x  Secondary Customer Profile: business-info EndUser, authorized rep
//        EndUser, Address + address SupportingDocument, the ISV's Primary
//        Business Profile, evaluate, submit
//   2.x  A2P TrustProduct: messaging-profile EndUser + the Customer Profile,
//        evaluate, submit
//   3    BrandRegistration (TCR vetting — days; polled)
//   then UsAppToPerson campaign on the tenant's Messaging Service once the
//        Brand is APPROVED (TCR review — days; polled):
//   https://www.twilio.com/docs/messaging/api/brand-registration-resource
//   https://www.twilio.com/docs/messaging/api/usapptoperson-resource
//
// Idempotency: every created resource SID (and every one-shot assignment) is
// recorded in `refs` and reported through `checkpoint` immediately, so a crash
// or retry resumes where it stopped instead of creating — and paying for — a
// second Brand.

import type { TwilioA2pClient, TwilioCreds, UsAppToPersonCampaignInput } from './twilio-a2p-client';

export type A2pRegistrationStatus =
  /** Details saved; nothing (or not everything) submitted to Twilio yet. */
  | 'submitted'
  /** Profile + trust bundle submitted and the Brand created; TCR is vetting. */
  | 'brand_pending'
  /** Brand approved; the campaign is with TCR. */
  | 'campaign_pending'
  | 'approved'
  | 'failed';

/** Twilio's documented business_type values for a Standard Brand. */
export const A2P_BUSINESS_TYPES = [
  'Co-operative',
  'Corporation',
  'Limited Liability Corporation',
  'Non-profit Corporation',
  'Partnership',
] as const;
export type A2pBusinessType = (typeof A2P_BUSINESS_TYPES)[number];

/** Twilio's documented business_industry values. */
export const A2P_BUSINESS_INDUSTRIES = [
  'AGRICULTURE', 'AUTOMOTIVE', 'BANKING', 'CONSTRUCTION', 'CONSUMER', 'EDUCATION',
  'ELECTRONICS', 'ENGINEERING', 'ENERGY', 'FAST_MOVING_CONSUMER_GOODS', 'FINANCIAL',
  'FINTECH', 'FOOD_AND_BEVERAGE', 'GOVERNMENT', 'HEALTHCARE', 'HOSPITALITY', 'INSURANCE',
  'JEWELRY', 'LEGAL', 'MANUFACTURING', 'MEDIA', 'NOT_FOR_PROFIT', 'OIL_AND_GAS', 'ONLINE',
  'PROFESSIONAL_SERVICES', 'RAW_MATERIALS', 'REAL_ESTATE', 'RELIGION', 'RETAIL',
  'TECHNOLOGY', 'TELECOMMUNICATIONS', 'TRANSPORTATION', 'TRAVEL',
] as const;
export type A2pBusinessIndustry = (typeof A2P_BUSINESS_INDUSTRIES)[number];

/** Twilio's documented job_position values for an authorized representative. */
export const A2P_JOB_POSITIONS = ['Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel', 'Other'] as const;
export type A2pJobPosition = (typeof A2P_JOB_POSITIONS)[number];

export interface A2pBusinessDetails {
  legalBusinessName: string;
  /** Plaintext EIN — 9 digits. Only ever held in memory; stored encrypted. */
  ein: string;
  businessType: A2pBusinessType;
  businessIndustry: A2pBusinessIndustry;
  websiteUrl: string | null;
  address: { street: string; street2: string | null; city: string; region: string; postalCode: string };
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    title: string;
    jobPosition: A2pJobPosition;
  };
}

/** Twilio resource SIDs + one-shot step markers, persisted as JSON. */
export interface A2pTwilioRefs {
  customerProfileSid?: string;
  businessEndUserSid?: string;
  businessEndUserAssigned?: boolean;
  representativeEndUserSid?: string;
  representativeAssigned?: boolean;
  addressSid?: string;
  supportingDocumentSid?: string;
  supportingDocumentAssigned?: boolean;
  primaryProfileAssigned?: boolean;
  customerProfileSubmitted?: boolean;
  trustProductSid?: string;
  messagingProfileEndUserSid?: string;
  messagingProfileAssigned?: boolean;
  customerProfileAssignedToTrustProduct?: boolean;
  trustProductSubmitted?: boolean;
  brandSid?: string;
  campaignSid?: string;
}

export interface A2pRegistrationProgress {
  status: A2pRegistrationStatus;
  refs: A2pTwilioRefs;
  /** Owner-facing reasons when status === 'failed'. Never contains the EIN. */
  failureReasons: string[];
}

export interface A2pIsvConfig {
  /** Rivet's Twilio-approved Primary Business Profile SID (parent account). */
  primaryProfileSid: string;
  /** ISV-owned inbox for TrustHub status emails — not the tenant's. */
  notificationEmail: string;
  statusCallbackUrl?: string;
}

export function initialA2pProgress(): A2pRegistrationProgress {
  return { status: 'submitted', refs: {}, failureReasons: [] };
}

export async function advanceA2pRegistration(input: {
  progress: A2pRegistrationProgress;
  details: A2pBusinessDetails;
  creds: TwilioCreds;
  /** The tenant's Messaging Service; the campaign is registered on it. */
  messagingServiceSid: string | null;
  isv: A2pIsvConfig;
  client: TwilioA2pClient;
  /** Called after every Twilio write with the progress so far (persist it). */
  checkpoint?: (progress: A2pRegistrationProgress) => Promise<void>;
}): Promise<A2pRegistrationProgress> {
  const { details, creds, client, isv } = input;
  const progress: A2pRegistrationProgress = {
    status: input.progress.status,
    refs: { ...input.progress.refs },
    failureReasons: [...input.progress.failureReasons],
  };
  const refs = progress.refs;
  const save = async () => {
    if (input.checkpoint) await input.checkpoint({ ...progress, refs: { ...refs } });
  };
  const fail = (reasons: string[]): A2pRegistrationProgress => ({
    ...progress,
    status: 'failed',
    failureReasons: reasons.length > 0 ? reasons : ['Twilio rejected the registration without a reason.'],
  });

  if (progress.status === 'submitted') {
    const name = details.legalBusinessName;

    // ── 1.x Secondary Customer Profile ───────────────────────────────────
    if (!refs.customerProfileSid) {
      refs.customerProfileSid = (
        await client.createCustomerProfile(creds, {
          friendlyName: `${name} secondary customer profile`,
          email: isv.notificationEmail,
          statusCallback: isv.statusCallbackUrl,
        })
      ).sid;
      await save();
    }
    const profileSid = refs.customerProfileSid;

    if (!refs.businessEndUserSid) {
      refs.businessEndUserSid = (
        await client.createEndUser(creds, {
          type: 'customer_profile_business_information',
          friendlyName: `${name} business information`,
          attributes: {
            business_name: name,
            business_type: details.businessType,
            business_registration_identifier: 'EIN',
            business_registration_number: details.ein,
            business_identity: 'direct_customer',
            business_industry: details.businessIndustry,
            business_regions_of_operation: 'USA_AND_CANADA',
            ...(details.websiteUrl ? { website_url: details.websiteUrl } : {}),
          },
        })
      ).sid;
      await save();
    }
    if (!refs.businessEndUserAssigned) {
      await client.assignCustomerProfileEntity(creds, profileSid, refs.businessEndUserSid);
      refs.businessEndUserAssigned = true;
      await save();
    }

    if (!refs.representativeEndUserSid) {
      refs.representativeEndUserSid = (
        await client.createEndUser(creds, {
          type: 'authorized_representative_1',
          friendlyName: `${name} authorized representative`,
          attributes: {
            first_name: details.contact.firstName,
            last_name: details.contact.lastName,
            email: details.contact.email,
            phone_number: details.contact.phone,
            business_title: details.contact.title,
            job_position: details.contact.jobPosition,
          },
        })
      ).sid;
      await save();
    }
    if (!refs.representativeAssigned) {
      await client.assignCustomerProfileEntity(creds, profileSid, refs.representativeEndUserSid);
      refs.representativeAssigned = true;
      await save();
    }

    if (!refs.addressSid) {
      refs.addressSid = (
        await client.createAddress(creds, {
          customerName: name,
          street: details.address.street,
          streetSecondary: details.address.street2 ?? undefined,
          city: details.address.city,
          region: details.address.region,
          postalCode: details.address.postalCode,
          isoCountry: 'US',
        })
      ).sid;
      await save();
    }
    if (!refs.supportingDocumentSid) {
      refs.supportingDocumentSid = (
        await client.createSupportingDocument(creds, {
          type: 'customer_profile_address',
          friendlyName: `${name} address`,
          attributes: { address_sids: refs.addressSid },
        })
      ).sid;
      await save();
    }
    if (!refs.supportingDocumentAssigned) {
      await client.assignCustomerProfileEntity(creds, profileSid, refs.supportingDocumentSid);
      refs.supportingDocumentAssigned = true;
      await save();
    }
    if (!refs.primaryProfileAssigned) {
      await client.assignCustomerProfileEntity(creds, profileSid, isv.primaryProfileSid);
      refs.primaryProfileAssigned = true;
      await save();
    }

    if (!refs.customerProfileSubmitted) {
      const evaluation = await client.evaluateCustomerProfile(creds, profileSid);
      if (evaluation.status !== 'compliant') return fail(evaluationFailureReasons(evaluation.results));
      await client.submitCustomerProfile(creds, profileSid);
      refs.customerProfileSubmitted = true;
      await save();
    }

    // ── 2.x A2P TrustProduct ─────────────────────────────────────────────
    if (!refs.trustProductSid) {
      refs.trustProductSid = (
        await client.createTrustProduct(creds, {
          friendlyName: `${name} A2P trust product`,
          email: isv.notificationEmail,
          statusCallback: isv.statusCallbackUrl,
        })
      ).sid;
      await save();
    }
    const trustProductSid = refs.trustProductSid;
    if (!refs.messagingProfileEndUserSid) {
      refs.messagingProfileEndUserSid = (
        await client.createEndUser(creds, {
          type: 'us_a2p_messaging_profile_information',
          friendlyName: `${name} messaging profile`,
          attributes: {
            company_type: details.businessType === 'Non-profit Corporation' ? 'non-profit' : 'private',
          },
        })
      ).sid;
      await save();
    }
    if (!refs.messagingProfileAssigned) {
      await client.assignTrustProductEntity(creds, trustProductSid, refs.messagingProfileEndUserSid);
      refs.messagingProfileAssigned = true;
      await save();
    }
    if (!refs.customerProfileAssignedToTrustProduct) {
      await client.assignTrustProductEntity(creds, trustProductSid, profileSid);
      refs.customerProfileAssignedToTrustProduct = true;
      await save();
    }
    if (!refs.trustProductSubmitted) {
      const evaluation = await client.evaluateTrustProduct(creds, trustProductSid);
      if (evaluation.status !== 'compliant') return fail(evaluationFailureReasons(evaluation.results));
      await client.submitTrustProduct(creds, trustProductSid);
      refs.trustProductSubmitted = true;
      await save();
    }

    // ── 3 BrandRegistration (incurs the absorbed brand fee) ──────────────
    if (!refs.brandSid) {
      refs.brandSid = (
        await client.createBrandRegistration(creds, {
          customerProfileBundleSid: profileSid,
          a2pProfileBundleSid: trustProductSid,
        })
      ).sid;
    }
    progress.status = 'brand_pending';
    await save();
    return progress;
  }

  if (progress.status === 'brand_pending') {
    const brand = await client.fetchBrandRegistration(creds, refs.brandSid!);
    if (brand.status === 'FAILED' || brand.status === 'SUSPENDED') {
      return fail(twilioErrorReasons(brand.errors, brand.failureReason));
    }
    if (brand.status !== 'APPROVED') return progress;

    if (!input.messagingServiceSid) {
      // The phone integration has no Messaging Service yet (provisioning
      // still running). Stay pending; the next poll retries.
      return progress;
    }
    if (!refs.campaignSid) {
      refs.campaignSid = (
        await client.createUsAppToPersonCampaign(
          creds,
          input.messagingServiceSid,
          rivetCampaignFor(details.legalBusinessName, refs.brandSid!),
        )
      ).sid;
    }
    progress.status = 'campaign_pending';
    await save();
    return progress;
  }

  if (progress.status === 'campaign_pending') {
    const campaign = await client.fetchUsAppToPersonCampaign(creds, input.messagingServiceSid!, refs.campaignSid!);
    if (campaign.campaignStatus === 'FAILED') return fail(twilioErrorReasons(campaign.errors, null));
    if (campaign.campaignStatus === 'VERIFIED') return { ...progress, status: 'approved', failureReasons: [] };
    return progress;
  }

  return progress;
}

/**
 * The one campaign Rivet registers for every tenant: MIXED (appointment
 * confirmations/reminders, on-the-way, estimates, invoices, replies) — the
 * same use case the Messaging Service is created with today.
 */
export function rivetCampaignFor(businessName: string, brandRegistrationSid: string): UsAppToPersonCampaignInput {
  return {
    brandRegistrationSid,
    usecase: 'MIXED',
    description:
      `${businessName} texts its own customers about their service work: appointment confirmations and ` +
      'reminders, technician on-the-way updates, estimates, invoices and payment receipts, and replies to ' +
      'customer questions.',
    messageFlow:
      `Customers give ${businessName} their mobile number when they call, book online, or book in person, ` +
      'and agree to receive text messages about their appointments, estimates and invoices. Message ' +
      'frequency varies. Message and data rates may apply. Customers can reply STOP to opt out or HELP ' +
      'for help at any time.',
    messageSamples: [
      `${businessName}: your appointment is confirmed for Tue 10/14 between 8 and 10am. Reply STOP to opt out.`,
      `${businessName}: your technician is on the way and should arrive in about 20 minutes.`,
      `${businessName}: your invoice is ready. View and pay here: https://pay.example.com/i/abc123`,
    ],
    hasEmbeddedLinks: true,
    hasEmbeddedPhone: false,
  };
}


function twilioErrorReasons(errors: unknown[], failureReason: string | null): string[] {
  const reasons: string[] = [];
  for (const e of errors) {
    if (typeof e === 'string' && e.trim()) {
      reasons.push(e.trim());
      continue;
    }
    if (e && typeof e === 'object') {
      const rec = e as Record<string, unknown>;
      const text = [rec.description, rec.message, rec.error_message, rec.reason].find(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      );
      if (text) reasons.push(text.trim());
    }
  }
  if (reasons.length === 0 && failureReason?.trim()) reasons.push(failureReason.trim());
  return reasons;
}

/** Collects every `failure_reason` on an invalid node of a TrustHub evaluation. */
function evaluationFailureReasons(results: unknown[]): string[] {
  const reasons = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (rec.valid === false && typeof rec.failure_reason === 'string' && rec.failure_reason.trim()) {
      reasons.add(rec.failure_reason.trim());
    }
    for (const value of Object.values(rec)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(results);
  return reasons.size > 0 ? [...reasons] : ['Twilio found missing or invalid business details.'];
}
