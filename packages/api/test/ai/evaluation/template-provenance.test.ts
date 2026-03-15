import {
  createTemplateProvenanceTag,
  tagEstimateWithTemplate,
  validateTemplateProvenanceInput,
  InMemoryTemplateProvenanceRepository,
} from '../../../src/ai/evaluation/template-provenance';
import { createEstimateTemplate } from '../../../src/ai/tasks/estimate-template';

describe('P4-004C — Template provenance tagging', () => {
  it('happy path — creates provenance tag', () => {
    const tag = createTemplateProvenanceTag({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      templateId: 'tmpl-1',
      templateVersion: 1,
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
    });

    expect(tag.id).toBeTruthy();
    expect(tag.tenantId).toBe('tenant-1');
    expect(tag.taggedAt).toBeInstanceOf(Date);
  });

  it('happy path — tagEstimateWithTemplate creates tag from template', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'Test',
      description: 'Test',
      lineItemTemplates: [],
    });
    const tag = tagEstimateWithTemplate('est-1', template, 'tenant-1');
    expect(tag.templateId).toBe(template.id);
    expect(tag.verticalSlug).toBe('hvac');
    expect(tag.templateVersion).toBe(1);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateTemplateProvenanceInput({
      tenantId: '',
      estimateId: '',
      templateId: '',
      templateVersion: 1,
      verticalSlug: '',
      categoryId: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('templateId is required');
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('categoryId is required');
  });

  it('mock provider test — repository stores and retrieves by estimate', async () => {
    const repo = new InMemoryTemplateProvenanceRepository();
    const tag = createTemplateProvenanceTag({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      templateId: 'tmpl-1',
      templateVersion: 1,
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
    });
    await repo.create(tag);

    const found = await repo.findByEstimate('tenant-1', 'est-1');
    expect(found).toHaveLength(1);
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryTemplateProvenanceRepository();
    const tag = createTemplateProvenanceTag({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      templateId: 'tmpl-1',
      templateVersion: 1,
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
    });
    await repo.create(tag);

    const found = await repo.findByEstimate('other-tenant', 'est-1');
    expect(found).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — handles template with no metadata', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'Minimal',
      description: 'Minimal template',
      lineItemTemplates: [],
    });
    const tag = tagEstimateWithTemplate('est-1', template, 'tenant-1');
    expect(tag.templateId).toBeTruthy();
    expect(tag.categoryId).toBe('hvac-repair');
  });
});
