/**
 * D-044 / #1769 — update_tenant_site_about: the payload contract, the manual
 * action class, owner-level approval, and the execution handler.
 */
import { describe, it, expect } from 'vitest';
import {
  TENANT_SITE_ABOUT_MAX_LENGTH,
  updateTenantSiteAboutPayloadSchema,
} from '../../src/proposals/contracts/tenant-site-about';
import { validateProposalPayload } from '../../src/proposals/contracts';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
  createProposal,
  decideInitialStatus,
  type Proposal,
} from '../../src/proposals/proposal';
import { UpdateTenantSiteAboutExecutionHandler } from '../../src/proposals/execution/tenant-site-about-handler';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { actionClassForProposalType as sharedActionClass } from '@ai-service-os/shared';

const TENANT = 'tenant-about-1';

function approved(payload: Record<string, unknown>, extra: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT,
      proposalType: 'update_tenant_site_about',
      payload,
      summary: 'Add an About us section',
      createdBy: 'u-1',
    }),
    status: 'approved',
    ...extra,
  };
}

describe('update_tenant_site_about payload contract', () => {
  it('accepts plain about text, trimmed', () => {
    const parsed = updateTenantSiteAboutPayloadSchema.parse({ aboutText: '  We fix pipes.  ' });
    expect(parsed.aboutText).toBe('We fix pipes.');
    expect(validateProposalPayload('update_tenant_site_about', { aboutText: 'We fix pipes.' }).valid).toBe(true);
  });

  it.each([
    [{}, 'missing'],
    [{ aboutText: '' }, 'empty'],
    [{ aboutText: '   ' }, 'whitespace only'],
    [{ aboutText: 'x'.repeat(TENANT_SITE_ABOUT_MAX_LENGTH + 1) }, 'too long'],
    [{ aboutText: 42 }, 'not text'],
  ])('rejects %j (%s)', (payload) => {
    expect(validateProposalPayload('update_tenant_site_about', payload).valid).toBe(false);
  });

  it('accepts exactly the maximum length', () => {
    expect(
      validateProposalPayload('update_tenant_site_about', { aboutText: 'x'.repeat(TENANT_SITE_ABOUT_MAX_LENGTH) }).valid,
    ).toBe(true);
  });
});

describe('update_tenant_site_about is never auto-executed', () => {
  it('is a registered type in the manual action class, on both the API and shared sides', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('update_tenant_site_about');
    expect(actionClassForProposalType('update_tenant_site_about')).toBe('manual');
    expect(sharedActionClass('update_tenant_site_about')).toBe('manual');
  });

  it('lands as a draft at every trust tier and confidence', () => {
    for (const tier of ['autonomous', 'graduates_fast', 'graduates_slowly', 'always_asks'] as const) {
      expect(
        decideInitialStatus({ proposalType: 'update_tenant_site_about', sourceTrustTier: tier, confidenceScore: 1 }),
      ).toBe('draft');
    }
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'update_tenant_site_about',
      payload: { aboutText: 'Hi' },
      summary: 's',
      createdBy: 'u-1',
      sourceTrustTier: 'autonomous',
      confidenceScore: 1,
    });
    expect(proposal.status).toBe('draft');
  });

  it('has an execution handler in the registry', () => {
    expect(createExecutionHandlerRegistry({}).has('update_tenant_site_about')).toBe(true);
  });
});

describe('approving update_tenant_site_about', () => {
  it('needs settings:update: a dispatcher cannot approve the public about copy, an owner can', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await repo.create(
      createProposal({
        tenantId: TENANT,
        proposalType: 'update_tenant_site_about',
        payload: { aboutText: 'We fix pipes.' },
        summary: 's',
        createdBy: 'u-1',
      }),
    );
    await expect(approveProposal(repo, TENANT, proposal.id, 'd-1', 'dispatcher', new InMemoryAuditRepository())).rejects.toThrow();
    expect((await repo.findById(TENANT, proposal.id))?.status).toBe('draft');
    const approvedProposal = await approveProposal(repo, TENANT, proposal.id, 'o-1', 'owner', new InMemoryAuditRepository());
    expect(approvedProposal.status).toBe('approved');
  });
});

describe('UpdateTenantSiteAboutExecutionHandler', () => {
  async function setup() {
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.upsertIdentityFields(TENANT, { businessName: "Joe's Plumbing" });
    const auditRepo = new InMemoryAuditRepository();
    return { settingsRepo, auditRepo, handler: new UpdateTenantSiteAboutExecutionHandler(settingsRepo, auditRepo) };
  }

  it('sets the site about copy to the approved text and audits it', async () => {
    const { settingsRepo, auditRepo, handler } = await setup();
    const result = await handler.execute(approved({ aboutText: 'We fix pipes.' }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
      executedByRole: 'owner',
    });
    expect(result).toEqual({ success: true, resultEntityId: TENANT });
    expect((await settingsRepo.findByTenant(TENANT))?.siteAboutText).toBe('We fix pipes.');
    const events = await auditRepo.findByEntity(TENANT, 'tenant_site', TENANT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'tenant_site.about_set',
      actorId: 'owner-1',
      actorRole: 'owner',
      metadata: { length: 'We fix pipes.'.length, editedFromDraft: false },
    });
  });

  it("records that the owner edited the AI's draft", async () => {
    const { auditRepo, handler } = await setup();
    await handler.execute(
      approved({ aboutText: 'Edited by the owner.' }, { originalPayload: { aboutText: 'The AI draft.' } }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );
    const [event] = await auditRepo.findByEntity(TENANT, 'tenant_site', TENANT);
    expect(event?.metadata).toMatchObject({ editedFromDraft: true });
  });

  it('refuses a payload that fails the contract, writing nothing', async () => {
    const { settingsRepo, auditRepo, handler } = await setup();
    const result = await handler.execute(approved({ aboutText: '' }), { tenantId: TENANT, executedBy: 'o' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/contract/);
    expect((await settingsRepo.findByTenant(TENANT))?.siteAboutText).toBeFalsy();
    expect(await auditRepo.findByEntity(TENANT, 'tenant_site', TENANT)).toHaveLength(0);
  });

  it('reports a wiring fault instead of a synthetic success', async () => {
    const handler = new UpdateTenantSiteAboutExecutionHandler(undefined, new InMemoryAuditRepository());
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(approved({ aboutText: 'Hi' }), { tenantId: TENANT, executedBy: 'o' });
    expect(result).toEqual({ success: false, error: 'handler_not_wired:settingsRepo' });
  });

  it('fails honestly when the tenant has no settings', async () => {
    const handler = new UpdateTenantSiteAboutExecutionHandler(new InMemorySettingsRepository(), new InMemoryAuditRepository());
    const result = await handler.execute(approved({ aboutText: 'Hi' }), { tenantId: 'nobody', executedBy: 'o' });
    expect(result.success).toBe(false);
  });
});
