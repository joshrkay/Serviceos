import { EstimateTemplate, EstimateTemplateRepository, TemplateLineItem } from './estimate-template';
import { VerticalType, ServiceCategory } from '../../shared/vertical-types';

export interface TemplateMatch {
  template: EstimateTemplate;
  score: number;
  matchReason: string;
}

export interface TemplateRetrievalOptions {
  verticalType: VerticalType;
  serviceCategory?: ServiceCategory;
  searchTerms?: string[];
  limit?: number;
}

export async function findMatchingTemplates(
  options: TemplateRetrievalOptions,
  repo: EstimateTemplateRepository
): Promise<TemplateMatch[]> {
  let templates: EstimateTemplate[];

  if (options.serviceCategory) {
    const exact = await repo.findByVerticalAndCategory(options.verticalType, options.serviceCategory);
    templates = exact ? [exact] : [];
  } else {
    templates = await repo.findByVertical(options.verticalType);
  }

  const matches = templates.map((template) => ({
    template,
    score: scoreTemplateMatch(template, options),
    matchReason: buildMatchReason(template, options),
  }));

  matches.sort((a, b) => b.score - a.score);

  const limit = options.limit || 10;
  return matches.slice(0, limit);
}

export function scoreTemplateMatch(
  template: EstimateTemplate,
  options: TemplateRetrievalOptions
): number {
  let score = 0;

  if (template.verticalType === options.verticalType) score += 0.3;
  if (options.serviceCategory && template.serviceCategory === options.serviceCategory) score += 0.4;

  if (options.searchTerms && options.searchTerms.length > 0) {
    const templateText = [
      template.name,
      template.defaultNotes || '',
      ...template.defaultLineItems.map((li: TemplateLineItem) => li.description),
    ].join(' ').toLowerCase();

    const matchedTerms = options.searchTerms.filter((term) =>
      templateText.includes(term.toLowerCase())
    );
    score += (matchedTerms.length / options.searchTerms.length) * 0.3;
  }

  return Math.min(score, 1);
}

export async function getBestTemplate(
  options: TemplateRetrievalOptions,
  repo: EstimateTemplateRepository
): Promise<EstimateTemplate | null> {
  const matches = await findMatchingTemplates({ ...options, limit: 1 }, repo);
  return matches.length > 0 ? matches[0].template : null;
}

function buildMatchReason(template: EstimateTemplate, options: TemplateRetrievalOptions): string {
  const reasons: string[] = [];
  if (template.verticalType === options.verticalType) reasons.push('vertical match');
  if (options.serviceCategory && template.serviceCategory === options.serviceCategory) reasons.push('category match');
  if (options.searchTerms) reasons.push('search terms evaluated');
  return reasons.join(', ') || 'default';
}
