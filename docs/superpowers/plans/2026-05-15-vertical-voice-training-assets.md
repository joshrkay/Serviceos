# Vertical Voice Training Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build tenant-editable vertical voice training assets for HVAC, plumbing, and second-class electrical, with mandatory redaction, quarantine, approval, RAG seeding, eval scenarios, and labeled call examples.

**Architecture:** Store tenant-owned training assets in Postgres with RLS, provenance, redaction metadata, and lifecycle status. Reuse the existing deterministic `scrubPii()` pipeline and `knowledge_chunks` RAG table: raw tenant text never feeds embeddings, `scrubbed_text` is required, residual PII routes assets to quarantine, and only `active` assets produce prompt/RAG/eval context. Canonical HVAC/plumbing defaults remain code-seeded; tenant assets layer on top through a repository/service boundary.

**Tech Stack:** TypeScript, Node, Express, PostgreSQL/RLS, pgvector-backed `knowledge_chunks`, Zod, Vitest + Supertest. Redaction v1 uses `packages/api/src/ai/training/scrub.ts`; the service boundary must allow a future Presidio provider without changing routes.

---

## Context the executing engineer needs

The repo already has most of the voice-context plumbing:

- `packages/api/src/verticals/packs/hvac.ts` and `packages/api/src/verticals/packs/plumbing.ts` define categories, terminology, intake questions, and objection scripts.
- `packages/api/src/verticals/resolve-active-pack.ts` builds a tenant-specific prompt section and caches it per tenant.
- `packages/api/src/telephony/twilio-adapter.ts` and `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` pass that vertical prompt section into `classifyIntent`.
- `packages/api/src/db/schema.ts` already defines `knowledge_chunks` with `content` and `content_scrubbed`, RLS, and idempotent source/version dedupe.
- `packages/api/src/ai/training/scrub.ts` exposes deterministic `scrubPii(text, { knownEntities, failOnResidual })`.
- `packages/api/src/ai/training/knowledge-chunks.ts` currently allows source types such as `vertical_terminology` and `vertical_category`; this plan adds source types for tenant training assets.
- `packages/api/src/shared/vertical-types.ts` only allows `hvac | plumbing`. Electrical must be added as a supported but lower-priority vertical.

**Product priority:**

- First-class: `hvac`, `plumbing`.
- Second-class: `electrical`.
- Tenant-editable database assets are the primary path.
- Code-seeded pack defaults still exist as canonical fallback and bootstrapping data.

**Privacy invariants:**

- Redaction runs before any training asset repository save.
- If residual PII remains, the asset is saved as `quarantined` and cannot feed prompts, RAG, or evals.
- Embeddings use `scrubbedText`, never raw tenant text.
- Privacy audit rows store redaction counts, kinds, placeholders, offsets, and residual signals; never raw matched PII.
- Real tenant call examples remain tenant-scoped. Global/default assets must be synthetic or manually generalized.

**Build verification (mandatory, from `CLAUDE.md`):**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Run it before each commit that touches API code. The default `tsconfig.json` includes tests and is not enough.

---

## File Structure

**Created:**

- `packages/api/src/verticals/training-assets.ts` — domain types, Zod schemas, lifecycle helpers, and `buildTrainingAssetPromptSection`.
- `packages/api/src/verticals/training-asset-redaction.ts` — `TrainingAssetRedactionService`; wraps `scrubPii`, converts redactions to audit-safe metadata, and decides `redacted` vs `quarantined`.
- `packages/api/src/verticals/pg-training-assets.ts` — Postgres repository for tenant training assets.
- `packages/api/src/verticals/in-memory-training-assets.ts` — test/dev repository.
- `packages/api/src/verticals/training-asset-service.ts` — orchestration service; validates input, redacts before save, approves/activates assets, and writes audit rows.
- `packages/api/src/routes/vertical-training-assets.ts` — authenticated API routes.
- `packages/api/test/verticals/training-assets.test.ts` — pure domain tests.
- `packages/api/test/verticals/training-asset-redaction.test.ts` — redaction/quarantine tests.
- `packages/api/test/verticals/training-asset-service.test.ts` — service lifecycle tests.
- `packages/api/test/routes/vertical-training-assets.route.test.ts` — route tests.

**Modified:**

- `packages/api/src/db/schema.ts` — add `privacy_audit` and `vertical_training_assets` migrations.
- `packages/api/src/shared/vertical-types.ts` — add second-class `electrical`.
- `packages/api/src/shared/contracts.ts` — extend `verticalTypeSchema` to include `electrical`.
- `packages/api/src/verticals/registry.ts` — permit electrical in vertical pack validation.
- `packages/api/src/verticals/context-assembly.ts` — include active approved training assets in voice prompt formatting.
- `packages/api/src/verticals/resolve-active-pack.ts` — resolve approved tenant assets and merge them after canonical pack context.
- `packages/api/src/verticals/packs/hvac.ts` — seed first-class default training metadata.
- `packages/api/src/verticals/packs/plumbing.ts` — seed first-class default training metadata.
- `packages/api/src/verticals/packs/electrical.ts` — create second-class default electrical pack.
- `packages/api/src/shared/canonical-vertical-packs.ts` — register `electrical-v1` after `hvac-v1` and `plumbing-v1`.
- `packages/api/src/ai/training/knowledge-chunks.ts` — add training asset source types.
- `packages/api/src/app.ts` — instantiate repo/service, mount routes, and wire approved training assets into vertical prompt resolver.

---

## Task 1: Vertical type support for second-class electrical

**Files:**

- Modify: `packages/api/src/shared/vertical-types.ts`
- Modify: `packages/api/src/shared/contracts.ts`
- Modify: `packages/api/src/verticals/registry.ts`
- Test: `packages/api/test/verticals/training-assets.test.ts`

- [ ] **Step 1: Write the failing vertical-type test**

Create `packages/api/test/verticals/training-assets.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  getServiceCategories,
  isValidVerticalType,
  VALID_VERTICAL_TYPES,
} from '../../src/shared/vertical-types';
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
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: FAIL because `electrical` is not in `VerticalType`, categories, or `validateVerticalPack`.

- [ ] **Step 3: Add electrical to shared vertical types**

Modify `packages/api/src/shared/vertical-types.ts`:

```typescript
export type VerticalType = 'hvac' | 'plumbing' | 'electrical';

export const VALID_VERTICAL_TYPES: VerticalType[] = ['hvac', 'plumbing', 'electrical'];

export type PackStatus = 'draft' | 'active' | 'deprecated';

export const VALID_PACK_STATUSES: PackStatus[] = ['draft', 'active', 'deprecated'];

export type HvacServiceCategory =
  | 'diagnostic'
  | 'repair'
  | 'maintenance'
  | 'install'
  | 'replacement'
  | 'emergency';

export const HVAC_SERVICE_CATEGORIES: HvacServiceCategory[] = [
  'diagnostic', 'repair', 'maintenance', 'install', 'replacement', 'emergency',
];

export type PlumbingServiceCategory =
  | 'diagnostic'
  | 'repair'
  | 'install'
  | 'replacement'
  | 'drain'
  | 'water-heater'
  | 'emergency';

export const PLUMBING_SERVICE_CATEGORIES: PlumbingServiceCategory[] = [
  'diagnostic', 'repair', 'install', 'replacement', 'drain', 'water-heater', 'emergency',
];

export type ElectricalServiceCategory =
  | 'diagnostic'
  | 'repair'
  | 'install'
  | 'panel'
  | 'lighting'
  | 'safety'
  | 'emergency';

export const ELECTRICAL_SERVICE_CATEGORIES: ElectricalServiceCategory[] = [
  'diagnostic',
  'repair',
  'install',
  'panel',
  'lighting',
  'safety',
  'emergency',
];

export type ServiceCategory =
  | HvacServiceCategory
  | PlumbingServiceCategory
  | ElectricalServiceCategory;

export function isValidVerticalType(value: string): value is VerticalType {
  return VALID_VERTICAL_TYPES.includes(value as VerticalType);
}

export function isValidPackStatus(value: string): value is PackStatus {
  return VALID_PACK_STATUSES.includes(value as PackStatus);
}

export function getServiceCategories(verticalType: VerticalType): ServiceCategory[] {
  switch (verticalType) {
    case 'hvac':
      return [...HVAC_SERVICE_CATEGORIES];
    case 'plumbing':
      return [...PLUMBING_SERVICE_CATEGORIES];
    case 'electrical':
      return [...ELECTRICAL_SERVICE_CATEGORIES];
  }
}
```

- [ ] **Step 4: Update the Zod contract**

In `packages/api/src/shared/contracts.ts`, replace:

```typescript
export const verticalTypeSchema = z.enum(['hvac', 'plumbing']);
```

with:

```typescript
export const verticalTypeSchema = z.enum(['hvac', 'plumbing', 'electrical']);
```

- [ ] **Step 5: Update vertical pack validation**

In `packages/api/src/verticals/registry.ts`, replace the hard-coded validation block:

```typescript
if (type && !['hvac', 'plumbing'].includes(type)) {
  errors.push('verticalType must be hvac or plumbing');
}
```

with:

```typescript
if (type && !['hvac', 'plumbing', 'electrical'].includes(type)) {
  errors.push('verticalType must be hvac, plumbing, or electrical');
}
```

- [ ] **Step 6: Run the vertical-type test**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/shared/vertical-types.ts packages/api/src/shared/contracts.ts packages/api/src/verticals/registry.ts packages/api/test/verticals/training-assets.test.ts
git commit -m "feat(voice): add electrical vertical type support"
```

---

## Task 2: Training asset domain model and prompt formatting

**Files:**

- Create: `packages/api/src/verticals/training-assets.ts`
- Modify: `packages/api/test/verticals/training-assets.test.ts`

- [ ] **Step 1: Add failing domain tests**

Append to `packages/api/test/verticals/training-assets.test.ts`:

```typescript
import {
  buildTrainingAssetPromptSection,
  createTrainingAssetDraft,
  trainingAssetInputSchema,
} from '../../src/verticals/training-assets';

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
```

- [ ] **Step 2: Run the failing domain tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: FAIL because `training-assets.ts` does not exist.

- [ ] **Step 3: Create the domain model**

Create `packages/api/src/verticals/training-assets.ts`:

```typescript
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
```

- [ ] **Step 4: Run the domain tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/verticals/training-assets.ts packages/api/test/verticals/training-assets.test.ts
git commit -m "feat(voice): define vertical training asset model"
```

---

## Task 3: Redaction service and privacy-safe audit metadata

**Files:**

- Create: `packages/api/src/verticals/training-asset-redaction.ts`
- Create: `packages/api/test/verticals/training-asset-redaction.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Create `packages/api/test/verticals/training-asset-redaction.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';

describe('TrainingAssetRedactionService', () => {
  it('returns scrubbed text and audit-safe redaction metadata', () => {
    const service = new TrainingAssetRedactionService();

    const result = service.redact({
      text: 'My name is Sarah Jones, call me at 415-555-0123 about 10 Main St.',
      knownEntities: {
        names: ['Sarah Jones'],
      },
    });

    expect(result.scrubbedText).toContain('[CALLER_NAME]');
    expect(result.scrubbedText).toContain('[PHONE]');
    expect(result.scrubbedText).toContain('[ADDRESS]');
    expect(result.summary.redactionCount).toBeGreaterThanOrEqual(3);
    expect(result.summary.redactionKinds).toContain('known_name');
    expect(result.auditRedactions[0]).not.toHaveProperty('matched');
  });

  it('marks residual PII as quarantine-required without throwing', () => {
    const service = new TrainingAssetRedactionService();

    const result = service.redact({
      text: 'Customer account 123456789 needs no heat dispatch.',
    });

    expect(result.status).toBe('quarantined');
    expect(result.summary.hasResidualPii).toBe(true);
    expect(result.summary.residualSignals).toContain('digit_run_ge_7');
  });
});
```

- [ ] **Step 2: Run the failing redaction tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-redaction.test.ts
```

Expected: FAIL because the service file does not exist.

- [ ] **Step 3: Create the redaction service**

Create `packages/api/src/verticals/training-asset-redaction.ts`:

```typescript
import type { KnownEntities } from '../ai/training/scrub';
import { scrubPii } from '../ai/training/scrub';
import type { TrainingAssetRedactionSummary, TrainingAssetStatus } from './training-assets';

export interface TrainingAssetRedactionInput {
  text: string;
  knownEntities?: KnownEntities;
}

export interface AuditSafeRedaction {
  kind: string;
  placeholder: string;
  start: number;
  end: number;
}

export interface TrainingAssetRedactionResult {
  status: Extract<TrainingAssetStatus, 'redacted' | 'quarantined'>;
  scrubbedText: string;
  summary: TrainingAssetRedactionSummary;
  auditRedactions: AuditSafeRedaction[];
}

export class TrainingAssetRedactionService {
  redact(input: TrainingAssetRedactionInput): TrainingAssetRedactionResult {
    const scrubbed = scrubPii(input.text, {
      knownEntities: input.knownEntities,
      failOnResidual: false,
    });
    const auditRedactions = scrubbed.redactions.map((redaction) => ({
      kind: redaction.kind,
      placeholder: redaction.placeholder,
      start: redaction.start,
      end: redaction.end,
    }));
    const summary: TrainingAssetRedactionSummary = {
      redactionCount: auditRedactions.length,
      redactionKinds: [...new Set(auditRedactions.map((redaction) => redaction.kind))],
      placeholders: [...new Set(auditRedactions.map((redaction) => redaction.placeholder))],
      residualSignals: scrubbed.residualSignals,
      hasResidualPii: scrubbed.hasResidualPii,
    };

    return {
      status: scrubbed.hasResidualPii ? 'quarantined' : 'redacted',
      scrubbedText: scrubbed.scrubbed,
      summary,
      auditRedactions,
    };
  }
}
```

- [ ] **Step 4: Run redaction tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-redaction.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/verticals/training-asset-redaction.ts packages/api/test/verticals/training-asset-redaction.test.ts
git commit -m "feat(voice): add privacy-safe training asset redaction"
```

---

## Task 4: Postgres schema and repositories

**Files:**

- Modify: `packages/api/src/db/schema.ts`
- Create: `packages/api/src/verticals/pg-training-assets.ts`
- Create: `packages/api/src/verticals/in-memory-training-assets.ts`
- Modify: `packages/api/src/verticals/training-assets.ts`
- Create: `packages/api/test/verticals/training-asset-service.test.ts`

- [ ] **Step 1: Add failing repository contract tests**

Create `packages/api/test/verticals/training-asset-service.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { InMemoryTrainingAssetRepository } from '../../src/verticals/in-memory-training-assets';
import type { VerticalTrainingAsset } from '../../src/verticals/training-assets';

function makeAsset(overrides: Partial<VerticalTrainingAsset> = {}): VerticalTrainingAsset {
  const now = new Date('2026-05-15T00:00:00Z');
  return {
    id: 'asset-1',
    tenantId: 'tenant-1',
    verticalType: 'hvac',
    assetKind: 'rag_seed',
    status: 'active',
    title: 'No heat triage',
    rawText: 'Ask if no heat is affecting the whole home.',
    scrubbedText: 'Ask if no heat is affecting the whole home.',
    labels: { intent: 'emergency_dispatch' },
    provenance: { source: 'tenant_admin', sourceVersion: '1' },
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TrainingAssetRepository', () => {
  it('lists active assets by tenant and vertical only', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-2', tenantId: 'tenant-2', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-3', tenantId: 'tenant-1', verticalType: 'plumbing' }));
    await repo.save(makeAsset({ id: 'asset-4', tenantId: 'tenant-1', verticalType: 'hvac', status: 'draft' }));

    const active = await repo.listActiveByTenantAndVertical('tenant-1', 'hvac');

    expect(active.map((asset) => asset.id)).toEqual(['asset-1']);
  });

  it('updates lifecycle status without duplicating assets', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', status: 'redacted' }));
    await repo.save(makeAsset({ id: 'asset-1', status: 'approved', approvedBy: 'user-2' }));

    const all = await repo.listByTenant('tenant-1');

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('approved');
    expect(all[0].approvedBy).toBe('user-2');
  });
});
```

- [ ] **Step 2: Run the failing repository tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-service.test.ts
```

Expected: FAIL because repository files do not exist.

- [ ] **Step 3: Add repository interfaces**

Append to `packages/api/src/verticals/training-assets.ts`:

```typescript
export interface TrainingAssetRepository {
  save(asset: VerticalTrainingAsset): Promise<VerticalTrainingAsset>;
  findById(tenantId: string, id: string): Promise<VerticalTrainingAsset | null>;
  listByTenant(tenantId: string): Promise<VerticalTrainingAsset[]>;
  listActiveByTenantAndVertical(
    tenantId: string,
    verticalType: VerticalType,
  ): Promise<VerticalTrainingAsset[]>;
}

export interface PrivacyAuditEntry {
  id: string;
  tenantId: string;
  actorId: string;
  entityType: 'vertical_training_asset';
  entityId: string;
  operation: 'redact_training_asset';
  redactionSummary: TrainingAssetRedactionSummary;
  redactions: Array<{ kind: string; placeholder: string; start: number; end: number }>;
  createdAt: Date;
}

export interface PrivacyAuditRepository {
  create(entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry>;
}
```

- [ ] **Step 4: Create in-memory repository**

Create `packages/api/src/verticals/in-memory-training-assets.ts`:

```typescript
import type {
  PrivacyAuditEntry,
  PrivacyAuditRepository,
  TrainingAssetRepository,
  VerticalTrainingAsset,
} from './training-assets';
import type { VerticalType } from '../shared/vertical-types';

export class InMemoryTrainingAssetRepository implements TrainingAssetRepository {
  private readonly rows = new Map<string, VerticalTrainingAsset>();

  async save(asset: VerticalTrainingAsset): Promise<VerticalTrainingAsset> {
    this.rows.set(asset.id, asset);
    return asset;
  }

  async findById(tenantId: string, id: string): Promise<VerticalTrainingAsset | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return row;
  }

  async listByTenant(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  async listActiveByTenantAndVertical(
    tenantId: string,
    verticalType: VerticalType,
  ): Promise<VerticalTrainingAsset[]> {
    return [...this.rows.values()].filter(
      (row) =>
        row.tenantId === tenantId &&
        row.verticalType === verticalType &&
        row.status === 'active',
    );
  }
}

export class InMemoryPrivacyAuditRepository implements PrivacyAuditRepository {
  readonly rows: PrivacyAuditEntry[] = [];

  async create(entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry> {
    this.rows.push(entry);
    return entry;
  }
}
```

- [ ] **Step 5: Add Postgres migrations**

Add a new migration key at the end of `MIGRATIONS` in `packages/api/src/db/schema.ts` using the next available number:

```typescript
'095_vertical_training_assets': `
  CREATE TABLE IF NOT EXISTS privacy_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    operation TEXT NOT NULL,
    redaction_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    redactions JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_privacy_audit_tenant_time
    ON privacy_audit (tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_privacy_audit_entity
    ON privacy_audit (tenant_id, entity_type, entity_id);
  ALTER TABLE privacy_audit ENABLE ROW LEVEL SECURITY;
  ALTER TABLE privacy_audit FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_privacy_audit ON privacy_audit;
  CREATE POLICY tenant_isolation_privacy_audit ON privacy_audit
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

  CREATE TABLE IF NOT EXISTS vertical_training_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vertical_type TEXT NOT NULL CHECK (vertical_type IN ('hvac', 'plumbing', 'electrical')),
    asset_kind TEXT NOT NULL CHECK (
      asset_kind IN (
        'prompt_context',
        'rag_seed',
        'eval_scenario',
        'labeled_call_example',
        'intake_question',
        'objection_script',
        'emergency_rule',
        'false_positive_guard'
      )
    ),
    status TEXT NOT NULL CHECK (
      status IN ('draft', 'redacted', 'quarantined', 'approved', 'active', 'archived')
    ),
    title TEXT NOT NULL,
    raw_text TEXT,
    scrubbed_text TEXT,
    labels JSONB NOT NULL DEFAULT '{}'::jsonb,
    provenance JSONB NOT NULL,
    redaction_summary JSONB,
    created_by TEXT NOT NULL,
    approved_by TEXT,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN ('draft', 'quarantined') OR scrubbed_text IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_vertical_training_assets_tenant_vertical_status
    ON vertical_training_assets (tenant_id, vertical_type, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vertical_training_assets_tenant_kind
    ON vertical_training_assets (tenant_id, asset_kind, updated_at DESC);
  ALTER TABLE vertical_training_assets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE vertical_training_assets FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_vertical_training_assets ON vertical_training_assets;
  CREATE POLICY tenant_isolation_vertical_training_assets ON vertical_training_assets
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

If `095_*` is already taken by the time this plan is executed, use the next available migration number and keep the body unchanged.

- [ ] **Step 6: Create Postgres repository**

Create `packages/api/src/verticals/pg-training-assets.ts`:

```typescript
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type { VerticalType } from '../shared/vertical-types';
import type {
  PrivacyAuditEntry,
  PrivacyAuditRepository,
  TrainingAssetRepository,
  VerticalTrainingAsset,
} from './training-assets';

function rowToAsset(row: Record<string, unknown>): VerticalTrainingAsset {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    verticalType: row.vertical_type as VerticalType,
    assetKind: row.asset_kind as VerticalTrainingAsset['assetKind'],
    status: row.status as VerticalTrainingAsset['status'],
    title: String(row.title),
    rawText: row.raw_text ? String(row.raw_text) : undefined,
    scrubbedText: row.scrubbed_text ? String(row.scrubbed_text) : undefined,
    labels: (row.labels ?? {}) as VerticalTrainingAsset['labels'],
    provenance: row.provenance as VerticalTrainingAsset['provenance'],
    redactionSummary: row.redaction_summary
      ? row.redaction_summary as VerticalTrainingAsset['redactionSummary']
      : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    activatedAt: row.activated_at ? new Date(String(row.activated_at)) : undefined,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export class PgTrainingAssetRepository extends PgBaseRepository implements TrainingAssetRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async save(asset: VerticalTrainingAsset): Promise<VerticalTrainingAsset> {
    return this.withTenant(asset.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO vertical_training_assets (
           id, tenant_id, vertical_type, asset_kind, status, title, raw_text,
           scrubbed_text, labels, provenance, redaction_summary, created_by,
           approved_by, activated_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )
         ON CONFLICT (id) DO UPDATE SET
           vertical_type = EXCLUDED.vertical_type,
           asset_kind = EXCLUDED.asset_kind,
           status = EXCLUDED.status,
           title = EXCLUDED.title,
           raw_text = EXCLUDED.raw_text,
           scrubbed_text = EXCLUDED.scrubbed_text,
           labels = EXCLUDED.labels,
           provenance = EXCLUDED.provenance,
           redaction_summary = EXCLUDED.redaction_summary,
           approved_by = EXCLUDED.approved_by,
           activated_at = COALESCE($14, vertical_training_assets.activated_at),
           updated_at = COALESCE($16, vertical_training_assets.updated_at)
         WHERE vertical_training_assets.tenant_id = $2
         RETURNING *`,
        [
          asset.id,
          asset.tenantId,
          asset.verticalType,
          asset.assetKind,
          asset.status,
          asset.title,
          asset.rawText ?? null,
          asset.scrubbedText ?? null,
          asset.labels,
          asset.provenance,
          asset.redactionSummary ?? null,
          asset.createdBy,
          asset.approvedBy ?? null,
          asset.activatedAt ?? null,
          asset.createdAt,
          asset.updatedAt,
        ],
      );
      return rowToAsset(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<VerticalTrainingAsset | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_training_assets WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, id],
      );
      return result.rows[0] ? rowToAsset(result.rows[0]) : null;
    });
  }

  async listByTenant(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_training_assets
         WHERE tenant_id = $1
         ORDER BY updated_at DESC`,
        [tenantId],
      );
      return result.rows.map(rowToAsset);
    });
  }

  async listActiveByTenantAndVertical(
    tenantId: string,
    verticalType: VerticalType,
  ): Promise<VerticalTrainingAsset[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_training_assets
         WHERE tenant_id = $1 AND vertical_type = $2 AND status = 'active'
         ORDER BY updated_at DESC`,
        [tenantId, verticalType],
      );
      return result.rows.map(rowToAsset);
    });
  }
}

export class PgPrivacyAuditRepository extends PgBaseRepository implements PrivacyAuditRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(entry: PrivacyAuditEntry): Promise<PrivacyAuditEntry> {
    return this.withTenant(entry.tenantId, async (client) => {
      await client.query(
        `INSERT INTO privacy_audit (
           id, tenant_id, actor_id, entity_type, entity_id, operation,
           redaction_summary, redactions, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.id,
          entry.tenantId,
          entry.actorId,
          entry.entityType,
          entry.entityId,
          entry.operation,
          entry.redactionSummary,
          entry.redactions,
          entry.createdAt,
        ],
      );
      return entry;
    });
  }
}
```

- [ ] **Step 7: Run repository tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-service.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/verticals/training-assets.ts packages/api/src/verticals/in-memory-training-assets.ts packages/api/src/verticals/pg-training-assets.ts packages/api/test/verticals/training-asset-service.test.ts
git commit -m "feat(voice): persist tenant vertical training assets"
```

---

## Task 5: Training asset service lifecycle

**Files:**

- Create: `packages/api/src/verticals/training-asset-service.ts`
- Modify: `packages/api/test/verticals/training-asset-service.test.ts`

- [ ] **Step 1: Add failing service lifecycle tests**

Append to `packages/api/test/verticals/training-asset-service.test.ts`:

```typescript
import {
  InMemoryPrivacyAuditRepository,
} from '../../src/verticals/in-memory-training-assets';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';
import { TrainingAssetService } from '../../src/verticals/training-asset-service';

describe('TrainingAssetService', () => {
  it('redacts before save and writes privacy audit without raw matched PII', async () => {
    const assetRepo = new InMemoryTrainingAssetRepository();
    const privacyAuditRepo = new InMemoryPrivacyAuditRepository();
    const service = new TrainingAssetService({
      assetRepo,
      privacyAuditRepo,
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-1',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'No heat emergency',
        rawText: 'Sarah Jones at 415-555-0123 has no heat.',
        labels: { intent: 'emergency_dispatch', shouldEscalate: true },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
      knownEntities: { names: ['Sarah Jones'] },
    });

    expect(saved.status).toBe('redacted');
    expect(saved.scrubbedText).toContain('[CALLER_NAME]');
    expect(saved.scrubbedText).toContain('[PHONE]');
    expect(privacyAuditRepo.rows).toHaveLength(1);
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('Sarah Jones');
    expect(JSON.stringify(privacyAuditRepo.rows[0])).not.toContain('415-555-0123');
  });

  it('quarantines assets with residual PII and prevents activation', async () => {
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-2',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'plumbing',
        assetKind: 'rag_seed',
        title: 'Account leak example',
        rawText: 'Account 123456789 has a leak.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    await expect(service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: saved.id,
    })).rejects.toThrow('Cannot approve quarantined training asset');
  });

  it('approves then activates a redacted asset', async () => {
    const service = new TrainingAssetService({
      assetRepo: new InMemoryTrainingAssetRepository(),
      privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
      redaction: new TrainingAssetRedactionService(),
      idGenerator: () => 'asset-3',
      now: () => new Date('2026-05-15T00:00:00Z'),
    });

    const saved = await service.create({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      input: {
        verticalType: 'electrical',
        assetKind: 'intake_question',
        title: 'Breaker follow-up',
        rawText: 'Ask whether one breaker is tripping or the whole panel is out.',
        labels: { expectedNextQuestion: 'Is one breaker tripping, or is the whole panel out?' },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      },
    });

    const approved = await service.approve({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: saved.id,
    });
    const active = await service.activate({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      assetId: approved.id,
    });

    expect(active.status).toBe('active');
    expect(active.approvedBy).toBe('owner-1');
    expect(active.activatedAt?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run failing service lifecycle tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-service.test.ts
```

Expected: FAIL because `TrainingAssetService` does not exist.

- [ ] **Step 3: Create service**

Create `packages/api/src/verticals/training-asset-service.ts`:

```typescript
import { randomUUID } from 'crypto';
import type { KnownEntities } from '../ai/training/scrub';
import type { TrainingAssetRedactionService } from './training-asset-redaction';
import {
  createTrainingAssetDraft,
  trainingAssetInputSchema,
  type PrivacyAuditRepository,
  type TrainingAssetInput,
  type TrainingAssetRepository,
  type VerticalTrainingAsset,
} from './training-assets';

export interface TrainingAssetServiceDeps {
  assetRepo: TrainingAssetRepository;
  privacyAuditRepo: PrivacyAuditRepository;
  redaction: TrainingAssetRedactionService;
  idGenerator?: () => string;
  now?: () => Date;
}

export interface CreateTrainingAssetRequest {
  tenantId: string;
  actorId: string;
  input: TrainingAssetInput;
  knownEntities?: KnownEntities;
}

export interface LifecycleRequest {
  tenantId: string;
  actorId: string;
  assetId: string;
}

export class TrainingAssetService {
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: TrainingAssetServiceDeps) {
    this.idGenerator = deps.idGenerator ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  async create(request: CreateTrainingAssetRequest): Promise<VerticalTrainingAsset> {
    const parsed = trainingAssetInputSchema.parse(request.input);
    const now = this.now();
    const draft = createTrainingAssetDraft({
      ...parsed,
      id: this.idGenerator(),
      tenantId: request.tenantId,
      createdBy: request.actorId,
      now,
    });
    const redacted = this.deps.redaction.redact({
      text: parsed.rawText,
      knownEntities: request.knownEntities,
    });
    const asset: VerticalTrainingAsset = {
      ...draft,
      status: redacted.status,
      scrubbedText: redacted.scrubbedText,
      redactionSummary: redacted.summary,
      updatedAt: now,
    };

    const saved = await this.deps.assetRepo.save(asset);
    await this.deps.privacyAuditRepo.create({
      id: this.idGenerator(),
      tenantId: request.tenantId,
      actorId: request.actorId,
      entityType: 'vertical_training_asset',
      entityId: saved.id,
      operation: 'redact_training_asset',
      redactionSummary: redacted.summary,
      redactions: redacted.auditRedactions,
      createdAt: now,
    });
    return saved;
  }

  async approve(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new Error('Training asset not found');
    if (existing.status === 'quarantined') {
      throw new Error('Cannot approve quarantined training asset');
    }
    if (existing.status !== 'redacted') {
      throw new Error(`Cannot approve training asset from status ${existing.status}`);
    }
    return this.deps.assetRepo.save({
      ...existing,
      status: 'approved',
      approvedBy: request.actorId,
      updatedAt: this.now(),
    });
  }

  async activate(request: LifecycleRequest): Promise<VerticalTrainingAsset> {
    const existing = await this.deps.assetRepo.findById(request.tenantId, request.assetId);
    if (!existing) throw new Error('Training asset not found');
    if (existing.status !== 'approved') {
      throw new Error(`Cannot activate training asset from status ${existing.status}`);
    }
    const now = this.now();
    return this.deps.assetRepo.save({
      ...existing,
      status: 'active',
      activatedAt: now,
      updatedAt: now,
    });
  }

  async list(tenantId: string): Promise<VerticalTrainingAsset[]> {
    return this.deps.assetRepo.listByTenant(tenantId);
  }
}
```

- [ ] **Step 4: Run service lifecycle tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/verticals/training-asset-service.ts packages/api/test/verticals/training-asset-service.test.ts
git commit -m "feat(voice): enforce training asset redaction lifecycle"
```

---

## Task 6: API routes for tenant-editable training assets

**Files:**

- Create: `packages/api/src/routes/vertical-training-assets.ts`
- Modify: `packages/api/src/app.ts`
- Create: `packages/api/test/routes/vertical-training-assets.route.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `packages/api/test/routes/vertical-training-assets.route.test.ts`:

```typescript
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { InMemoryPrivacyAuditRepository, InMemoryTrainingAssetRepository } from '../../src/verticals/in-memory-training-assets';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';
import { TrainingAssetService } from '../../src/verticals/training-asset-service';
import { createVerticalTrainingAssetsRouter } from '../../src/routes/vertical-training-assets';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      permissions: ['settings:manage'],
    };
    next();
  });
  const service = new TrainingAssetService({
    assetRepo: new InMemoryTrainingAssetRepository(),
    privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
    redaction: new TrainingAssetRedactionService(),
    idGenerator: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
    now: () => new Date('2026-05-15T00:00:00Z'),
  });
  app.use('/api/vertical-training-assets', createVerticalTrainingAssetsRouter(service));
  return app;
}

describe('vertical training assets routes', () => {
  it('creates a redacted training asset', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/vertical-training-assets')
      .send({
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'No heat call',
        rawText: 'Sarah Jones at 415-555-0123 has no heat.',
        labels: { intent: 'emergency_dispatch', shouldEscalate: true },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
        knownEntities: { names: ['Sarah Jones'] },
      })
      .expect(201);

    expect(res.body.status).toBe('redacted');
    expect(res.body.scrubbedText).toContain('[CALLER_NAME]');
    expect(res.body.rawText).toBeUndefined();
  });

  it('approves and activates an asset', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/vertical-training-assets')
      .send({
        verticalType: 'plumbing',
        assetKind: 'rag_seed',
        title: 'Shutoff guidance',
        rawText: 'Ask whether the water is shut off.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      })
      .expect(201);

    await request(app)
      .post(`/api/vertical-training-assets/${created.body.id}/approve`)
      .send({})
      .expect(200);
    const activated = await request(app)
      .post(`/api/vertical-training-assets/${created.body.id}/activate`)
      .send({})
      .expect(200);

    expect(activated.body.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run failing route tests**

Run:

```bash
cd packages/api && npm test -- test/routes/vertical-training-assets.route.test.ts
```

Expected: FAIL because route file does not exist.

- [ ] **Step 3: Create route**

Create `packages/api/src/routes/vertical-training-assets.ts`:

```typescript
import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import type { KnownEntities } from '../ai/training/scrub';
import { trainingAssetInputSchema } from '../verticals/training-assets';
import type { TrainingAssetService } from '../verticals/training-asset-service';

function serializeAsset(asset: Awaited<ReturnType<TrainingAssetService['list']>>[number]) {
  const { rawText: _rawText, ...safe } = asset;
  return safe;
}

export function createVerticalTrainingAssetsRouter(service: TrainingAssetService): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const assets = await service.list(req.auth!.tenantId);
        res.json({ data: assets.map(serializeAsset) });
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        res.status(status).json(body);
      }
    },
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { knownEntities, ...assetInput } = req.body as { knownEntities?: KnownEntities };
        const parsed = trainingAssetInputSchema.parse(assetInput);
        const asset = await service.create({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          input: parsed,
          knownEntities,
        });
        res.status(201).json(serializeAsset(asset));
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        res.status(status).json(body);
      }
    },
  );

  router.post(
    '/:id/approve',
    requireAuth,
    requireTenant,
    requirePermission('settings:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const asset = await service.approve({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          assetId: req.params.id,
        });
        res.json(serializeAsset(asset));
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        res.status(status).json(body);
      }
    },
  );

  router.post(
    '/:id/activate',
    requireAuth,
    requireTenant,
    requirePermission('settings:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const asset = await service.activate({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          assetId: req.params.id,
        });
        res.json(serializeAsset(asset));
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        res.status(status).json(body);
      }
    },
  );

  return router;
}
```

- [ ] **Step 4: Mount route in app**

In `packages/api/src/app.ts`, import:

```typescript
import { createVerticalTrainingAssetsRouter } from './routes/vertical-training-assets';
import { InMemoryPrivacyAuditRepository, InMemoryTrainingAssetRepository } from './verticals/in-memory-training-assets';
import { PgPrivacyAuditRepository, PgTrainingAssetRepository } from './verticals/pg-training-assets';
import { TrainingAssetRedactionService } from './verticals/training-asset-redaction';
import { TrainingAssetService } from './verticals/training-asset-service';
```

Near existing vertical/settings repository construction, add:

```typescript
const trainingAssetRepo = pool
  ? new PgTrainingAssetRepository(pool)
  : new InMemoryTrainingAssetRepository();
const privacyAuditRepo = pool
  ? new PgPrivacyAuditRepository(pool)
  : new InMemoryPrivacyAuditRepository();
const trainingAssetService = new TrainingAssetService({
  assetRepo: trainingAssetRepo,
  privacyAuditRepo,
  redaction: new TrainingAssetRedactionService(),
});
```

Near the existing `/api/verticals` and settings mounts, add:

```typescript
app.use('/api/vertical-training-assets', createVerticalTrainingAssetsRouter(trainingAssetService));
```

- [ ] **Step 5: Run route tests**

Run:

```bash
cd packages/api && npm test -- test/routes/vertical-training-assets.route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/vertical-training-assets.ts packages/api/src/app.ts packages/api/test/routes/vertical-training-assets.route.test.ts
git commit -m "feat(voice): expose vertical training asset lifecycle API"
```

---

## Task 7: Feed active tenant assets into voice prompt context

**Files:**

- Modify: `packages/api/src/verticals/resolve-active-pack.ts`
- Modify: `packages/api/src/verticals/context-assembly.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/test/verticals/training-assets.test.ts`

- [ ] **Step 1: Add failing prompt merge test**

Append to `packages/api/test/verticals/training-assets.test.ts`:

```typescript
import { buildMergedVerticalVoicePrompt } from '../../src/verticals/context-assembly';

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
```

- [ ] **Step 2: Run failing prompt merge test**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: FAIL because `buildMergedVerticalVoicePrompt` does not exist.

- [ ] **Step 3: Add prompt merge helper**

Append to `packages/api/src/verticals/context-assembly.ts`:

```typescript
export function buildMergedVerticalVoicePrompt(input: {
  canonicalPrompt?: string;
  trainingAssetPrompt?: string;
}): string | undefined {
  const sections = [input.canonicalPrompt, input.trainingAssetPrompt]
    .filter((section): section is string => Boolean(section && section.trim().length > 0));
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
```

- [ ] **Step 4: Extend active pack resolver dependencies**

In `packages/api/src/verticals/resolve-active-pack.ts`, add imports:

```typescript
import type { TrainingAssetRepository } from './training-assets';
import { buildTrainingAssetPromptSection } from './training-assets';
import { buildMergedVerticalVoicePrompt } from './context-assembly';
```

Extend `ResolveActivePackDeps`:

```typescript
trainingAssetRepo?: TrainingAssetRepository;
```

Inside the resolver after `richPack` is built, load active tenant assets:

```typescript
const trainingAssets = deps.trainingAssetRepo
  ? await deps.trainingAssetRepo.listActiveByTenantAndVertical(tenantId, richPack.type)
  : [];
const trainingAssetPrompt = buildTrainingAssetPromptSection(trainingAssets);
```

Replace:

```typescript
const formatted = [verticalBlock, intakeBlock, objectionBlock]
  .filter((s) => s.length > 0)
  .join('\n\n');
section = formatted.length > 0 ? formatted : undefined;
```

with:

```typescript
const canonicalPrompt = [verticalBlock, intakeBlock, objectionBlock]
  .filter((s) => s.length > 0)
  .join('\n\n');
section = buildMergedVerticalVoicePrompt({
  canonicalPrompt,
  trainingAssetPrompt,
});
```

- [ ] **Step 5: Wire repository in app resolver**

In `packages/api/src/app.ts`, update:

```typescript
const verticalPromptResolver = buildVerticalPromptResolver({
  packActivationRepo,
  canonicalPackRegistry,
});
```

to:

```typescript
const verticalPromptResolver = buildVerticalPromptResolver({
  packActivationRepo,
  canonicalPackRegistry,
  trainingAssetRepo,
});
```

- [ ] **Step 6: Run prompt tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/verticals/context-assembly.ts packages/api/src/verticals/resolve-active-pack.ts packages/api/src/app.ts packages/api/test/verticals/training-assets.test.ts
git commit -m "feat(voice): include active training assets in vertical prompts"
```

---

## Task 8: RAG seeding from active training assets

**Files:**

- Modify: `packages/api/src/ai/training/knowledge-chunks.ts`
- Create: `packages/api/src/verticals/training-asset-rag.ts`
- Create: `packages/api/test/verticals/training-asset-rag.test.ts`

- [ ] **Step 1: Write failing RAG seeding tests**

Create `packages/api/test/verticals/training-asset-rag.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildTrainingAssetKnowledgeChunkInput } from '../../src/verticals/training-asset-rag';
import type { VerticalTrainingAsset } from '../../src/verticals/training-assets';

function activeAsset(): VerticalTrainingAsset {
  const now = new Date('2026-05-15T00:00:00Z');
  return {
    id: 'asset-1',
    tenantId: 'tenant-1',
    verticalType: 'hvac',
    assetKind: 'rag_seed',
    status: 'active',
    title: 'No heat dispatch',
    rawText: 'Sarah has no heat.',
    scrubbedText: '[CALLER_NAME] has no heat.',
    labels: { intent: 'emergency_dispatch', shouldEscalate: true },
    provenance: { source: 'tenant_admin', sourceVersion: '3' },
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('buildTrainingAssetKnowledgeChunkInput', () => {
  it('builds tenant-scoped chunks from scrubbed text only', () => {
    const chunk = buildTrainingAssetKnowledgeChunkInput({
      asset: activeAsset(),
      embedding: Array.from({ length: 1536 }, () => 0.001),
    });

    expect(chunk.tenantId).toBe('tenant-1');
    expect(chunk.scope).toBe('tenant');
    expect(chunk.sourceType).toBe('vertical_training_asset');
    expect(chunk.content).toBe('[CALLER_NAME] has no heat.');
    expect(chunk.contentScrubbed).toBe('[CALLER_NAME] has no heat.');
    expect(chunk.metadata.verticalType).toBe('hvac');
    expect(JSON.stringify(chunk)).not.toContain('Sarah');
  });

  it('refuses inactive assets', () => {
    expect(() =>
      buildTrainingAssetKnowledgeChunkInput({
        asset: { ...activeAsset(), status: 'approved' },
        embedding: Array.from({ length: 1536 }, () => 0.001),
      }),
    ).toThrow('Only active training assets can be embedded');
  });
});
```

- [ ] **Step 2: Run failing RAG tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-rag.test.ts
```

Expected: FAIL because `training-asset-rag.ts` does not exist and source type is missing.

- [ ] **Step 3: Add knowledge source type**

In `packages/api/src/ai/training/knowledge-chunks.ts`, add these source types to `KnowledgeChunkSourceType`:

```typescript
| 'vertical_training_asset'
| 'vertical_eval_scenario'
| 'vertical_labeled_call_example'
```

- [ ] **Step 4: Create RAG builder**

Create `packages/api/src/verticals/training-asset-rag.ts`:

```typescript
import type { KnowledgeChunkInput } from '../ai/training/knowledge-chunks';
import { EMBEDDING_MODEL } from '../ai/training/knowledge-chunks';
import type { VerticalTrainingAsset } from './training-assets';

export function buildTrainingAssetKnowledgeChunkInput(input: {
  asset: VerticalTrainingAsset;
  embedding: number[];
}): KnowledgeChunkInput {
  if (input.asset.status !== 'active') {
    throw new Error('Only active training assets can be embedded');
  }
  if (!input.asset.scrubbedText) {
    throw new Error('Active training asset must have scrubbedText');
  }
  return {
    tenantId: input.asset.tenantId,
    scope: 'tenant',
    sourceType: 'vertical_training_asset',
    sourceId: input.asset.id,
    sourceVersion: Number.parseInt(input.asset.provenance.sourceVersion, 10) || 1,
    content: input.asset.scrubbedText,
    contentScrubbed: input.asset.scrubbedText,
    embedding: input.embedding,
    embeddingModel: EMBEDDING_MODEL,
    chunkSchemaVersion: 1,
    metadata: {
      verticalType: input.asset.verticalType,
      assetKind: input.asset.assetKind,
      labels: input.asset.labels,
      provenance: input.asset.provenance,
    },
  };
}
```

- [ ] **Step 5: Run RAG tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-rag.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/ai/training/knowledge-chunks.ts packages/api/src/verticals/training-asset-rag.ts packages/api/test/verticals/training-asset-rag.test.ts
git commit -m "feat(voice): prepare active training assets for RAG"
```

---

## Task 9: Seed canonical defaults for HVAC, plumbing, and second-class electrical

**Files:**

- Modify: `packages/api/src/verticals/packs/hvac.ts`
- Modify: `packages/api/src/verticals/packs/plumbing.ts`
- Create: `packages/api/src/verticals/packs/electrical.ts`
- Modify: the local pack registry/barrel file that seeds canonical vertical packs
- Modify: `packages/api/test/verticals/training-assets.test.ts`

- [ ] **Step 1: Add failing default-pack test**

Append to `packages/api/test/verticals/training-assets.test.ts`:

```typescript
import { createElectricalPack } from '../../src/verticals/packs/electrical';

describe('default vertical training metadata', () => {
  it('seeds electrical as a second-class pack with minimal voice context', () => {
    const pack = createElectricalPack();

    expect(pack.verticalType).toBe('electrical');
    expect(pack.metadata.training_tier).toBe('second_class');
    expect(pack.metadata.intake_questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: 'Is power out in the whole home or only one circuit?',
        }),
      ]),
    );
    expect(pack.metadata.training_assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetKind: 'emergency_rule',
          title: 'Electrical burning smell escalation',
        }),
      ]),
    );
  });
});
```

- [ ] **Step 2: Run failing default-pack test**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: FAIL because electrical pack does not exist.

- [ ] **Step 3: Create electrical pack**

Create `packages/api/src/verticals/packs/electrical.ts`:

```typescript
import {
  createVerticalPack,
  type IntakeQuestion,
  type ObjectionScript,
  type ServiceCategory,
  type TerminologyMap,
  type VerticalPack,
} from '../registry';

const ELECTRICAL_CATEGORIES: ServiceCategory[] = [
  { id: 'electrical-diagnostic', name: 'Diagnostic', sortOrder: 1 },
  { id: 'electrical-repair', name: 'Repair', sortOrder: 2 },
  { id: 'electrical-install', name: 'Installation', sortOrder: 3 },
  { id: 'electrical-panel', name: 'Panel and Breaker Work', sortOrder: 4 },
  { id: 'electrical-lighting', name: 'Lighting', sortOrder: 5 },
  { id: 'electrical-safety', name: 'Safety Inspection', sortOrder: 6 },
  { id: 'electrical-emergency', name: 'Emergency Service', sortOrder: 7 },
];

const ELECTRICAL_TERMINOLOGY: TerminologyMap = {
  breaker: {
    displayName: 'Breaker',
    aliases: ['circuit breaker', 'tripping breaker', 'breaker switch'],
  },
  panel: {
    displayName: 'Electrical Panel',
    aliases: ['panel box', 'breaker box', 'service panel', 'main panel'],
  },
  gfci: {
    displayName: 'GFCI Outlet',
    aliases: ['gfci', 'gfi', 'reset outlet', 'bathroom outlet'],
  },
  outlet: {
    displayName: 'Outlet',
    aliases: ['receptacle', 'plug', 'wall outlet'],
  },
  flickering_lights: {
    displayName: 'Flickering Lights',
    aliases: ['lights flicker', 'lights dim', 'lights blinking'],
  },
  burning_smell: {
    displayName: 'Burning Smell',
    aliases: ['burning odor', 'smells hot', 'smoke smell', 'sparks'],
  },
};

const ELECTRICAL_INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    trigger: 'electrical',
    question: 'Is power out in the whole home or only one circuit?',
    intent: 'service_disambiguation',
  },
  {
    trigger: 'safety',
    question: 'Do you smell burning, see sparks, or feel heat near the panel or outlet?',
    intent: 'urgency_triage',
  },
];

const ELECTRICAL_OBJECTION_SCRIPTS: readonly ObjectionScript[] = [
  {
    id: 'phone_quote',
    patterns: ['can you quote it over the phone', 'how much to fix an outlet'],
    reframe:
      'Electrical issues can be unsafe without testing the circuit, so we need a technician to inspect before giving a firm repair price.',
  },
];

const ELECTRICAL_TRAINING_ASSETS = [
  {
    assetKind: 'emergency_rule',
    title: 'Electrical burning smell escalation',
    scrubbedText:
      'If the caller reports burning smell, sparks, smoke, hot panel, or repeated breaker trips, treat as urgent and escalate to a human dispatcher.',
    labels: {
      intent: 'emergency_dispatch',
      urgencyTier: 'emergency',
      expectedNextAction: 'escalate_to_oncall',
      shouldEscalate: true,
    },
    provenance: {
      source: 'synthetic_default',
      sourceVersion: '2026-05-15',
    },
  },
  {
    assetKind: 'intake_question',
    title: 'Electrical outage disambiguation',
    scrubbedText:
      'Ask whether the outage affects the whole home, one room, or a single outlet before proposing a diagnostic visit.',
    labels: {
      expectedNextQuestion: 'Is power out in the whole home, one room, or only one outlet?',
    },
    provenance: {
      source: 'synthetic_default',
      sourceVersion: '2026-05-15',
    },
  },
];

export function createElectricalPack(): VerticalPack {
  const pack = createVerticalPack(
    'electrical',
    'Electrical Basic',
    '1.0.0',
    'Second-class electrical service pack for basic residential triage',
    ELECTRICAL_CATEGORIES,
    ELECTRICAL_TERMINOLOGY,
    ELECTRICAL_INTAKE_QUESTIONS,
    ELECTRICAL_OBJECTION_SCRIPTS,
  );
  pack.metadata = {
    ...pack.metadata,
    training_tier: 'second_class',
    training_assets: ELECTRICAL_TRAINING_ASSETS,
  };
  return pack;
}
```

- [ ] **Step 4: Add synthetic training metadata to HVAC and plumbing**

In `packages/api/src/verticals/packs/hvac.ts`, add a `HVAC_TRAINING_ASSETS` constant before `createHvacPack`:

```typescript
const HVAC_TRAINING_ASSETS = [
  {
    assetKind: 'emergency_rule',
    title: 'No heat extreme weather escalation',
    scrubbedText:
      'If the caller reports no heat in freezing weather, classify as emergency_dispatch and escalate without normal intent confirmation.',
    labels: {
      intent: 'emergency_dispatch',
      urgencyTier: 'emergency',
      expectedNextAction: 'escalate_to_oncall',
      shouldEscalate: true,
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
  {
    assetKind: 'eval_scenario',
    title: 'Heating versus cooling disambiguation',
    scrubbedText:
      'Caller says the system is not keeping up. Expected next question: Is this for heating or cooling?',
    labels: {
      intent: 'create_appointment',
      urgencyTier: 'normal',
      expectedNextQuestion: 'Is this for heating or cooling?',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
];
```

Then in `createHvacPack`, after the pack is created, set:

```typescript
pack.metadata = {
  ...pack.metadata,
  training_tier: 'first_class',
  training_assets: HVAC_TRAINING_ASSETS,
};
return pack;
```

Use the same pattern in `packages/api/src/verticals/packs/plumbing.ts`:

```typescript
const PLUMBING_TRAINING_ASSETS = [
  {
    assetKind: 'emergency_rule',
    title: 'Burst pipe escalation',
    scrubbedText:
      'If the caller reports flooding, burst pipe, sewage backup, or no water, classify as emergency_dispatch and escalate to the on-call dispatcher.',
    labels: {
      intent: 'emergency_dispatch',
      urgencyTier: 'emergency',
      expectedNextAction: 'escalate_to_oncall',
      shouldEscalate: true,
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
  {
    assetKind: 'eval_scenario',
    title: 'Leak versus clog disambiguation',
    scrubbedText:
      'Caller says there is a plumbing problem. Expected next question: Is this a leak, a clog, no water, or a fixture issue?',
    labels: {
      intent: 'create_appointment',
      urgencyTier: 'normal',
      expectedNextQuestion: 'Is this a leak, a clog, no water, or a fixture issue?',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
];
```

- [ ] **Step 5: Register electrical canonical pack**

In `packages/api/src/shared/canonical-vertical-packs.ts`, add this import beside the HVAC and plumbing imports:

```typescript
import { createElectricalPack } from '../verticals/packs/electrical';
```

Update `adaptToCanonical` so its rich-pack type accepts electrical too:

```typescript
type RichVerticalPack =
  | ReturnType<typeof createHvacPack>
  | ReturnType<typeof createPlumbingPack>
  | ReturnType<typeof createElectricalPack>;

function adaptToCanonical(packId: string, rich: RichVerticalPack): VerticalPack {
  const now = new Date();
  return {
    id: uuidv4(),
    packId,
    version: rich.version,
    verticalType: rich.verticalType,
    status: 'active',
    displayName: rich.displayName,
    description: rich.description,
    metadata: {
      ...(rich.metadata ?? {}),
      canonical: true,
      seededBy: 'createApp',
    },
    createdAt: now,
    updatedAt: now,
  };
}
```

Update `seedCanonicalVerticalPacks` to register electrical last:

```typescript
export async function seedCanonicalVerticalPacks(registry: VerticalPackRegistry): Promise<void> {
  await Promise.all([
    registry.register(adaptToCanonical('hvac-v1', createHvacPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register hvac-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
    registry.register(adaptToCanonical('plumbing-v1', createPlumbingPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register plumbing-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
    registry.register(adaptToCanonical('electrical-v1', createElectricalPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register electrical-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
  ]);
}
```

- [ ] **Step 6: Run default-pack tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run production typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/verticals/packs/hvac.ts packages/api/src/verticals/packs/plumbing.ts packages/api/src/verticals/packs/electrical.ts packages/api/src/shared/canonical-vertical-packs.ts packages/api/test/verticals/training-assets.test.ts
git commit -m "feat(voice): seed vertical voice training defaults"
```

---

## Task 10: Final verification

**Files:**

- No new files.

- [ ] **Step 1: Run focused vertical tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-assets.test.ts test/verticals/training-asset-redaction.test.ts test/verticals/training-asset-service.test.ts test/verticals/training-asset-rag.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run route tests**

Run:

```bash
cd packages/api && npm test -- test/routes/vertical-training-assets.route.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run production API typecheck**

Run:

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: PASS.

- [ ] **Step 4: Run log-safety lint**

Run:

```bash
cd packages/api && npm run lint:log-safety
```

Expected: PASS. This matters because training assets touch PII-sensitive text.

- [ ] **Step 5: Inspect for raw PII in privacy audit tests**

Run:

```bash
cd packages/api && npm test -- test/verticals/training-asset-redaction.test.ts test/verticals/training-asset-service.test.ts
```

Expected: PASS and assertions confirm audit rows do not include raw names or phone numbers.

- [ ] **Step 6: Commit final fixes if needed**

If any verification command required fixes:

```bash
git add packages/api
git commit -m "fix(voice): stabilize vertical training asset verification"
```

If no files changed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - Database-backed tenant-editable assets: Tasks 4, 5, 6.
  - PII stripping before save: Tasks 3, 5.
  - Quarantine on residual PII: Tasks 3, 5.
  - Privacy audit without raw matched values: Tasks 3, 4, 5.
  - HVAC/plumbing first-class context: Task 9.
  - Electrical second-class context: Tasks 1, 9.
  - RAG/evals/labeled call examples: Tasks 2, 8, 9.
  - Voice prompt integration: Task 7.
- Placeholder scan: no placeholder markers, vague implementation steps, or unspecified “add tests” steps.
- Type consistency:
  - `VerticalTrainingAsset`, `TrainingAssetRepository`, and `PrivacyAuditRepository` are defined in Task 4 before service/routes use them.
  - `TrainingAssetRedactionService.redact()` returns `redacted | quarantined`, matching lifecycle tests.
  - `vertical_training_asset` source type is added before RAG builder uses it.
  - `electrical` is added to shared types before pack creation.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-vertical-voice-training-assets.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
