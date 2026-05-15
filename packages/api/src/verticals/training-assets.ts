import { z } from 'zod';
import type { VerticalType } from '../shared/vertical-types';

export const trainingAssetKindSchema = z.enum([
  'prompt_context',
  'rag_seed',
  'eval_scenario',
  'labeled_call_example',
  'intake_question',
  'objection_script',
  'emergency_rule',
  'false_positive_guard',
]);

export type TrainingAssetKind = z.infer<typeof trainingAssetKindSchema>;

export const trainingAssetStatusSchema = z.enum([
  'draft',
  'redacted',
  'quarantined',
  'approved',
  'active',
  'archived',
]);

export type TrainingAssetStatus = z.infer<typeof trainingAssetStatusSchema>;

export const trainingAssetLabelsSchema = z.object({
  intent: z.string().min(1).optional(),
  entities: z.record(z.unknown()).optional(),
  urgencyTier: z.enum(['low', 'normal', 'high', 'emergency']).optional(),
  expectedNextQuestion: z.string().min(1).nullable().optional(),
  expectedNextAction: z.string().min(1).optional(),
  shouldEscalate: z.boolean().optional(),
  expectedRetrievalTerms: z.array(z.string().min(1)).optional(),
}).default({});

export type TrainingAssetLabels = z.infer<typeof trainingAssetLabelsSchema>;

export const trainingAssetProvenanceSchema = z.object({
  source: z.enum([
    'synthetic_default',
    'tenant_admin',
    'redacted_call',
    'imported_document',
    'approved_eval',
  ]),
  sourceId: z.string().min(1).optional(),
  sourceVersion: z.string().min(1),
  notes: z.string().max(1000).optional(),
});

export type TrainingAssetProvenance = z.infer<typeof trainingAssetProvenanceSchema>;

export const trainingAssetInputSchema = z.object({
  verticalType: z.enum(['hvac', 'plumbing', 'electrical']),
  assetKind: trainingAssetKindSchema,
  title: z.string().min(3).max(160),
  rawText: z.string().min(1).max(12000),
  labels: trainingAssetLabelsSchema,
  provenance: trainingAssetProvenanceSchema,
});

export type TrainingAssetInput = z.infer<typeof trainingAssetInputSchema>;

export interface TrainingAssetRedactionSummary {
  redactionCount: number;
  redactionKinds: string[];
  placeholders: string[];
  residualSignals: string[];
  hasResidualPii: boolean;
}

export interface VerticalTrainingAsset {
  id: string;
  tenantId: string;
  verticalType: VerticalType;
  assetKind: TrainingAssetKind;
  status: TrainingAssetStatus;
  title: string;
  rawText?: string;
  scrubbedText?: string;
  labels: TrainingAssetLabels;
  provenance: TrainingAssetProvenance;
  redactionSummary?: TrainingAssetRedactionSummary;
  createdBy: string;
  approvedBy?: string;
  activatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTrainingAssetDraftInput extends TrainingAssetInput {
  id: string;
  tenantId: string;
  createdBy: string;
  now: Date;
}

export function createTrainingAssetDraft(input: CreateTrainingAssetDraftInput): VerticalTrainingAsset {
  const parsed = trainingAssetInputSchema.parse(input);
  return {
    id: input.id,
    tenantId: input.tenantId,
    verticalType: parsed.verticalType,
    assetKind: parsed.assetKind,
    status: 'draft',
    title: parsed.title,
    rawText: parsed.rawText,
    labels: parsed.labels,
    provenance: parsed.provenance,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const VERTICAL_LABELS: Record<VerticalType, string> = {
  hvac: 'HVAC',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
};

export function buildTrainingAssetPromptSection(assets: readonly VerticalTrainingAsset[]): string {
  const active = assets.filter((asset) => asset.status === 'active' && asset.scrubbedText);
  if (active.length === 0) return '';

  const lines: string[] = ['Tenant-approved vertical voice training assets:'];
  for (const asset of active) {
    const vertical = VERTICAL_LABELS[asset.verticalType];
    lines.push(`- ${vertical} training context (${asset.assetKind}): ${asset.title}`);
    lines.push(`  Guidance: ${asset.scrubbedText}`);
    if (asset.labels.expectedNextQuestion) {
      lines.push(`  Expected next question: ${asset.labels.expectedNextQuestion}`);
    }
    if (asset.labels.expectedNextAction) {
      lines.push(`  Expected next action: ${asset.labels.expectedNextAction}`);
    }
  }
  return lines.join('\n');
}
