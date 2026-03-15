import { ContextBlock, createContextBlock } from '../context-assembly';
import { EstimateTemplate } from './estimate-template';
import { ServiceTaxonomy, ServiceCategory, findCategoryById, getCategoryPath } from '../../verticals/service-taxonomy';

export function buildCategoryContextBlock(taxonomy: ServiceTaxonomy, categoryId: string): ContextBlock {
  const path = getCategoryPath(taxonomy, categoryId);
  const content = formatCategoryPathForPrompt(path);
  return createContextBlock('service_category', taxonomy.verticalSlug, content, 7);
}

export function buildTemplateContextBlock(template: EstimateTemplate): ContextBlock {
  const content = formatTemplateForPrompt(template);
  return createContextBlock('estimate_template', template.verticalSlug, content, 9);
}

export async function assembleTemplateContext(
  tenantId: string,
  verticalSlug: string,
  categoryId: string,
  templateRepo: { findByVerticalAndCategory(verticalSlug: string, categoryId: string): Promise<EstimateTemplate[]> },
  taxonomyRepo: { findLatestByVertical(verticalSlug: string): Promise<ServiceTaxonomy | null> }
): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];

  const taxonomy = await taxonomyRepo.findLatestByVertical(verticalSlug);
  if (taxonomy) {
    blocks.push(buildCategoryContextBlock(taxonomy, categoryId));
  }

  const templates = await templateRepo.findByVerticalAndCategory(verticalSlug, categoryId);
  if (templates.length > 0) {
    blocks.push(buildTemplateContextBlock(templates[0]));
  }

  return blocks;
}

export function formatTemplateForPrompt(template: EstimateTemplate): string {
  const lines = [
    `Template: ${template.name}`,
    `Description: ${template.description}`,
    `Category: ${template.categoryId}`,
    '',
    'Line item structure:',
  ];

  for (const li of template.lineItemTemplates) {
    const optional = li.isOptional ? ' (optional)' : '';
    const price = li.defaultUnitPrice ? ` @ $${li.defaultUnitPrice}` : '';
    lines.push(`  ${li.sortOrder}. ${li.description}${price}${optional}`);
  }

  if (template.promptHints.length > 0) {
    lines.push('');
    lines.push('Hints:');
    for (const hint of template.promptHints) {
      lines.push(`  - ${hint}`);
    }
  }

  return lines.join('\n');
}

export function formatCategoryPathForPrompt(path: ServiceCategory[]): string {
  if (path.length === 0) return 'Unknown category';
  return `Service category: ${path.map((c) => c.name).join(' > ')}\nDescription: ${path[path.length - 1].description}`;
}
