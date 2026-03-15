import { v4 as uuidv4 } from 'uuid';
import { EstimateTemplate } from '../tasks/estimate-template';

export interface TemplateProvenanceTag {
  id: string;
  tenantId: string;
  estimateId: string;
  templateId: string;
  templateVersion: number;
  verticalSlug: string;
  categoryId: string;
  taggedAt: Date;
}

export interface CreateTemplateProvenanceInput {
  tenantId: string;
  estimateId: string;
  templateId: string;
  templateVersion: number;
  verticalSlug: string;
  categoryId: string;
}

export interface TemplateProvenanceRepository {
  create(tag: TemplateProvenanceTag): Promise<TemplateProvenanceTag>;
  findByEstimate(tenantId: string, estimateId: string): Promise<TemplateProvenanceTag[]>;
  findByTemplate(tenantId: string, templateId: string): Promise<TemplateProvenanceTag[]>;
}

export function validateTemplateProvenanceInput(input: CreateTemplateProvenanceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.templateId) errors.push('templateId is required');
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.categoryId) errors.push('categoryId is required');
  return errors;
}

export function createTemplateProvenanceTag(input: CreateTemplateProvenanceInput): TemplateProvenanceTag {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    estimateId: input.estimateId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    verticalSlug: input.verticalSlug,
    categoryId: input.categoryId,
    taggedAt: new Date(),
  };
}

export function tagEstimateWithTemplate(
  estimateId: string,
  template: EstimateTemplate,
  tenantId: string
): TemplateProvenanceTag {
  return createTemplateProvenanceTag({
    tenantId,
    estimateId,
    templateId: template.id,
    templateVersion: template.version,
    verticalSlug: template.verticalSlug,
    categoryId: template.categoryId,
  });
}

export class InMemoryTemplateProvenanceRepository implements TemplateProvenanceRepository {
  private tags: Map<string, TemplateProvenanceTag> = new Map();

  async create(tag: TemplateProvenanceTag): Promise<TemplateProvenanceTag> {
    this.tags.set(tag.id, { ...tag });
    return { ...tag };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<TemplateProvenanceTag[]> {
    return Array.from(this.tags.values())
      .filter((t) => t.tenantId === tenantId && t.estimateId === estimateId)
      .map((t) => ({ ...t }));
  }

  async findByTemplate(tenantId: string, templateId: string): Promise<TemplateProvenanceTag[]> {
    return Array.from(this.tags.values())
      .filter((t) => t.tenantId === tenantId && t.templateId === templateId)
      .map((t) => ({ ...t }));
  }
}
