/**
 * §5 I13′ (STRUCTURAL) — *"…in **every** operator-facing model context"*
 * (#1021, map #995).
 *
 * **The rule in one sentence:** caller-authored (S1) text may only reach a
 * model context through `buildUntrustedContentSection` or one of the two
 * sanctioned renderers in `ai/orchestration/context-builder.ts` — a prompt
 * that inlines it by hand fails the build.
 *
 * I13 is proven for the fence helper itself (marker counts, lowest-authority
 * slot, 30 passing cases). I13′ is the universal, and before this guard the
 * helper was simply called from the files that remembered to call it. The
 * repo says so in its own words, at `context-builder.ts:222`: *"Hand-rolling
 * thread formatting at a consumer instead of calling this is exactly the
 * 'forget the fence' failure mode I13 exists to prevent."* Nothing failed when
 * someone did.
 *
 * ## Two clauses, because "operator-facing" is not one thing
 *
 * **(A) The structured caller channels.** `SourceContext.recentMessages` and
 * `SourceContext.retrievedChunks` are the two fields whose contents are
 * caller-authored BY CONSTRUCTION — `classifyMessageProvenance` decides the
 * first, and corpus chunks are derived from customer surfaces. Both have a
 * sanctioned renderer. So: any module outside `context-builder.ts` that both
 * reads one of these fields AND assembles a prompt must go through a renderer
 * or the fence helper. This clause is mechanical, has no judgment in it, and
 * holds today.
 *
 * **(B) Free-form transcripts.** `transcript` is the harder half, because most
 * of this repo's "transcript" is the OWNER dictating to their own command line
 * — S2 speech, which I13 was never about. Whether a given task handler's
 * transcript is S1 or S2 is a fact about the surface, not about the text, and
 * cannot be read off a regex. So clause B sweeps every module that assembles a
 * prompt AND names a caller-text identifier, and requires each to be
 * CLASSIFIED in the frozen inventory below. An unclassified module fails the
 * build; the classification is where the judgment lives, in review, in
 * writing.
 *
 * ## Finding
 *
 * One genuine violation: `workers/transcription.ts:241` interpolates a raw
 * voice transcript straight into a user message with no fence and no hardening
 * line. It is upstream of every operator surface that later reads that
 * transcript, so an instruction planted in a caller's speech is corrected
 * INTO the stored record and then read back by the operator's agents — the
 * three-hours-later attack in I13's own doc comment, with an extra hop.
 * Recorded, reported, not fixed (this lane is test-only).
 *
 * Evidence class: STRUCTURAL (negative controls plant an unfenced consumer on
 * both clauses).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { listSourceFiles, plantTree, removeTree, type SourceFile } from '../support/structural-scan';

const SRC = path.resolve(__dirname, '../../src');

/** The fence helper and the two sanctioned renderers built on it. */
const SANCTIONED_RENDERERS = [
  'buildUntrustedContentSection',
  'buildRecentMessagesPromptSections',
  'buildRetrievedChunksPromptSection',
] as const;

/** The module that OWNS the fence and its renderers — never its own consumer. */
const FENCE_MODULES = [
  'src/ai/untrusted-content.ts',
  'src/ai/orchestration/context-builder.ts',
] as const;

/** A module assembles a model context if it builds chat messages or a system prompt. */
const PROMPT_ASSEMBLY = /role:\s*['"](?:system|user)['"]|systemPrompt|messages\s*:\s*\[/;

/** Caller-authored text identifiers (clause B's domain). */
const CALLER_TEXT =
  /\b(transcript|transcriptText|callerLines|callerTurns|customerLines|callerUtterance|callerMessage|customerMessage|inboundMessage|voicemail|callerText|messageThread)\b/;

/**
 * The two structured caller channels, each paired with the renderer that is
 * the only sanctioned way to put it in a prompt.
 *
 * Reviewed on PR #1063: a single file-wide "does this module mention any
 * renderer" predicate meant a module that legitimately calls ONE renderer and
 * separately hand-rolls the OTHER channel counted as fenced, reopening the
 * injection path the clause exists to close. The channel and its renderer are
 * now checked as a pair.
 */
const STRUCTURED_CHANNELS: ReadonlyArray<{
  channel: string;
  renderer: string;
  /** Hand-rolling: reading the channel's element text out into a string. */
  handRolled: RegExp;
}> = [
  {
    channel: 'recentMessages',
    renderer: 'buildRecentMessagesPromptSections',
    handRolled: /recentMessages[\s\S]{0,200}?\.(?:map|forEach|reduce|join)\s*\(/,
  },
  {
    channel: 'retrievedChunks',
    renderer: 'buildRetrievedChunksPromptSection',
    handRolled: /retrievedChunks[\s\S]{0,200}?\.(?:map|forEach|reduce|join)\s*\(/,
  },
];

/** Any mention of a structured caller channel (used for the coarse sweep). */
const STRUCTURED_CALLER_CHANNEL = /\b(recentMessages|retrievedChunks)\b/;

/**
 * Does this module actually CALL a sanctioned renderer?
 *
 * A call expression, never a bare mention. Reviewed on PR #1063: matching the
 * name anywhere in the file let an `import { buildRecentMessagesPromptSections }`
 * line alone count as proof of fencing, so a module could import the renderer,
 * never use it, hand-roll `recentMessages` into a prompt, and the guard would
 * report nothing — a false negative on exactly the drift clause A exists to
 * catch. An import statement has no `(` after the identifier; a call does.
 * `NEGATIVE CONTROL (A) — imported but hand-rolled` pins it.
 */
function callsRenderer(file: SourceFile, renderer: string): boolean {
  return new RegExp(String.raw`\b${renderer}\s*\(`).test(file.code);
}

function usesSanctionedRenderer(file: SourceFile): boolean {
  return SANCTIONED_RENDERERS.some((r) => callsRenderer(file, r));
}

function isFenceModule(rel: string): boolean {
  return FENCE_MODULES.some((m) => rel === m);
}

// ─── Clause A ───────────────────────────────────────────────────────────────

/**
 * Modules that read a structured caller channel, assemble a prompt, and do
 * NOT go through a sanctioned renderer. Pure in its roots.
 */
export function unfencedStructuredChannelConsumers(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of listSourceFiles(roots)) {
    if (isFenceModule(file.rel)) continue;
    if (!PROMPT_ASSEMBLY.test(file.code)) continue;
    if (!STRUCTURED_CALLER_CHANNEL.test(file.code)) continue;

    // PER CHANNEL, not per file. A module is only fenced for the channel it
    // actually hands to that channel's renderer (or to the raw fence helper);
    // calling one renderer earns it nothing for the other channel.
    const unfenced = STRUCTURED_CHANNELS.some((c) => {
      if (!new RegExp(String.raw`\b${c.channel}\b`).test(file.code)) return false;
      if (callsRenderer(file, c.renderer)) return false;
      if (callsRenderer(file, 'buildUntrustedContentSection')) return false;
      // Naming the channel is not using it — only a module that reads its
      // element text out into a string is hand-rolling.
      return c.handRolled.test(file.code);
    });
    if (unfenced) out.push(file.rel);
  }
  return out;
}

// ─── Clause B ───────────────────────────────────────────────────────────────

/**
 * Every module that actually SENDS a prompt to the gateway.
 *
 * Reviewed on PR #1063 (round 3): clause B's domain is "names a caller-text
 * identifier", and extracting the transcription prompt into
 * `buildCorrection(raw)` would match `PROMPT_ASSEMBLY` but not `CALLER_TEXT` —
 * so the helper would never need classification. The critique is right, and
 * the real fix (tracing provenance through a rename) needs dataflow a text
 * scan does not have.
 *
 * What IS reachable is the chokepoint. Every prompt reaches a model through
 * `gateway.complete(...)`, and that call cannot be renamed away — it is the
 * gateway's own API, pinned by I15. So the set of gateway-calling modules is
 * pinned instead: extracting a prompt builder cannot move the `complete` call
 * out of a classified module, and introducing a NEW sender fails here
 * regardless of what its local identifiers are called.
 */
export function gatewayCallingModules(roots: readonly string[]): string[] {
  return listSourceFiles(roots)
    .filter((f) => /\.complete\s*\(/.test(f.code))
    .filter((f) => /gateway|llm/i.test(f.code))
    .map((f) => f.rel)
    .sort();
}

export function promptBuildersNamingCallerText(roots: readonly string[]): string[] {
  return listSourceFiles(roots)
    .filter((f) => !isFenceModule(f.rel))
    .filter((f) => CALLER_TEXT.test(f.code))
    .filter((f) => PROMPT_ASSEMBLY.test(f.code))
    .map((f) => f.rel);
}

/**
 * How many modules send a prompt to the gateway today.
 *
 * A budget assertion, in the shape §5.0c(b) recommends for I18: cheap,
 * mechanical, and a PR that changes it is self-documenting in review. It is
 * what closes the round-3 rename hole — a new prompt sender cannot appear
 * without a human looking at where its text comes from.
 */
const PINNED_GATEWAY_SENDER_COUNT = 48;

type Classification =
  | 'fenced'
  | 'owner-authored-input'
  | 'harness'
  | 'non-prompt-plumbing'
  | 'violation';

/**
 * Every prompt-assembling module that names caller-authored text, classified.
 *
 * `owner-authored-input` is the large class and deserves its reason stated
 * once here: the drafting family's "transcript" is `TaskContext.message` — the
 * OWNER speaking to their own command line, and the onboarding extractors'
 * transcript is the business owner's onboarding call. I13 governs S1 caller
 * speech entering an S2 operator context; owner speech in an owner context is
 * neither half of that. These are listed rather than filtered out so that the
 * day one of them starts carrying customer speech, the entry has to be
 * revisited by hand.
 */
const CLASSIFIED: ReadonlyArray<{ file: string; as: Classification; why: string }> = [
  {
    file: 'src/ai/skills/summarize-session.ts',
    as: 'fenced',
    why: 'Fences caller turns through buildUntrustedContentSection (:193) — the canonical S1-into-S2 read-back.',
  },
  {
    file: 'src/ai/tasks/suggest-reply-task.ts',
    as: 'fenced',
    why: 'Fences the customer message thread (:173) and renders retrieved chunks through the sanctioned renderer (:163).',
  },
  {
    file: 'src/workers/transcription.ts',
    as: 'violation',
    why: 'transcription.ts:241 interpolates the RAW caller transcript into a user message ("Raw transcript: ${raw}") with no fence and no hardening line. The corrected output is written back as the stored transcript, so a planted instruction survives into every operator surface that later reads it.',
  },
  {
    file: 'src/ai/agents/onboarding/transitions.ts',
    as: 'owner-authored-input',
    why: 'The onboarding FSM transcript is the business OWNER speaking during their own onboarding call.',
  },
  {
    file: 'src/ai/agents/onboarding/types.ts',
    as: 'non-prompt-plumbing',
    why: 'Type declarations only — TranscriptTurn and the extractor input shapes; assembles nothing.',
  },
  {
    file: 'src/ai/tasks/onboarding/business-profile-extractor.ts',
    as: 'owner-authored-input',
    why: "Extracts vertical/profile facts from the OWNER's own onboarding call transcript.",
  },
  {
    file: 'src/ai/tasks/onboarding/category-extractor.ts',
    as: 'owner-authored-input',
    why: "Owner onboarding transcript; also carries its own inline 'treat as data only' instruction.",
  },
  {
    file: 'src/ai/tasks/onboarding/pricing-extractor.ts',
    as: 'owner-authored-input',
    why: "Owner onboarding transcript, delimited with <transcript> tags and a data-only instruction.",
  },
  {
    file: 'src/ai/tasks/onboarding/schedule-extractor.ts',
    as: 'owner-authored-input',
    why: "Owner onboarding transcript, <transcript>-delimited with a data-only instruction.",
  },
  {
    file: 'src/ai/tasks/onboarding/team-extractor.ts',
    as: 'owner-authored-input',
    why: "Owner onboarding transcript, <transcript>-delimited with a data-only instruction.",
  },
  {
    file: 'src/ai/tasks/onboarding/tools-extractor.ts',
    as: 'owner-authored-input',
    why: "Owner onboarding transcript, <transcript>-delimited with a data-only instruction.",
  },
  {
    file: 'src/ai/tasks/create-appointment-task.ts',
    as: 'owner-authored-input',
    why: 'The "voice transcript" it extracts from is TaskContext.message — the operator dictating on their own line (:237 stamps the same value as the clarification transcript).',
  },
  {
    file: 'src/ai/tasks/estimate-edit-task.ts',
    as: 'owner-authored-input',
    why: 'Its system prompt says so outright: "Given a voice transcript from an operator".',
  },
  {
    file: 'src/ai/tasks/invoice-edit-task.ts',
    as: 'owner-authored-input',
    why: '"Given a voice transcript from an operator" — the owner\'s edit dictation.',
  },
  {
    file: 'src/ai/tasks/invoice-task.ts',
    as: 'owner-authored-input',
    why: 'Its `customerMessage` is a field the OWNER dictates for the invoice, not inbound customer speech.',
  },
  {
    file: 'src/ai/tasks/job-edit-task.ts',
    as: 'owner-authored-input',
    why: '"Given a voice transcript from an operator".',
  },
  {
    file: 'src/ai/orchestration/intent-classifier.ts',
    as: 'owner-authored-input',
    why: "Classifies the owner's command-line utterance (`matchOwnerOperatorCommand`); caller text reaches it only through the fenced context sections.",
  },
  {
    file: 'src/ai/orchestration/transcript-decomposer.ts',
    as: 'owner-authored-input',
    why: 'Splits the OPERATOR\'s multi-action utterance ("create a customer AND book an appointment") into separate intents.',
  },
  {
    file: 'src/ai/voice-quality/graders/caller-experience.ts',
    as: 'harness',
    why: 'Layer-1 voice-quality grader — an offline eval judge, not a caller-facing or operator-facing runtime path (same exemption as I1′/I9′).',
  },
  {
    file: 'src/ai/voice-quality/graders/disposition-llm.ts',
    as: 'harness',
    why: 'Offline eval judge scoring a recorded agent response; no runtime caller or operator reads its prompt.',
  },
  {
    file: 'src/ai/voice-quality/graders/perceived-completion.ts',
    as: 'harness',
    why: 'Offline eval judge over a Whisper-recovered call transcript; corpus scoring only, never a live surface.',
  },
  {
    file: 'src/routes/assistant.ts',
    as: 'non-prompt-plumbing',
    why: "Its only `transcript` hits are the `recoveredFrom: 'communication_notes' | 'transcript'` enum on the serviceLocationGap card context — a provenance label, not text inlined into a prompt.",
  },
  {
    file: 'src/app.ts',
    as: 'non-prompt-plumbing',
    why: 'Wires a gateway `complete` adapter for classifyTurnSentiment; the prompt string is built by the caller, so app.ts inlines no caller text itself. (Scope note in the lane report: the sentiment prompt builder is not in this sweep.)',
  },
];

function classificationOf(rel: string): Classification | null {
  return CLASSIFIED.find((c) => c.file === rel)?.as ?? null;
}

// ─── The guard ──────────────────────────────────────────────────────────────

describe('§5 I13′ (STRUCTURAL) — caller text reaches a model context only through the fence', () => {
  it('the fence and its two renderers exist where the guard expects them', () => {
    const files = listSourceFiles([SRC]).filter((f) => isFenceModule(f.rel));
    expect(files.map((f) => f.rel).sort()).toEqual([...FENCE_MODULES].sort());
    const all = files.map((f) => f.code).join('\n');
    for (const renderer of SANCTIONED_RENDERERS) {
      expect(all, renderer).toContain(`export function ${renderer}`);
    }
  });

  // ── Clause A ──────────────────────────────────────────────────────────────

  it('A — every prompt consumer of recentMessages/retrievedChunks goes through a sanctioned renderer', () => {
    expect(
      unfencedStructuredChannelConsumers([SRC]),
      [
        'A module assembles a prompt from recentMessages or retrievedChunks',
        'without a sanctioned renderer.',
        '',
        'context-builder.ts says it plainly: "Hand-rolling thread formatting at',
        'a consumer instead of calling this is exactly the \'forget the fence\'',
        'failure mode I13 exists to prevent."',
        '',
        'Use buildRecentMessagesPromptSections / buildRetrievedChunksPromptSection,',
        'and inject the untrusted block into the LOWEST-authority slot.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('A is not vacuous: the sanctioned renderers really are used by a real consumer', () => {
    const consumers = listSourceFiles([SRC])
      .filter((f) => !isFenceModule(f.rel))
      .filter((f) => usesSanctionedRenderer(f))
      .map((f) => f.rel);
    expect(consumers).toContain('src/ai/tasks/suggest-reply-task.ts');
    expect(consumers).toContain('src/ai/skills/summarize-session.ts');
  });

  // ── Clause B ──────────────────────────────────────────────────────────────

  it('B — every prompt builder that names caller text is classified', () => {
    const unclassified = promptBuildersNamingCallerText([SRC]).filter(
      (rel) => classificationOf(rel) === null,
    );
    expect(
      unclassified,
      [
        'A module assembles a model context and names caller-authored text, and',
        'nobody has said which it is.',
        '',
        'Classify it: `fenced` (it calls the helper), `owner-authored-input`',
        '(the speech is the OWNER\'s, so I13 does not apply — say why),',
        '`harness`, `non-prompt-plumbing`, or `violation`.',
        '',
        'If S1 caller text reaches an operator-facing prompt unfenced, it is a',
        'violation: route it through buildUntrustedContentSection.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('B — the set of modules that SEND a prompt is pinned (a rename cannot move the send)', () => {
    const senders = gatewayCallingModules([SRC]);
    // Not vacuous, and bounded: if this count moves, a module started or
    // stopped talking to the gateway and its caller-text provenance needs a
    // look — whatever its local identifiers happen to be called.
    expect(senders.length).toBeGreaterThan(20);
    expect(senders).toContain('src/workers/transcription.ts');
    expect(senders).toContain('src/ai/skills/summarize-session.ts');
    expect(senders).toContain('src/ai/tasks/suggest-reply-task.ts');
    expect(PINNED_GATEWAY_SENDER_COUNT).toBe(senders.length);
  });

  it('B — the recorded violation is still exactly where the report says it is', () => {
    const found = promptBuildersNamingCallerText([SRC]);
    for (const entry of CLASSIFIED.filter((c) => c.as === 'violation')) {
      expect(found, `${entry.file} — ${entry.why}`).toContain(entry.file);
    }
    // And it still inlines the transcript with no fence.
    const file = listSourceFiles([SRC]).find((f) => f.rel === 'src/workers/transcription.ts')!;
    expect(file.code).toMatch(/Raw transcript: \$\{raw\}/);
    expect(usesSanctionedRenderer(file)).toBe(false);
  });

  /**
   * I13′ AS WRITTEN. One operator-reachable prompt still inlines caller text
   * unfenced. When it is routed through the helper this starts PASSING,
   * `it.fails` fails, and the row is forced back for re-grading.
   */
  it.fails(
    'I13′ as written — no unfenced caller text in any model context (KNOWN GAP: workers/transcription.ts:241)',
    () => {
      const violations = promptBuildersNamingCallerText([SRC]).filter(
        (rel) => classificationOf(rel) === 'violation',
      );
      expect(violations).toEqual([]);
    },
  );

  // ─── Negative controls ────────────────────────────────────────────────────

  it('NEGATIVE CONTROL (A) — a planted hand-rolled recentMessages prompt is reported', () => {
    const dir = plantTree('i13-plant-a', {
      'planted-consumer.ts': [
        'export function buildPrompt(context: { recentMessages: Array<{ role: string; content: string }> }) {',
        "  const thread = context.recentMessages.map((m) => `${m.role}: ${m.content}`).join('\\n');",
        "  return { messages: [{ role: 'system', content: `Thread:\\n${thread}` }] };",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = unfencedStructuredChannelConsumers([dir]);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/planted-consumer\.ts$/);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (A, inverse) — the same consumer PASSES once it uses the renderer', () => {
    const dir = plantTree('i13-plant-a-fixed', {
      'fixed-consumer.ts': [
        "import { buildRecentMessagesPromptSections } from '../ai/orchestration/context-builder';",
        'export function buildPrompt(context: { recentMessages: Array<{ role: string; content: string }> }) {',
        '  const { trustedLines, untrustedBlock } = buildRecentMessagesPromptSections(context.recentMessages);',
        "  return { messages: [{ role: 'user', content: [...trustedLines, untrustedBlock].join('\\n') }] };",
        '}',
        '',
      ].join('\n'),
    });
    try {
      expect(unfencedStructuredChannelConsumers([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (A) — a module that IMPORTS a renderer but still hand-rolls the thread is reported', () => {
    // The false negative reviewed on PR #1063: an unused import is not a fence.
    const dir = plantTree('i13-imported-unused', {
      'imported-but-hand-rolled.ts': [
        "import { buildRecentMessagesPromptSections } from '../ai/orchestration/context-builder';",
        '',
        'export function buildPrompt(context: { recentMessages: Array<{ role: string; content: string }> }) {',
        '  // The import sits there unused while the thread is interpolated by hand.',
        "  const thread = context.recentMessages.map((m) => `${m.role}: ${m.content}`).join('\\n');",
        "  return { messages: [{ role: 'system', content: `Thread:\\n${thread}` }] };",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = unfencedStructuredChannelConsumers([dir]);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/imported-but-hand-rolled\.ts$/);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (A) — calling ONE renderer does not fence the OTHER channel', () => {
    // The false negative reviewed on PR #1063: a module that legitimately
    // renders retrievedChunks and separately hand-rolls the message thread.
    const dir = plantTree('i13-one-of-two', {
      'half-fenced.ts': [
        "import { buildRetrievedChunksPromptSection } from '../ai/orchestration/context-builder';",
        '',
        'export function buildPrompt(context: {',
        '  recentMessages: Array<{ role: string; content: string }>;',
        '  retrievedChunks: Array<{ sourceType: string; content: string }>;',
        '}) {',
        '  const notes = buildRetrievedChunksPromptSection(context.retrievedChunks);',
        "  const thread = context.recentMessages.map((m) => `${m.role}: ${m.content}`).join('\\n');",
        "  return { messages: [{ role: 'system', content: `${notes}\\n${thread}` }] };",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = unfencedStructuredChannelConsumers([dir]);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/half-fenced\.ts$/);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (A, inverse) — a module that merely NAMES a channel without reading it is not reported', () => {
    const dir = plantTree('i13-names-only', {
      'plumbing.ts': [
        'export interface Ctx {',
        '  recentMessages: Array<{ role: string; content: string }>;',
        '}',
        "export function forward(ctx: Ctx) { return { messages: [{ role: 'user', content: 'x' }], ctx }; }",
        '',
      ].join('\n'),
    });
    try {
      expect(unfencedStructuredChannelConsumers([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (B) — a planted unclassified prompt builder naming caller text is reported', () => {
    const dir = plantTree('i13-plant-b', {
      'planted-summary.ts': [
        'export function summarize(transcript: string) {',
        "  return { messages: [{ role: 'user', content: `Summarize this call:\\n${transcript}` }] };",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = promptBuildersNamingCallerText([dir]).filter(
        (rel) => classificationOf(rel) === null,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/planted-summary\.ts$/);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (inverse) — caller text named only in a doc comment is NOT reported', () => {
    const dir = plantTree('i13-comment-only', {
      'commented.ts': [
        '/**',
        ' * Renders the transcript and the recentMessages thread into a',
        " * system prompt with `messages: [` — but only in this comment.",
        ' */',
        'export const ok = true;',
        '',
      ].join('\n'),
    });
    try {
      expect(promptBuildersNamingCallerText([dir])).toEqual([]);
      expect(unfencedStructuredChannelConsumers([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('every classification carries its reason, and the owner-authored class is the one that needs watching', () => {
    for (const entry of CLASSIFIED) {
      expect(entry.why.length, entry.file).toBeGreaterThan(40);
      expect(entry.file, entry.file).toMatch(/^src\/.+\.ts$/);
    }
    // Stated as a measurement so a silent reclassification shows up in review.
    const ownerAuthored = CLASSIFIED.filter((c) => c.as === 'owner-authored-input');
    expect(ownerAuthored.length).toBe(14);
  });
});
