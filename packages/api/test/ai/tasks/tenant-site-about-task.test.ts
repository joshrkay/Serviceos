/**
 * D-044 / #1769 — the about-copy draft is a gateway call, built only from
 * facts the owner entered, and cleaned into plain text within the contract cap.
 */
import { describe, it, expect } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import {
  TenantSiteAboutTask,
  buildTenantSiteAboutPrompt,
  cleanTenantSiteAboutText,
} from '../../../src/ai/tasks/tenant-site-about-task';
import { TENANT_SITE_ABOUT_MAX_LENGTH } from '../../../src/proposals/contracts/tenant-site-about';

const INPUT = {
  tenantId: 'tenant-about-task',
  businessName: "Joe's Plumbing",
  services: ['Plumbing', 'HVAC'],
  serviceArea: 'Austin, TX',
  brandVoice: { formality: 'casual' as const, pronoun: 'we' as const, vibe_words: ['neighborly'] },
};

describe('TenantSiteAboutTask', () => {
  it('drafts through the gateway as the tenant_site_about task, from settings facts', async () => {
    const { gateway, provider } = createMockLLMGateway("Joe's Plumbing has served Austin. Call us for a quote.");
    const result = await new TenantSiteAboutTask(gateway).draft(INPUT);

    expect(result.aboutText).toBe("Joe's Plumbing has served Austin. Call us for a quote.");
    const calls = provider.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.taskType).toBe('tenant_site_about');
    const [system, user] = calls[0]!.messages;
    expect(system!.role).toBe('system');
    expect(system!.content).toContain('neighborly');
    expect(user!.content).toContain("Business name: Joe's Plumbing");
    expect(user!.content).toContain('Services: Plumbing, HVAC');
    expect(user!.content).toContain('Area served: Austin, TX');
  });

  it('forbids inventing facts in the prompt', () => {
    const { system } = buildTenantSiteAboutPrompt(INPUT);
    expect(system).toMatch(/Use ONLY the facts given/);
    for (const invented of ['years in business', 'licences', 'guarantees', 'prices']) {
      expect(system).toContain(invented);
    }
  });

  it('says plainly when services or area were not given', () => {
    const { user } = buildTenantSiteAboutPrompt({ tenantId: 't', businessName: 'Acme', services: [], serviceArea: ' ' });
    expect(user).toContain('Services: not specified');
    expect(user).toContain('Area served: not specified');
  });

  it('throws on an empty draft rather than proposing nothing', async () => {
    const { gateway } = createMockLLMGateway('   ');
    await expect(new TenantSiteAboutTask(gateway).draft(INPUT)).rejects.toThrow(/empty draft/);
  });
});

describe('cleanTenantSiteAboutText', () => {
  it('strips wrapping quotes, markdown emphasis and stray headings', () => {
    expect(cleanTenantSiteAboutText('"## About us\n\nWe are **Joe\'s**."')).toBe("We are Joe's.");
  });

  it('collapses runs of blank lines', () => {
    expect(cleanTenantSiteAboutText('One.\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
  });

  it('keeps an over-long reply within the contract cap, ending on a sentence', () => {
    const sentence = 'We take pride in careful, tidy work. ';
    const cleaned = cleanTenantSiteAboutText(sentence.repeat(60));
    expect(cleaned.length).toBeLessThanOrEqual(TENANT_SITE_ABOUT_MAX_LENGTH);
    expect(cleaned.endsWith('.')).toBe(true);
  });
});
