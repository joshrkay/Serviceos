import { ContextBlock, createContextBlock } from '../context-assembly';
import { EstimateTemplate, EstimateTemplateRepository, TemplateLineItem } from './estimate-template';
import { VerticalType, ServiceCategory } from '../../shared/vertical-types';
import { ServiceTaxonomy, ServiceCategory as TaxonomyCategory, findCategoryById, getCategoryPath } from '../../verticals/service-taxonomy';

export function buildCategoryContextBlock(taxonomy: ServiceTaxonomy, categoryId: string): ContextBlock {
  const path = getCategoryPath(taxonomy, categoryId);
  const content = formatCategoryPathForPrompt(path);
  return createContextBlock('service_category', taxonomy.verticalSlug, content, 7);
}

export function buildTemplateContextBlock(template: EstimateTemplate): ContextBlock {
  const content = formatTemplateForPrompt(template);
  return createContextBlock('estimate_template', template.verticalType, content, 9);
}

export async function assembleTemplateContext(
  tenantId: string,
  verticalType: VerticalType,
  serviceCategory: ServiceCategory,
  templateRepo: EstimateTemplateRepository,
  taxonomyRepo: { findLatestByVertical(verticalSlug: string): Promise<ServiceTaxonomy | null> }
): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];

  const taxonomy = await taxonomyRepo.findLatestByVertical(verticalType);
  if (taxonomy) {
    blocks.push(buildCategoryContextBlock(taxonomy, serviceCategory));
  }

  const template = await templateRepo.findByVerticalAndCategory(verticalType, serviceCategory);
  if (template) {
    blocks.push(buildTemplateContextBlock(template));
  }

  return blocks;
}

export function formatTemplateForPrompt(template: EstimateTemplate): string {
  const lines = [
    `Template: ${template.name}`,
    `Description: ${template.defaultNotes || template.name}`,
    `Category: ${template.serviceCategory}`,
    '',
    'Line item structure:',
  ];

  for (const li of template.defaultLineItems) {
    const price = li.unitPriceCents ? ` @ $${(li.unitPriceCents / 100).toFixed(2)}` : '';
    lines.push(`  ${li.sortOrder}. ${li.description}${price}`);
  }

  return lines.join('\n');
}

export function formatCategoryPathForPrompt(path: TaxonomyCategory[]): string {
  if (path.length === 0) return 'Unknown category';
  return `Service category: ${path.map((c) => c.name).join(' > ')}\nDescription: ${path[path.length - 1].description}`;
}
