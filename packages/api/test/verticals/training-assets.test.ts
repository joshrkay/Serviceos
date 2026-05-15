import { describe, expect, it } from 'vitest';
import {
  getServiceCategories,
  isValidVerticalType,
  VALID_VERTICAL_TYPES,
} from '../../src/shared/vertical-types';
import {
  buildTrainingAssetPromptSection,
  createTrainingAssetDraft,
  trainingAssetInputSchema,
} from '../../src/verticals/training-assets';
import { buildMergedVerticalVoicePrompt } from '../../src/verticals/context-assembly';
import { validateVerticalPack } from '../../src/verticals/registry';

describe('vertical type support', () => {
  it('treats electrical as supported but second-class', () => {
    expect(VALID_VERTICAL_TYPES).toEqual(['hvac', 'plumbing', 'electrical']);
    expect(isValidVerticalType('electrical')).toBe(true);
    expect(getServiceCategories('electrical')).toEqual([
      'diagnostic',
      'repair',
      'install',
      'panel',
      'lighting',
      'safety',
      'emergency',
    ]);
  });

  it('validates an electrical vertical pack', () => {
    const errors = validateVerticalPack({
      verticalType: 'electrical',
      displayName: 'Electrical Basic',
      version: '1.0.0',
      categories: [{ id: 'electrical-diagnostic', name: 'Diagnostic', sortOrder: 1 }],
    });
    expect(errors).toEqual([]);
  });
});

describe('vertical training assets', () => {
  it('validates labeled call examples with expected classifier behavior', () => {
    const parsed = trainingAssetInputSchema.parse({
      verticalType: 'hvac',
      assetKind: 'labeled_call_example',
      title: 'No heat emergency example',
      rawText: 'Caller says the furnace is out and it is 10 degrees outside.',
      labels: {
        intent: 'emergency_dispatch',
        urgencyTier: 'emergency',
        expectedNextAction: 'escalate_to_oncall',
        expectedNextQuestion: null,
      },
      provenance: {
        source: 'synthetic_default',
        sourceVersion: '2026-05-15',
      },
    });

    expect(parsed.verticalType).toBe('hvac');
    expect(parsed.labels.intent).toBe('emergency_dispatch');
  });

  it('creates drafts that are not eligible for prompt context', () => {
    const draft = createTrainingAssetDraft({
      id: 'asset-1',
      tenantId: 'tenant-1',
      verticalType: 'plumbing',
      assetKind: 'rag_seed',
      title: 'Water shutoff guidance',
      rawText: 'Ask whether the water is shut off before scheduling.',
      labels: {},
      provenance: { source: 'tenant_admin', sourceVersion: '1' },
      createdBy: 'user-1',
      now: new Date('2026-05-15T00:00:00Z'),
    });

    expect(draft.status).toBe('draft');
    expect(buildTrainingAssetPromptSection([draft])).toBe('');
  });

  it('formats only active scrubbed assets into a voice prompt section', () => {
    const active = {
      ...createTrainingAssetDraft({
        id: 'asset-2',
        tenantId: 'tenant-1',
        verticalType: 'electrical',
        assetKind: 'intake_question',
        title: 'Breaker triage',
        rawText: 'Ask whether one breaker is tripping or the whole panel is out.',
        labels: { expectedNextQuestion: 'Is one breaker tripping, or is the whole panel out?' },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
        createdBy: 'user-1',
        now: new Date('2026-05-15T00:00:00Z'),
      }),
      status: 'active' as const,
      scrubbedText: 'Ask whether one breaker is tripping or the whole panel is out.',
    };

    expect(buildTrainingAssetPromptSection([active])).toContain('Electrical training context');
    expect(buildTrainingAssetPromptSection([active])).toContain('Breaker triage');
  });
});

describe('merged vertical voice prompt', () => {
  it('places active tenant training assets after canonical pack context', () => {
    const prompt = buildMergedVerticalVoicePrompt({
      canonicalPrompt: 'Service vertical: HVAC Professional',
      trainingAssetPrompt: 'Tenant-approved vertical voice training assets:\n- HVAC training context: Ask about heating or cooling.',
    });

    expect(prompt).toBe(
      'Service vertical: HVAC Professional\n\nTenant-approved vertical voice training assets:\n- HVAC training context: Ask about heating or cooling.',
    );
  });
});
