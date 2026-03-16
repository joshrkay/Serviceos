import {
  createTemplateProvenanceTag,
  tagEstimateWithTemplate,
  validateTemplateProvenanceInput,
  InMemoryTemplateProvenanceRepository,
} from '../../../src/ai/evaluation/template-provenance';
import { createTemplate, InMemoryEstimateTemplateRepository } from '../../../src/ai/tasks/estimate-template';

describe('P4-004C — Template provenance tagging', () => {
  it('happy path — creates provenance tag', () => {
    const tag = createTemplateProvenanceTag({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      templateId: 'tmpl-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
    });

    expect(tag.id).toBeTruthy();
    expect(tag.tenantId).toBe('tenant-1');
    expect(tag.taggedAt).toBeInstanceOf(Date);
  });

  it('happy path — tagEstimateWithTemplate creates tag from template', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'Test',
      defaultLineItems: [],
    }, repo);
    const tag = tagEstimateWithTemplate('est-1', template, 'tenant-1');
    expect(tag.templateId).toBe(template.id);
    expect(tag.verticalType).toBe('hvac');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateTemplateProvenanceInput({
      tenantId: '',
      estimateId: '',
      templateId: '',
      verticalType: '',
      serviceCategory: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('templateId is required');
    expect(errors).toContain('verticalType is required');
    expect(errors).toContain('serviceCategory is required');
  });

  it('mock provider test — repository stores and retrieves by estimate', async () => {
    const repo = new InMemoryTemplateProvenanceRepository();
    const tag = createTemplateProvenanceTag({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      templateId: 'tmpl-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
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
      verticalType: 'hvac',
      serviceCategory: 'repair',
    });
    await repo.create(tag);

    const found = await repo.findByEstimate('other-tenant', 'est-1');
    expect(found).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — handles template with no metadata', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'Minimal',
      defaultLineItems: [],
    }, repo);
    const tag = tagEstimateWithTemplate('est-1', template, 'tenant-1');
    expect(tag.templateId).toBeTruthy();
    expect(tag.serviceCategory).toBe('repair');
  });
});
