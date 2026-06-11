import { v4 as uuidv4 } from 'uuid';

export interface PromptVersion {
  id: string;
  taskType: string;
  version: number;
  template: string;
  model: string;
  isActive: boolean;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
}

export interface CreatePromptVersionInput {
  taskType: string;
  template: string;
  model: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface PromptVersionRepository {
  create(version: PromptVersion): Promise<PromptVersion>;
  findById(id: string): Promise<PromptVersion | null>;
  findActive(taskType: string): Promise<PromptVersion | null>;
  findByTaskType(taskType: string): Promise<PromptVersion[]>;
  activate(id: string): Promise<PromptVersion | null>;
  deactivateAll(taskType: string): Promise<void>;
  getNextVersion(taskType: string): Promise<number>;
}

export function validatePromptVersionInput(input: CreatePromptVersionInput): string[] {
  const errors: string[] = [];
  if (!input.taskType) errors.push('taskType is required');
  if (!input.template) errors.push('template is required');
  if (!input.model) errors.push('model is required');
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

export class InMemoryPromptVersionRepository implements PromptVersionRepository {
  private versions: Map<string, PromptVersion> = new Map();

  async create(version: PromptVersion): Promise<PromptVersion> {
    this.versions.set(version.id, { ...version });
    return version;
  }

  async findById(id: string): Promise<PromptVersion | null> {
    return this.versions.get(id) || null;
  }

  async findActive(taskType: string): Promise<PromptVersion | null> {
    for (const v of this.versions.values()) {
      if (v.taskType === taskType && v.isActive) return { ...v };
    }
    return null;
  }

  async findByTaskType(taskType: string): Promise<PromptVersion[]> {
    return Array.from(this.versions.values())
      .filter((v) => v.taskType === taskType)
      .sort((a, b) => b.version - a.version);
  }

  async activate(id: string): Promise<PromptVersion | null> {
    const version = this.versions.get(id);
    if (!version) return null;

    // Deactivate all for same taskType
    await this.deactivateAll(version.taskType);

    version.isActive = true;
    this.versions.set(id, version);
    return { ...version };
  }

  async deactivateAll(taskType: string): Promise<void> {
    for (const v of this.versions.values()) {
      if (v.taskType === taskType) v.isActive = false;
    }
  }

  async getNextVersion(taskType: string): Promise<number> {
    const versions = await this.findByTaskType(taskType);
    if (versions.length === 0) return 1;
    return Math.max(...versions.map((v) => v.version)) + 1;
  }
}

export async function registerPromptVersion(
  input: CreatePromptVersionInput,
  repository: PromptVersionRepository
): Promise<PromptVersion> {
  const nextVersion = await repository.getNextVersion(input.taskType);

  const version: PromptVersion = {
    id: uuidv4(),
    taskType: input.taskType,
    version: nextVersion,
    template: input.template,
    model: input.model,
    isActive: false,
    metadata: input.metadata,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };

  await repository.create(version);
  return version;
}

export async function activatePromptVersion(
  id: string,
  repository: PromptVersionRepository
): Promise<PromptVersion | null> {
  return repository.activate(id);
}

// ---------------------------------------------------------------------------
// P4-015 — Brand-voice prompt-version registration.
//
// A single `brand_voice_v1` prompt-version backs all customer-facing text
// drafted by the Wave-C stories (P6-028, P7-026, P8-015). Registering one
// version (rather than per-story prompts) is what keeps the voice consistent
// across SMS and review channels. The supported intents are enumerated here
// so they are discoverable from the registry without instantiating the
// composer.
// ---------------------------------------------------------------------------

/** taskType routed through the gateway for all brand-voice generations. */
export const BRAND_VOICE_TASK_TYPE = 'brand_voice_v1';

/** Stable identifier threaded back to callers + ai_runs.metadata.promptVersionId. */
export const BRAND_VOICE_PROMPT_VERSION_ID = 'brand_voice_v1';

/**
 * The four customer-facing intents brand-voice ships with in V1. Adding an
 * intent is a single entry here (and one guidance block in brand-voice/prompts.ts).
 */
export const BRAND_VOICE_INTENTS = [
  'tech_reschedule_customer_sms',
  'review_public_response',
  'review_private_followup',
  'dropped_call_recovery_sms',
] as const;

export type BrandVoiceRegisteredIntent = (typeof BRAND_VOICE_INTENTS)[number];

/**
 * Whether an intent is registered against `brand_voice_v1`. The composer and
 * any handler can ask the registry directly rather than hard-coding the list.
 */
export function isRegisteredBrandVoiceIntent(intent: string): boolean {
  return (BRAND_VOICE_INTENTS as readonly string[]).includes(intent);
}

/** Enumerate the registered (`brand_voice_v1`, intent) pairs. */
export function listBrandVoicePromptIntents(): ReadonlyArray<{
  taskType: string;
  promptVersionId: string;
  intent: BrandVoiceRegisteredIntent;
}> {
  return BRAND_VOICE_INTENTS.map((intent) => ({
    taskType: BRAND_VOICE_TASK_TYPE,
    promptVersionId: BRAND_VOICE_PROMPT_VERSION_ID,
    intent,
  }));
}

/**
 * Seed the `brand_voice_v1` prompt-version into a repository and activate it.
 * Idempotent on taskType: if an active version already exists it is returned
 * unchanged. The template is intentionally a thin reference — the live prompt
 * is assembled per-call by `brand-voice/prompts.ts` from the tenant tone +
 * intent + caller context.
 */
export async function ensureBrandVoicePromptRegistered(
  repository: PromptVersionRepository,
  options?: { model?: string; createdBy?: string }
): Promise<PromptVersion> {
  const existing = await repository.findActive(BRAND_VOICE_TASK_TYPE);
  if (existing) return existing;

  const version = await registerPromptVersion(
    {
      taskType: BRAND_VOICE_TASK_TYPE,
      template:
        'Brand-voice composer (brand_voice_v1). Tenant tone is the ' +
        'non-overridable authority; per-call context only fills referenced ' +
        'slots. Prompt assembled by ai/brand-voice/prompts.ts.',
      model: options?.model ?? 'gpt-4o-mini',
      createdBy: options?.createdBy ?? 'system',
      metadata: {
        promptVersionId: BRAND_VOICE_PROMPT_VERSION_ID,
        intents: [...BRAND_VOICE_INTENTS],
        story: 'P4-015',
      },
    },
    repository
  );
  const activated = await repository.activate(version.id);
  return activated ?? version;
}
