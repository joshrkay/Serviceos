export type ModelTier = 'lightweight' | 'standard' | 'complex';

export interface TierConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * VOX-34: per-tier default end-to-end deadline in ms. Applied by
   * `gateway.complete()` to `request.deadlineMs` when the caller didn't set
   * one, so latency-critical (lightweight / voice-hot-path) tasks get a budget
   * consistent with the turn SLO (p95 < 1.5s) instead of the universal 8s
   * fallback, while heavier tiers keep a larger budget. An explicit
   * `request.deadlineMs` always wins. Read it via `resolveTierDeadlineMs`.
   */
  deadlineMs?: number;
}

export interface AIRoutingConfig {
  tiers: Record<ModelTier, TierConfig>;
  taskTierMapping: Record<string, ModelTier>;
}

// Model identifiers are read from environment variables so they can be
// updated without a code deploy. Defaults target OpenRouter-hosted open
// models (Option A — managed inference). Pair with:
//   AI_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
//   AI_PROVIDER_API_KEY=sk-or-...
// See docs/runbooks/openrouter-ai-provider.md.
//
// Complex default is the open VL model so mms_estimate (image) and text
// drafting (draft_estimate / draft_invoice) share one complex tier without
// a vision mismatch. Override with qwen/qwen-2.5-72b-instruct for cheaper
// text-only drafting if MMS is unused.
const lightweightModel =
  process.env.AI_LIGHTWEIGHT_MODEL || 'meta-llama/llama-3.1-8b-instruct';
const standardModel =
  process.env.AI_STANDARD_MODEL || 'meta-llama/llama-3.3-70b-instruct';
const complexModel =
  process.env.AI_COMPLEX_MODEL || 'qwen/qwen2.5-vl-72b-instruct';

/** Parse a positive-integer env var (ms), falling back on unset/invalid input. */
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * True when an env var is present in `process.env` but blank/whitespace.
 * Railway "cleared" vars sometimes remain as `""`, which used to silently
 * collapse classify deadline to the 4s default (ops regression).
 */
export function isEnvPresentButBlank(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.prototype.hasOwnProperty.call(env, name) && String(env[name] ?? '').trim() === '';
}

// VOX-34: per-tier default deadlines (ms), env-overridable without a deploy.
// Lightweight is the voice hot path (classify_intent etc.) — kept close to the
// turn SLO. Standard/complex get progressively larger budgets. The retry layer
// still enforces MIN_RETRY_BUDGET_MS, so a tight budget never forces zero
// retries where a quick one would fit.
const lightweightDeadlineMs = parsePositiveIntEnv(process.env.AI_LIGHTWEIGHT_DEADLINE_MS, 1_500);
const standardDeadlineMs = parsePositiveIntEnv(process.env.AI_STANDARD_DEADLINE_MS, 4_000);
const complexDeadlineMs = parsePositiveIntEnv(process.env.AI_COMPLEX_DEADLINE_MS, 8_000);

/**
 * Classifier prompts carry the full intent taxonomy and can exceed the
 * lightweight tier's turn-SLO deadline. Keep the lightweight model/cost tier,
 * but give classification a separate end-to-end budget. Operators can tune it
 * without changing other low-latency tasks.
 */
export function resolveClassifyIntentDeadlineMs(): number {
  const raw = process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
  // Present-but-empty must not silently look "configured". Warn loudly and
  // fall through to the documented default (check-ai-provider-config fails
  // hard for the same case on prod checklists).
  if (isEnvPresentButBlank('AI_CLASSIFY_INTENT_DEADLINE_MS')) {
    process.stderr.write(
      '[WARN] AI_CLASSIFY_INTENT_DEADLINE_MS is set but empty; using default 4000ms. ' +
        'Set a positive integer (production: 12000) or unset the variable.\n',
    );
    return 4_000;
  }
  return parsePositiveIntEnv(raw, 4_000);
}

/**
 * Canonical set of gateway taskTypes — every value passed to
 * `gateway.complete({ taskType })`. This array is the single source of truth:
 * `TaskType` is derived from it, and `DEFAULT_TASK_TIER_MAPPING` is keyed by it
 * (a `Record<TaskType, ModelTier>`), so the compiler refuses to build unless
 * every taskType has an explicit tier — preventing the historical drift where
 * the mapping used idealized names (`intent_classification`,
 * `transcript_normalization`, …) that matched no real call site, silently
 * sending everything to `standard`.
 *
 * NOTE: dynamically-constructed taskTypes (the `assistant.*` namespace built in
 * routes/assistant.ts as `assistant.${handler.taskType}`) are intentionally NOT
 * listed — they resolve to `standard` via the `|| 'standard'` default in
 * router.ts, which is the desired behavior for those user-facing queries.
 */
export const TASK_TYPES = [
  // ── Lightweight: cheap model; deterministic classification, lite extraction,
  //    graders, and transcript correction. Most of these were designed for the
  //    cheap model in the (removed) DEFAULT_GATEWAY_CONFIG but had been silently
  //    resolving to `standard` because the call-site taskType never matched a key.
  'classify_intent',
  'decompose_transcript',
  'summarize_conversation',
  'generate_clarification_questions',
  'transcription_correction',
  'extract_team',
  'extract_schedule',
  'supervisor_annotate',
  // N-004 (P2-037) — Supervisor Agent review pass. Pinned to the lightweight
  // tier so the reviewer is a DIFFERENT, cheaper model than the complex-tier
  // drafting tasks it reviews (see assertSupervisorReviewModelDistinct).
  'supervisor_review',
  'intent_classification',
  'call_sentiment',
  'grade_vulnerability',
  'voice_quality_judge',
  'voice_quality_perceived_completion',
  'voice_quality_reprompt_judge',
  'review_classify',
  'proposal_sms_edit',
  // ── Standard: moderate generation / customer-facing writing where output
  //    quality matters more than latency or cost.
  'create_appointment',
  'create_standing_instruction',
  'suggest_reply',
  'brand_voice_v1',
  'review_private_followup',
  'review_public_response',
  'extract_business_profile',
  'extract_categories',
  'extract_pricing',
  // ── Complex: high-stakes structured generation — financial documents,
  //    multi-line estimates/invoices, and MMS-to-quote (vision-capable tier).
  'draft_estimate',
  'update_estimate',
  'mms_estimate',
  'draft_invoice',
  'update_invoice',
  // B7 — update_job (status/priority/title/description edit to an
  // existing job). Mirrors its update_estimate/update_invoice siblings
  // (same *-edit-task.ts structure, same jobId-gate pattern) rather than
  // the lighter deterministic handlers (create_job/update_customer),
  // which aren't in this taxonomy at all.
  'update_job',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

const DEFAULT_TASK_TIER_MAPPING: Record<TaskType, ModelTier> = {
  // Lightweight
  classify_intent: 'lightweight',
  decompose_transcript: 'lightweight',
  summarize_conversation: 'lightweight',
  generate_clarification_questions: 'lightweight',
  transcription_correction: 'lightweight',
  extract_team: 'lightweight',
  extract_schedule: 'lightweight',
  supervisor_annotate: 'lightweight',
  supervisor_review: 'lightweight',
  intent_classification: 'lightweight',
  call_sentiment: 'lightweight',
  grade_vulnerability: 'lightweight',
  voice_quality_judge: 'lightweight',
  voice_quality_perceived_completion: 'lightweight',
  voice_quality_reprompt_judge: 'lightweight',
  review_classify: 'lightweight',
  proposal_sms_edit: 'lightweight',
  // Standard
  create_appointment: 'standard',
  // Normalizes a spoken directive into a concise imperative + structured
  // scope (intents/trade categories/customer segment) — judgment-call
  // extraction like extract_business_profile/extract_categories/
  // extract_pricing below, not a deterministic lite-extraction task.
  create_standing_instruction: 'standard',
  suggest_reply: 'standard',
  brand_voice_v1: 'standard',
  review_private_followup: 'standard',
  review_public_response: 'standard',
  // Onboarding profile/categories/pricing want the stronger (standard) model for
  // vertical detection + taxonomy/pricing parsing. Kept at `standard`, not
  // `complex`, so they don't inherit the complex tier's temperature 0.5 — too
  // high for structured extraction (this is also their current effective tier,
  // so no behavior regression).
  extract_business_profile: 'standard',
  extract_categories: 'standard',
  extract_pricing: 'standard',
  // Complex
  draft_estimate: 'complex',
  update_estimate: 'complex',
  // MMS-to-quote MUST stay on a vision-capable tier. Unmapped it would fall to
  // `standard`, which only works while that tier's model is vision-capable — an
  // AI_STANDARD_MODEL override to a text model would trip the gateway's vision
  // failfast. Pinning to complex removes that footgun.
  mms_estimate: 'complex',
  draft_invoice: 'complex',
  update_invoice: 'complex',
  update_job: 'complex',
};

export const DEFAULT_AI_ROUTING_CONFIG: AIRoutingConfig = {
  tiers: {
    lightweight: { model: lightweightModel, maxTokens: 1024, temperature: 0, deadlineMs: lightweightDeadlineMs },
    standard: { model: standardModel, maxTokens: 4096, temperature: 0.3, deadlineMs: standardDeadlineMs },
    complex: { model: complexModel, maxTokens: 8192, temperature: 0.5, deadlineMs: complexDeadlineMs },
  },
  taskTierMapping: DEFAULT_TASK_TIER_MAPPING,
};

/**
 * VOX-34: resolve the per-request default deadline (ms) for a model tier.
 *
 * `gateway.complete()` calls this with the resolved tier when the caller left
 * `request.deadlineMs` unset. Falls back to the built-in default-config tier
 * budget (and finally the complex-tier budget) if a tenant override replaced a
 * tier entry without carrying `deadlineMs` — so we never return undefined.
 */
export function resolveTierDeadlineMs(
  tier: ModelTier,
  config: AIRoutingConfig = DEFAULT_AI_ROUTING_CONFIG,
): number {
  return (
    config.tiers[tier]?.deadlineMs ??
    DEFAULT_AI_ROUTING_CONFIG.tiers[tier].deadlineMs ??
    complexDeadlineMs
  );
}

/**
 * Models known to accept image content parts. Env-overridable so ops can
 * update the set without a deploy: AI_VISION_CAPABLE_MODELS is a
 * comma-separated list merged with these defaults. Matching is
 * case-insensitive and also matches a provider-namespaced id (e.g.
 * "openai/gpt-4o" or "openrouter/openai/gpt-4o" → "gpt-4o").
 */
const DEFAULT_VISION_CAPABLE_MODELS: readonly string[] = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
  // OpenRouter open VL — set AI_COMPLEX_MODEL to this for mms_estimate.
  'qwen/qwen2.5-vl-72b-instruct',
];

function visionCapableModelSet(): string[] {
  const fromEnv = (process.env.AI_VISION_CAPABLE_MODELS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_VISION_CAPABLE_MODELS.map((m) => m.toLowerCase()), ...fromEnv];
}

/**
 * N-004 (P2-037) — resolve the model a task type routes to under a config.
 * Small helper used by the "supervisor reviewer ≠ primary drafting model"
 * invariant below and by the reviewer wiring to pin the logged model id.
 */
export function resolveModelForTaskType(
  config: AIRoutingConfig,
  taskType: string,
): string {
  const tier = config.taskTierMapping[taskType] ?? 'standard';
  return config.tiers[tier].model;
}

/**
 * N-004 (P2-037) acceptance ("different model than the primary task",
 * docs/PRD.md:703). The supervisor reviewer is pinned to the lightweight tier
 * and the high-stakes drafting tasks (draft_estimate / draft_invoice / …) to
 * complex. A same-model reviewer is DEGRADED, not broken (the deterministic
 * checks still run), so this returns the collision rather than throwing — the
 * boot wiring (app.ts) logs a loud warning and still installs the gate. Returns
 * null when the reviewer model is distinct from every primary drafting model.
 */
export const SUPERVISOR_PRIMARY_DRAFTING_TASKS: readonly string[] = [
  'draft_estimate',
  'draft_invoice',
  'update_estimate',
  'update_invoice',
  'mms_estimate',
];

export function assertSupervisorReviewModelDistinct(
  config: AIRoutingConfig = DEFAULT_AI_ROUTING_CONFIG,
): { reviewModel: string; collidingTask: string } | null {
  const reviewModel = resolveModelForTaskType(config, 'supervisor_review');
  for (const task of SUPERVISOR_PRIMARY_DRAFTING_TASKS) {
    if (resolveModelForTaskType(config, task) === reviewModel) {
      return { reviewModel, collidingTask: task };
    }
  }
  return null;
}

/**
 * Whether the resolved model can accept image inputs. Compares on the last
 * path segment so a provider namespace is ignored ("openai/gpt-4o" → "gpt-4o"),
 * and treats a dated/versioned snapshot as the base family
 * ("gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18" → capable). Matching a base
 * family (e.g. "gpt-4o") therefore also covers its dated variants.
 */
export function isVisionCapableModel(model: string): boolean {
  if (!model) return false;
  const lastSegment = (id: string): string => id.toLowerCase().split('/').pop() ?? '';
  const m = lastSegment(model);
  return visionCapableModelSet().some((cap) => {
    const c = lastSegment(cap);
    return m === c || m.startsWith(`${c}-`);
  });
}
