/**
 * D-044 / #1771 — update_google_listing_website execution handler.
 *
 * Runs only after the owner approves the proposal (manual action class, so it
 * never auto-approves at any trust tier): it is a public change to their Google
 * listing. It writes the website (Business Information API `websiteUri`) and,
 * when the payload carries one, the booking link (Place Actions API
 * `APPOINTMENT` link) — see reputation/google-business-client.ts for the
 * documented fields. Expired tokens refresh once on 401
 * (callWithGoogleBusinessAuthRetry).
 *
 * No write happens unless the Google listing is connected with a chosen
 * location. A failure returns a plain-language reason (it reaches the owner on
 * the proposal) and never a synthetic success.
 */
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  GoogleBusinessApiError,
  GoogleBusinessAuthError,
  GoogleBusinessOAuthConfig,
  GoogleBusinessQuotaError,
  GoogleFetch,
  boundedGoogleFetch,
  ensureAppointmentLink,
  updateLocationWebsite,
} from '../../reputation/google-business-client';
import {
  GoogleBusinessIntegrationRepository,
  callWithGoogleBusinessAuthRetry,
} from '../../reputation/google-business-integration';
import { updateGoogleListingWebsitePayloadSchema } from '../contracts/google-listing-website';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';

type IntegrationRepo = Pick<
  GoogleBusinessIntegrationRepository,
  'get' | 'getTokens' | 'persistRotatedAccessToken' | 'recordListingWebsite'
>;

/** Owner-readable reason for a failed Google call. */
export function describeGoogleListingFailure(err: unknown): string {
  if (err instanceof GoogleBusinessAuthError) {
    return 'Google no longer accepts the connection. Reconnect your Google Business Profile and try again.';
  }
  if (err instanceof GoogleBusinessQuotaError) {
    return 'Google is limiting requests right now. Try again in a few minutes.';
  }
  if (err instanceof GoogleBusinessApiError) {
    return 'Google answered in a way we did not expect, so nothing more was changed. Try again later.';
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Google did not accept the change: ${message}`;
}

export class UpdateGoogleListingWebsiteExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_google_listing_website';
  // Calls Google over the network: keep it out of the executor's DB transaction.
  performsExternalIo = true;

  constructor(
    private readonly integrationRepo: IntegrationRepo | undefined,
    private readonly googleConfig: GoogleBusinessOAuthConfig | null | undefined,
    // Structurally required: an approved public listing change is always audited.
    private readonly auditRepo: AuditRepository,
    private readonly fetchFn: GoogleFetch = boundedGoogleFetch,
  ) {}

  // Without the integration repo this would report success while writing nothing.
  isFullyWired(): boolean {
    return Boolean(this.integrationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = updateGoogleListingWebsitePayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: `Payload does not match the Google listing website contract: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }
    if (!this.integrationRepo) {
      return { success: false, error: 'handler_not_wired:googleBusinessIntegrationRepo' };
    }
    const { tenantId } = context;
    const { websiteUri, bookingUri } = parsed.data;

    const integration = await this.integrationRepo.get(tenantId);
    if (!integration?.locationId) {
      return {
        success: false,
        error: 'Your Google listing is not connected. Connect it in Settings, then try again.',
      };
    }
    const locationId = integration.locationId;
    const tokens = await this.integrationRepo.getTokens(tenantId);
    if (!tokens) {
      return {
        success: false,
        error: 'Google credentials are missing. Reconnect your Google Business Profile and try again.',
      };
    }

    const call = <T>(fn: (accessToken: string) => Promise<T>) =>
      callWithGoogleBusinessAuthRetry({
        tenantId,
        tokens,
        config: this.googleConfig,
        store: this.integrationRepo,
        fetchFn: this.fetchFn,
        // Later calls in this run use the rotated token.
        onRotated: (accessToken) => {
          tokens.accessToken = accessToken;
        },
        call: fn,
      });

    let websiteWritten = false;
    let bookingLinkCreated: boolean | null = null;
    let failure: string | null = null;
    try {
      await call((token) => updateLocationWebsite(token, locationId, websiteUri, this.fetchFn));
      websiteWritten = true;
      await this.integrationRepo.recordListingWebsite(tenantId, locationId, websiteUri);
      if (bookingUri) {
        const link = await call((token) =>
          ensureAppointmentLink(token, locationId, bookingUri, this.fetchFn),
        );
        bookingLinkCreated = link.created;
      }
    } catch (err) {
      failure = describeGoogleListingFailure(err);
      if (websiteWritten) {
        failure = `Your website is on Google, but the booking link was not added. ${failure}`;
      }
    }

    await this.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: context.executedBy,
        actorRole: context.executedByRole ?? 'owner',
        eventType: failure ? 'google_listing.website_failed' : 'google_listing.website_set',
        entityType: 'google_business_listing',
        entityId: integration.id,
        metadata: {
          proposalId: proposal.id,
          locationId,
          websiteUri,
          websiteWritten,
          bookingUri: bookingUri ?? null,
          bookingLinkCreated,
          ...(failure ? { reason: failure } : {}),
        },
      }),
    );

    return failure
      ? { success: false, error: failure }
      : { success: true, resultEntityId: integration.id };
  }
}
