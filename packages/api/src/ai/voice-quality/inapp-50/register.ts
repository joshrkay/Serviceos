/**
 * In-app 50-case register — loader + schema.
 *
 * The register (`fixtures/voice/inapp-50-cases.json`) is the CONTRACT the
 * hermetic harness runs against: fifty real operator utterances, each with a
 * scripted classifier output (so the real FSM / entity resolver / payload
 * builder run with only the LLM replaced) and a machine-checkable
 * expectation. See docs/plans/2026-09-09-inapp-50-cases-plan.md.
 *
 * Loaded by `readFileSync` rather than `import`: the fixtures tree lives
 * outside `packages/api`, and `tsconfig.build.json` (the Railway build)
 * roots at the package. The seed script (`scripts/seed-operator-voice-
 * fixtures.ts`) reads the sibling catalog the same way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Repo-root-relative path of the register, resolved from this module. */
export const REGISTER_PATH = resolve(
  __dirname,
  '../../../../../../fixtures/voice/inapp-50-cases.json',
);

/** Repo-root-relative path of the seed catalog the world is built from. */
export const FIXTURE_CATALOG_PATH = resolve(
  __dirname,
  '../../../../../../fixtures/voice/operator-voice-fixture-catalog.json',
);

const fixtureKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/, 'fixture key must be a dotted lowercase key');

/**
 * The scripted classifier turn. Shaped like `IntentClassification`'s JSON
 * body — the harness's gateway returns `JSON.stringify(entry)` verbatim, so
 * the REAL `classifyIntent` parser runs over it.
 */
const llmTurnSchema = z
  .object({
    intentType: z.string().min(1),
    confidence: z.number().min(0).max(1),
    extractedEntities: z.record(z.unknown()).default({}),
    /**
     * KEYED SCRIPTING — the operator turn this entry answers, matched
     * case-insensitively as a substring of the classify call's user message.
     *
     * Positional scripting alone is fragile: a deterministic pre-classifier
     * (`matchNewBookingPhrase`, `matchOwnerOperatorCommand`, the filler/noise
     * detector, the duplicate-turn guard) answers some turns WITHOUT calling
     * the LLM at all, so turn N and classify-call N drift apart and a later
     * turn silently consumes an earlier turn's entry. `for` pins an entry to
     * its utterance so the script survives that. Entries without `for` keep
     * the positional behavior.
     */
    for: z.string().min(1).optional(),
  })
  .passthrough();

const expectSchema = z
  .object({
    /** Coarse shape of the correct outcome for this case. */
    outcome: z.enum([
      'proposal',
      'lookup_answer',
      'clarification_question',
      'not_found',
      'escalation',
      'direct_act',
      'guard',
    ]),
    proposalType: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    /**
     * Payload keys that must carry a specific value. A value that is a
     * fixture key ("customer.garcia") is resolved through the world's
     * `fixtureIds` before comparison; anything else compares literally.
     */
    payloadContains: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** Payload keys that must merely be present and non-empty. */
    payloadHas: z.array(z.string().min(1)).optional(),
    missingFieldsContains: z.array(z.string().min(1)).optional(),
    proposalCount: z.number().int().nonnegative().optional(),
    /** Case-insensitive regex over the last spoken line (or any, with anyTurn). */
    spokenMatches: z.string().min(1).optional(),
    forbidSpoken: z.string().min(1).optional(),
    anyTurn: z.boolean().optional(),
    requireSideEffects: z.array(z.string().min(1)).optional(),
    forbidSideEffects: z.array(z.string().min(1)).optional(),
    allowedStates: z.array(z.string().min(1)).optional(),
    /** 1-based turn index → the state the adapter must report after it. */
    stateAfterTurn: z.record(z.string().min(1)).optional(),
    /** ISO weekday (1=Mon … 7=Sun) of payload.scheduledStart in tenant tz. */
    scheduledStartWeekday: z.number().int().min(1).max(7).optional(),
    requireClarificationTurn: z.boolean().optional(),
    forbidProposalTypes: z.array(z.string().min(1)).optional(),
    /**
     * Audit `eventType`s the case must produce, looked for BOTH in the
     * `audit_log` side effects the FSM returns AND in the rows written
     * straight to the tenant's audit repository — a direct act like
     * `appointment.en_route_triggered` is audited through the repo by
     * `dispatch/routes.ts#triggerEnRoute`, never as an FSM side effect, so
     * checking only side effects would score a fired act as "nothing
     * happened".
     */
    requireAuditEvents: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * SURFACES the register runs against.
 *
 * The product promise is that voice AND text both work, and they are two
 * DIFFERENT entry points into the same drafting pipeline:
 *   - `voice`       → `POST /api/voice/sessions` → `InAppVoiceAdapter` FSM
 *   - `chat`        → `POST /api/assistant/chat` with `inputMode: 'text'`
 *   - `chat-voice`  → the SAME route with `inputMode: 'voice'` (the web
 *                     assistant page posts mic transcripts this way, so the
 *                     voice-approval refusal and any other inputMode-gated
 *                     behavior are exercised)
 * A green voice run says nothing about the chat route, which is what an
 * operator typing at a desk actually hits.
 */
export const SURFACES = ['voice', 'chat', 'chat-voice'] as const;
export type Surface = (typeof SURFACES)[number];

/** The surface the pre-existing artifact shape implicitly meant. */
export const DEFAULT_SURFACE: Surface = 'voice';

/** `inputMode` the assistant route is driven with for a chat surface. */
export function inputModeFor(surface: Surface): 'voice' | 'text' {
  return surface === 'chat-voice' ? 'voice' : 'text';
}

export function isChatSurface(surface: Surface): boolean {
  return surface === 'chat' || surface === 'chat-voice';
}

/**
 * Per-case CHAT override.
 *
 * Used ONLY where the voice script is meaningless on a text surface. Chat has
 * no spoken readback and therefore no readback-confirmation turn: "yes" after
 * a booking is not a commit, it is a stray token. Rewriting those cases for
 * chat is not relaxing the bar — the SAME operator risk (double-submit mints
 * two proposals, a correction mints a second one, stray noise mints anything
 * at all) is expressed in the shape the chat surface can actually exhibit.
 *
 * Every override carries a `rationale`; anything without one is a voice
 * script someone quietly reused.
 */
const chatOverrideSchema = z
  .object({
    turns: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Scripted classifier for the chat turns, when they differ enough from
     * the voice script that its entries no longer cover them. Absent ⇒ the
     * case's own `llm` is used unchanged.
     */
    llm: z.array(llmTurnSchema).min(1).optional(),
    expect: expectSchema.optional(),
    /** Present ⇒ the case is not meaningful on chat at all and is not run. */
    skip: z.string().min(1).optional(),
    rationale: z.string().min(1).optional(),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.number().int().positive(),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'case key must be kebab-case'),
    cluster: z.string().min(1),
    op: z.string().min(1),
    cat: z.string().min(1),
    severity: z.enum(['critical', 'core', 'growth']),
    intent: z.string().min(1),
    expectProposal: z.string().min(1).nullable(),
    utterance: z.string().min(1),
    /** Full turn script; defaults to `[utterance]`. */
    turns: z.array(z.string().min(1)).min(1).optional(),
    llm: z.array(llmTurnSchema).min(1),
    fixtureRefs: z.array(fixtureKeySchema),
    tags: z.array(z.string().min(1)).optional(),
    disambiguationFollowUp: z.string().min(1).optional(),
    /** false ⇒ the driver sends ONLY `turns` and never auto-confirms. */
    autoConfirm: z.boolean().optional(),
    rationale: z.string().min(1).optional(),
    expect: expectSchema,
    /** Chat-surface override — see `chatOverrideSchema`. */
    chat: chatOverrideSchema.optional(),
  })
  .strict();

const catalogItemSeedSchema = z
  .object({
    key: fixtureKeySchema,
    name: z.string().min(1),
    unitPriceCents: z.number().int().nonnegative(),
    category: z.enum(['labor', 'material', 'equipment', 'other']),
  })
  .strict();

/**
 * The same-day appointment the `en_route` case needs. "On my way" is a
 * statement about RIGHT NOW: the shared core (`dispatch/en-route-voice.ts`)
 * scopes resolution to the acting technician's own assignments inside the
 * tenant-local service day, so without a today appointment ASSIGNED TO THE
 * SPEAKER the act can only ever answer "nothing today".
 */
const todayAppointmentSeedSchema = z
  .object({
    key: fixtureKeySchema,
    jobKey: fixtureKeySchema,
    /** Which seeded user it is assigned to. 'owner' = the speaking operator. */
    assignedTo: z.enum(['owner']),
    hoursFromNow: z.number().positive(),
    durationMinutes: z.number().int().positive(),
    notes: z.string().min(1),
  })
  .strict();

const harnessSeedsSchema = z
  .object({
    tenantTimezone: z.string().min(1),
    catalogItems: z.array(catalogItemSeedSchema),
    extraCustomers: z.array(z.record(z.unknown())).default([]),
    todayAppointment: todayAppointmentSeedSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

const registerSchema = z
  .object({
    version: z.literal('inapp-50-v1'),
    label: z.string().min(1),
    created: z.string().min(1),
    description: z.string().min(1),
    fixtureCatalog: z.string().min(1),
    harnessSeeds: harnessSeedsSchema,
    severityRubric: z.record(z.string()),
    clusters: z.array(z.string().min(1)).min(1),
    cases: z.array(caseSchema).length(50),
  })
  .strict();

export type RegisterCase = z.infer<typeof caseSchema>;
export type CaseExpect = z.infer<typeof expectSchema>;
export type CaseSeverity = RegisterCase['severity'];
export type CaseOutcome = CaseExpect['outcome'];
export type ScriptedLlmTurn = z.infer<typeof llmTurnSchema>;
export type HarnessSeeds = z.infer<typeof harnessSeedsSchema>;
export type TodayAppointmentSeed = z.infer<typeof todayAppointmentSeedSchema>;
export type ChatOverride = z.infer<typeof chatOverrideSchema>;
export type Register = z.infer<typeof registerSchema>;

/**
 * Parse + validate a raw register object. Beyond the schema this enforces the
 * two uniqueness invariants the run artifact keys on (`id`, `key`) and the
 * cluster closure — a case in an undeclared cluster would silently vanish
 * from the per-cluster scoreboard.
 */
export function parseRegister(raw: unknown): Register {
  const register = registerSchema.parse(raw);

  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();
  const clusters = new Set(register.clusters);
  for (const c of register.cases) {
    if (seenIds.has(c.id)) throw new Error(`inapp-50 register: duplicate case id ${c.id}`);
    if (seenKeys.has(c.key)) throw new Error(`inapp-50 register: duplicate case key ${c.key}`);
    seenIds.add(c.id);
    seenKeys.add(c.key);
    if (!clusters.has(c.cluster)) {
      throw new Error(`inapp-50 register: case ${c.key} names undeclared cluster '${c.cluster}'`);
    }
    if (c.expect.outcome === 'proposal' && !c.expect.proposalType) {
      throw new Error(`inapp-50 register: case ${c.key} expects a proposal with no proposalType`);
    }
    if (c.chat) {
      if (c.chat.skip && (c.chat.turns || c.chat.expect || c.chat.llm)) {
        throw new Error(
          `inapp-50 register: case ${c.key} both skips chat and overrides its script`,
        );
      }
      if (!c.chat.skip && !c.chat.rationale) {
        throw new Error(
          `inapp-50 register: case ${c.key} overrides the chat script with no rationale`,
        );
      }
      if (c.chat.expect?.outcome === 'proposal' && !c.chat.expect.proposalType) {
        throw new Error(
          `inapp-50 register: case ${c.key} chat-expects a proposal with no proposalType`,
        );
      }
    }
    // The turn script and the scripted classifier must be able to cover each
    // other: the runner repeats the LAST llm entry when it runs out, but a
    // register with MORE llm entries than reachable turns is a authoring
    // mistake worth catching at load time.
    if (c.llm.length > turnsFor(c).length + 3) {
      throw new Error(
        `inapp-50 register: case ${c.key} scripts ${c.llm.length} classifier turns for ` +
          `${turnsFor(c).length} operator turn(s)`,
      );
    }
  }
  return register;
}

/** The operator turns to send, in order. */
export function turnsFor(c: RegisterCase): string[] {
  return c.turns && c.turns.length > 0 ? c.turns : [c.utterance];
}

/** The operator turns to send on `surface`, in order. */
export function turnsForSurface(c: RegisterCase, surface: Surface): string[] {
  if (isChatSurface(surface) && c.chat?.turns && c.chat.turns.length > 0) return c.chat.turns;
  return turnsFor(c);
}

/** The scripted classifier entries to serve on `surface`. */
export function llmForSurface(c: RegisterCase, surface: Surface): ScriptedLlmTurn[] {
  if (isChatSurface(surface) && c.chat?.llm && c.chat.llm.length > 0) return c.chat.llm;
  return c.llm;
}

/** The expectation block that governs `surface`. */
export function expectForSurface(c: RegisterCase, surface: Surface): CaseExpect {
  if (isChatSurface(surface) && c.chat?.expect) return c.chat.expect;
  return c.expect;
}

/**
 * Why this case is not run on `surface`, or undefined when it is.
 * Voice is never skipped: the voice script IS the register.
 */
export function skipReasonForSurface(c: RegisterCase, surface: Surface): string | undefined {
  return isChatSurface(surface) ? c.chat?.skip : undefined;
}

/** Parse a `--surface` CLI value into the canonical list. */
export function parseSurfaces(raw: string): Surface[] {
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = wanted.filter((s) => !(SURFACES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new Error(
      `inapp-50: unknown surface(s): ${unknown.join(', ')} (known: ${SURFACES.join(', ')})`,
    );
  }
  // Canonical order, de-duplicated — the artifact must be diffable run to run.
  return SURFACES.filter((s) => wanted.includes(s));
}

/** Load + validate the register from disk. */
export function loadRegister(path: string = REGISTER_PATH): Register {
  return parseRegister(JSON.parse(readFileSync(path, 'utf8')));
}

/** Select the cases for a 10-per-batch run (`--batch N`, N in 1..5). */
export function casesForBatch(register: Register, batch: number): RegisterCase[] {
  if (!Number.isInteger(batch) || batch < 1 || batch > 5) {
    throw new Error(`inapp-50: --batch must be an integer 1..5 (got ${batch})`);
  }
  const from = (batch - 1) * 10 + 1;
  const to = batch * 10;
  return register.cases.filter((c) => c.id >= from && c.id <= to);
}

/** Select cases by key (`--only book-01,search-02`). */
export function casesForKeys(register: Register, keys: readonly string[]): RegisterCase[] {
  const wanted = new Set(keys);
  const found = register.cases.filter((c) => wanted.has(c.key));
  const missing = [...wanted].filter((k) => !found.some((c) => c.key === k));
  if (missing.length > 0) {
    throw new Error(`inapp-50: unknown case key(s): ${missing.join(', ')}`);
  }
  return found;
}
