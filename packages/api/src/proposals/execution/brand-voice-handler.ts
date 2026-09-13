/**
 * B1.18 — update_brand_voice execution handler.
 *
 * THE CRITICAL CONSTRAINT (b1.18-design.md): the versioned write path already
 * exists and is TOCTOU-safe. `updateBrandVoice`
 * (tenants/brand/brand-voice-service.ts) does read → cool-down check → merge
 * → version bump ATOMICALLY under the repo's row lock (`bumpVersion`), throws
 * `BrandVoiceCooldownError`, and returns the `brand_voice.updated` audit
 * event for the caller to persist. This handler calls that function — it
 * never re-implements the merge, the cool-down, or the version bump.
 *
 * A spoken edit is a normal edit: `onboarding: false`, so the cool-down
 * applies exactly as it does to a web edit. A `BrandVoiceCooldownError`
 * surfaces as an honest failed-execution reason on the proposal — never a
 * silent skip, never a success with nothing written.
 */
import { AppError } from '../../shared/errors';
import { AuditRepository } from '../../audit/audit';
import { brandVoiceSchema, type BrandVoiceRepository } from '../../tenants/brand/brand-voice';
import { updateBrandVoice } from '../../tenants/brand/brand-voice-service';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';

export class UpdateBrandVoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'update_brand_voice';

  constructor(
    private readonly brandVoiceRepo: BrandVoiceRepository | undefined,
    // WS3 — auditRepo is structurally REQUIRED: a persisted brand-voice bump
    // must always emit its brand_voice.updated audit event (updateBrandVoice
    // RETURNS the event; this handler is the one that persists it).
    private readonly auditRepo: AuditRepository,
  ) {}

  // WS3 — degrades to nothing without the brand-voice repo; boot fails when a
  // pool is configured but this is false (see wiring-assertions.ts).
  isFullyWired(): boolean {
    return Boolean(this.brandVoiceRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    // Reuse `brandVoiceSchema` (strip-mode) to project the proposal payload
    // down to exactly the six merge-able fields — `freeText` (review-card
    // context only; there is no storage column for it) and `_meta` (the
    // confidence envelope) are dropped here, never forwarded into the merge.
    const patchResult = brandVoiceSchema.safeParse(proposal.payload);
    if (!patchResult.success) {
      return {
        success: false,
        error: `Payload does not match the brand-voice contract: ${patchResult.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }
    const patch = patchResult.data;
    if (Object.keys(patch).length === 0) {
      // AC-4 rides here too: even though the payload structurally cannot
      // express `brand_voice_locked`, a payload with NO six-field content at
      // all (only free-text notes the speaker made that didn't map to a
      // configured field) is a no-op edit — refuse it explicitly rather than
      // silently bumping a version with nothing changed.
      return {
        success: false,
        error: 'Payload carries no brand-voice fields to apply (only unmapped free text)',
      };
    }

    if (!this.brandVoiceRepo) {
      // WS3 — no synthetic success: a missing repo is a wiring fault, never
      // a silent no-op that reports success while persisting nothing.
      return { success: false, error: 'handler_not_wired:brandVoiceRepo' };
    }

    try {
      const result = await updateBrandVoice(
        {
          actor: {
            tenantId: context.tenantId,
            userId: context.executedBy,
            // The approver's real role when the caller knows it, so the
            // brand_voice.updated audit names who actually acted rather than
            // asserting 'owner'. approveProposal now refuses this type without
            // `settings:update` (CONFIG_WRITING_PROPOSAL_TYPES), so whoever
            // got here held the same authority the brand-voice route demands.
            role: context.executedByRole ?? 'owner',
          },
          patch,
          // A spoken edit is a normal edit — never the onboarding exemption.
          onboarding: false,
        },
        this.brandVoiceRepo,
      );
      await this.auditRepo.create(result.audit);
      return { success: true, resultEntityId: context.tenantId };
    } catch (err) {
      if (err instanceof AppError && err.code === 'BRAND_VOICE_COOLDOWN') {
        const cooldownUntil =
          typeof err.details?.cooldownUntil === 'string' ? err.details.cooldownUntil : null;
        // Honest failed-execution reason — never a silent skip. The proposal
        // lands in `execution_failed` with this message; the operator can
        // retry after the cool-down window.
        return {
          success: false,
          error: `brand_voice_cooldown: try again after ${cooldownUntil ?? 'the cool-down window'}`,
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Brand voice update failed',
      };
    }
  }
}
