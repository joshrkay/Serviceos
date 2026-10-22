/**
 * D-044 / #1769 — update_tenant_site_about execution handler.
 *
 * Runs only after the owner approves the proposal (manual action class, so it
 * never auto-approves at any trust tier). It sets the hosted tenant site's
 * "about" copy — `tenant_settings.site_about_text` — to the approved text,
 * which the owner may have edited on the card first. The page picks it up on
 * its next request; nothing else about the site changes.
 *
 * Rejecting the proposal never reaches here, so the site simply has no about
 * section (its empty state).
 */
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import type { SettingsRepository } from '../../settings/settings';
import { updateTenantSiteAboutPayloadSchema } from '../contracts/tenant-site-about';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';

export class UpdateTenantSiteAboutExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_tenant_site_about';

  constructor(
    private readonly settingsRepo: Pick<SettingsRepository, 'update'> | undefined,
    // Structurally required: an approved public-copy change is always audited.
    private readonly auditRepo: AuditRepository,
  ) {}

  // WS3 — without the settings repo this would report success while writing
  // nothing; boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.settingsRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = updateTenantSiteAboutPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: `Payload does not match the tenant-site about contract: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }
    if (!this.settingsRepo) {
      return { success: false, error: 'handler_not_wired:settingsRepo' };
    }

    const updated = await this.settingsRepo.update(context.tenantId, {
      siteAboutText: parsed.data.aboutText,
    });
    if (!updated) {
      return { success: false, error: 'Tenant settings not found' };
    }

    await this.auditRepo.create(
      createAuditEvent({
        tenantId: context.tenantId,
        actorId: context.executedBy,
        actorRole: context.executedByRole ?? 'owner',
        eventType: 'tenant_site.about_set',
        entityType: 'tenant_site',
        entityId: context.tenantId,
        metadata: {
          proposalId: proposal.id,
          length: parsed.data.aboutText.length,
          // Edited by the owner before approval when it differs from the AI's draft.
          editedFromDraft:
            typeof proposal.originalPayload?.aboutText === 'string' &&
            proposal.originalPayload.aboutText !== parsed.data.aboutText,
        },
      }),
    );
    return { success: true, resultEntityId: context.tenantId };
  }
}
