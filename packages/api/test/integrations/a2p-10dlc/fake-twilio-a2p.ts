/**
 * #1564 — an in-memory stand-in for Twilio's A2P 10DLC APIs (the external
 * boundary). It hands out SIDs, remembers what was created, and lets a test
 * play TCR/Twilio review by flipping brand / campaign / bundle statuses.
 */
import type {
  BrandRegistrationStatus,
  CampaignStatus,
  TrustHubBundleStatus,
  TrustHubEvaluation,
  TwilioA2pClient,
  TwilioCreds,
  UsAppToPersonCampaignInput,
} from '../../../src/integrations/twilio/a2p-10dlc/twilio-a2p-client';

export class FakeTwilioA2p implements TwilioA2pClient {
  private seq = 0;
  readonly endUsers: Array<{ sid: string; type: string; attributes: Record<string, unknown> }> = [];
  readonly profileAssignments: Array<{ profileSid: string; objectSid: string }> = [];
  readonly trustAssignments: Array<{ trustProductSid: string; objectSid: string }> = [];
  readonly brands: Array<{ sid: string; customerProfileBundleSid: string; a2pProfileBundleSid: string }> = [];
  readonly campaigns: Array<{ sid: string; messagingServiceSid: string; input: UsAppToPersonCampaignInput }> = [];
  readonly credsSeen: TwilioCreds[] = [];
  submittedProfiles: string[] = [];
  submittedTrustProducts: string[] = [];

  profileEvaluation: TrustHubEvaluation = { status: 'compliant', results: [] };
  trustProductEvaluation: TrustHubEvaluation = { status: 'compliant', results: [] };
  profileStatus: TrustHubBundleStatus = 'pending-review';
  profileErrors: unknown[] = [];
  trustProductStatus: TrustHubBundleStatus = 'pending-review';
  brandStatus: BrandRegistrationStatus = 'PENDING';
  brandFailureReason: string | null = null;
  brandErrors: unknown[] = [];
  campaignStatus: CampaignStatus = 'PENDING';
  campaignErrors: unknown[] = [];
  /** When set, the next call to this method throws it (once). */
  failNext: { method: keyof TwilioA2pClient; error: unknown } | null = null;

  private sid(prefix: string) {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(32, '0')}`;
  }

  private gate(method: keyof TwilioA2pClient, creds: TwilioCreds) {
    this.credsSeen.push(creds);
    if (this.failNext?.method === method) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async createCustomerProfile(creds: TwilioCreds) {
    this.gate('createCustomerProfile', creds);
    return { sid: this.sid('BU') };
  }
  async createEndUser(creds: TwilioCreds, input: { type: string; friendlyName: string; attributes: Record<string, unknown> }) {
    this.gate('createEndUser', creds);
    const sid = this.sid('IT');
    this.endUsers.push({ sid, type: input.type, attributes: input.attributes });
    return { sid };
  }
  async assignCustomerProfileEntity(creds: TwilioCreds, profileSid: string, objectSid: string) {
    this.gate('assignCustomerProfileEntity', creds);
    this.profileAssignments.push({ profileSid, objectSid });
    return { sid: this.sid('BV') };
  }
  async createAddress(creds: TwilioCreds) {
    this.gate('createAddress', creds);
    return { sid: this.sid('AD') };
  }
  async createSupportingDocument(creds: TwilioCreds) {
    this.gate('createSupportingDocument', creds);
    return { sid: this.sid('RD') };
  }
  async evaluateCustomerProfile(creds: TwilioCreds) {
    this.gate('evaluateCustomerProfile', creds);
    return this.profileEvaluation;
  }
  async submitCustomerProfile(creds: TwilioCreds, sid: string) {
    this.gate('submitCustomerProfile', creds);
    this.submittedProfiles.push(sid);
  }
  async fetchCustomerProfile(creds: TwilioCreds) {
    this.gate('fetchCustomerProfile', creds);
    return { status: this.profileStatus, errors: this.profileErrors };
  }
  async createTrustProduct(creds: TwilioCreds) {
    this.gate('createTrustProduct', creds);
    return { sid: this.sid('BU') };
  }
  async assignTrustProductEntity(creds: TwilioCreds, trustProductSid: string, objectSid: string) {
    this.gate('assignTrustProductEntity', creds);
    this.trustAssignments.push({ trustProductSid, objectSid });
    return { sid: this.sid('BV') };
  }
  async evaluateTrustProduct(creds: TwilioCreds) {
    this.gate('evaluateTrustProduct', creds);
    return this.trustProductEvaluation;
  }
  async submitTrustProduct(creds: TwilioCreds, sid: string) {
    this.gate('submitTrustProduct', creds);
    this.submittedTrustProducts.push(sid);
  }
  async fetchTrustProduct(creds: TwilioCreds) {
    this.gate('fetchTrustProduct', creds);
    return { status: this.trustProductStatus, errors: [] };
  }
  async createBrandRegistration(creds: TwilioCreds, input: { customerProfileBundleSid: string; a2pProfileBundleSid: string }) {
    this.gate('createBrandRegistration', creds);
    const sid = this.sid('BN');
    this.brands.push({ sid, ...input });
    return { sid };
  }
  async fetchBrandRegistration(creds: TwilioCreds) {
    this.gate('fetchBrandRegistration', creds);
    return { status: this.brandStatus, failureReason: this.brandFailureReason, errors: this.brandErrors };
  }
  async createUsAppToPersonCampaign(creds: TwilioCreds, messagingServiceSid: string, input: UsAppToPersonCampaignInput) {
    this.gate('createUsAppToPersonCampaign', creds);
    const sid = this.sid('QE');
    this.campaigns.push({ sid, messagingServiceSid, input });
    return { sid };
  }
  async fetchUsAppToPersonCampaign(creds: TwilioCreds) {
    this.gate('fetchUsAppToPersonCampaign', creds);
    return { campaignStatus: this.campaignStatus, errors: this.campaignErrors };
  }
}
