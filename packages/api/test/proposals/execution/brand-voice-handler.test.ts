/**
 * B1.18 — UpdateBrandVoiceExecutionHandler unit tests (in-memory repo).
 *
 * AC-3: approving a voice-drafted `update_brand_voice` proposal writes
 * through the SAME versioned path the Brand-Voice Configurator sheet uses
 * (`updateBrandVoice` — never re-implemented here). A cool-down violation
 * surfaces as an honest failed-execution reason, never a silent skip.
 * AC-4: even an adversarial payload carrying a stray `locked`-shaped key
 * never reaches the merge — `brandVoiceSchema` strips anything outside the
 * six configured fields before it's handed to `updateBrandVoice`.
 */
import { describe, expect, it } from 'vitest';
import { UpdateBrandVoiceExecutionHandler } from '../../../src/proposals/execution/brand-voice-handler';
import { InMemoryBrandVoiceRepository } from '../../../src/tenants/brand/in-memory-brand-voice-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { createProposal, type Proposal } from '../../../src/proposals/proposal';

const TENANT_ID = 't-1';
const OWNER_ID = 'u-owner';

function brandVoiceProposal(payload: Record<string, unknown>, overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT_ID,
      proposalType: 'update_brand_voice',
      payload,
      summary: 'Update brand voice',
      createdBy: OWNER_ID,
    }),
    status: 'approved',
    ...overrides,
  };
}

describe('UpdateBrandVoiceExecutionHandler', () => {
  it('AC-3: writes through updateBrandVoice — new brand_voice_versions row, version incremented, audit event returned & persisted', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateBrandVoiceExecutionHandler(repo, auditRepo);

    const proposal = brandVoiceProposal({
      register: 'friendly',
      signoff: "Thanks — Bob's HVAC",
      freeText: 'no slang', // must NOT be forwarded into the merge (not a brandVoiceSchema field)
    });

    const result = await handler.execute(proposal, { tenantId: TENANT_ID, executedBy: OWNER_ID });
    expect(result).toEqual({ success: true, resultEntityId: TENANT_ID });

    const state = await repo.getState(TENANT_ID);
    expect(state.version).toBe(1);
    expect(state.config.register).toBe('friendly');
    expect(state.config.signoff).toBe("Thanks — Bob's HVAC");
    // freeText has no home in BrandVoiceSettings — never leaked into the config.
    expect((state.config as Record<string, unknown>).freeText).toBeUndefined();

    const versions = await repo.listVersions(TENANT_ID);
    expect(versions).toHaveLength(1);
    expect(versions[0].changeReason).toBe('web_edit'); // NOT 'onboarding' — a spoken edit is a normal edit.

    const events = await auditRepo.findByEntity(TENANT_ID, 'brand_voice', TENANT_ID);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('brand_voice.updated');
    expect(events[0].actorId).toBe(OWNER_ID);
  });

  it('AC-3: a cool-down violation surfaces as an honest failed-execution reason, never a silent skip', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateBrandVoiceExecutionHandler(repo, auditRepo);

    // First write directly against the repo (bypassing onboarding exemption
    // — a spoken edit always uses onboarding:false, so the FIRST spoken edit
    // to a never-configured tenant is itself cool-down exempt per
    // resolveBumpDecision's isInitialWrite check).
    const first = await handler.execute(
      brandVoiceProposal({ register: 'friendly' }),
      { tenantId: TENANT_ID, executedBy: OWNER_ID },
    );
    expect(first.success).toBe(true);

    // A second spoken edit inside the 15-minute window is honestly refused.
    const second = await new UpdateBrandVoiceExecutionHandler(repo, auditRepo).execute(
      brandVoiceProposal({ register: 'formal' }),
      { tenantId: TENANT_ID, executedBy: OWNER_ID },
    );
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/^brand_voice_cooldown:/);

    // Never a silent skip: still version 1, no second version row.
    const state = await repo.getState(TENANT_ID);
    expect(state.version).toBe(1);
  });

  it('fails closed when the brand-voice repo is absent (handler_not_wired, never a synthetic success)', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateBrandVoiceExecutionHandler(undefined, auditRepo);
    expect(handler.isFullyWired()).toBe(false);

    const result = await handler.execute(
      brandVoiceProposal({ register: 'friendly' }),
      { tenantId: TENANT_ID, executedBy: OWNER_ID },
    );
    expect(result).toEqual({ success: false, error: 'handler_not_wired:brandVoiceRepo' });
  });

  it('refuses a payload with no brand-voice fields at all (freeText-only is a no-op edit)', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateBrandVoiceExecutionHandler(repo, auditRepo);

    const result = await handler.execute(
      brandVoiceProposal({ freeText: 'lock my brand voice' }),
      { tenantId: TENANT_ID, executedBy: OWNER_ID },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no brand-voice fields/);
    const state = await repo.getState(TENANT_ID);
    expect(state.version).toBe(0);
  });

  // AC-4 — even an adversarial payload can't reach a lock-shaped effect
  // beyond the ordinary version-bump's ALWAYS-true `locked` flag (identical
  // on every edit, form or voice — see brand-voice.ts bumpVersion).
  it('AC-4: a stray non-schema key on the payload (e.g. an invented "locked" field) never reaches the merge', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateBrandVoiceExecutionHandler(repo, auditRepo);

    const proposal = brandVoiceProposal({
      register: 'formal',
      // Adversarial: not a real field on the contract, but forced onto the
      // payload directly (bypassing the task handler) to prove the
      // execution handler itself is the backstop, not just the schema.
      locked: true,
      brand_voice_locked: true,
    } as Record<string, unknown>);

    const result = await handler.execute(proposal, { tenantId: TENANT_ID, executedBy: OWNER_ID });
    expect(result.success).toBe(true);

    const versions = await repo.listVersions(TENANT_ID);
    // Only the real field made it into the snapshot.
    expect(versions[0].snapshot).toEqual({ register: 'formal' });
  });

});
