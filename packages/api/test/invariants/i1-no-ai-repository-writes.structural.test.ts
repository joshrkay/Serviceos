/**
 * §5 I1′ — *"…and I want that true of **every** path, not just the ones
 * someone tested"* (#1021, map #995).
 *
 * **The rule in one sentence:** no module under `packages/api/src/ai/**` may
 * call a write method on a repository for an OPERATIONAL entity (customer,
 * lead, job, invoice, estimate, appointment, catalog item, user, assignment,
 * call-me-back task); the AI's only sanctioned write is the typed proposal it
 * drafts, plus the AI-plane bookkeeping that proposal needs (D-004).
 *
 * I1 ("the AI never writes to an operational entity") is proven per-path at
 * real Postgres. I1′ is the universal, and before this guard nothing enforced
 * it: a new AI module could take a `CustomerRepository` and call `.create` and
 * CI would be silent. The PRD's own note is exact — *a tested behaviour, not
 * an enforced invariant*.
 *
 * ## Why this guard is an INVENTORY, not a bare prohibition
 *
 * Some AI-plane writes are not only allowed, they are the architecture:
 * `proposalRepo.create` IS drafting, and `auditRepo.create` is CLAUDE.md's
 * "all mutations emit audit events". A guard that banned every `.create` would
 * be wrong, and a guard that allow-listed by regex shape would quietly absorb
 * the next `customerRepo.create` that someone names `recordRepo`.
 *
 * So the guard enumerates EVERY repository write under `src/ai` and requires
 * each one to be classified in the frozen inventory below — `allowed` with a
 * reason, or `violation` with a reason. An unclassified write fails the build.
 * That is what makes it structural: the next path cannot be added silently,
 * whichever side of the line it lands on.
 *
 * ## Finding: the universal does NOT hold today
 *
 * SIX production AI call sites write an operational entity (listed in
 * `KNOWN_VIOLATIONS` with file:line; the sixth,
 * `ai/tasks/estimate-template.ts:97`, surfaced in review when the receiver
 * pattern stopped requiring an entity prefix). They are NOT waved through: the guard
 * keeps them as an explicit, honest `it.fails` assertion of I1′ as written, so
 * the gap is recorded rather than defined away. Closing them is product work
 * and is reported, not attempted here (#1021 is test-only).
 *
 * Evidence class: STRUCTURAL (negative control below plants a violation into a
 * temp tree and shows the guard reporting it).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  listSourceFiles,
  plantTree,
  removeTree,
  formatViolations,
  type SourceFile,
} from '../support/structural-scan';

const AI_ROOT = path.resolve(__dirname, '../../src/ai');

/** Repository method names that mutate persisted state. */
const WRITE_METHODS = [
  'create',
  'update',
  'insert',
  'save',
  'upsert',
  'delete',
  'remove',
  'createMany',
  'updateMany',
  'deleteMany',
  'bulkCreate',
  'bulkUpdate',
] as const;

/**
 * The entity prefix is OPTIONAL.
 *
 * Reviewed on PR #1063: requiring at least one character before `Repo` meant a
 * repository injected under a bare generic name — `repository.create(...)`,
 * `repo.save(...)` — was invisible, and the tree already had seven such call
 * sites under `src/ai`, one of them an operational write
 * (`ai/tasks/estimate-template.ts:97`). The inventory and its baseline stayed
 * green while omitting an AI module that writes a tenant pricing template.
 *
 * A bare receiver carries no entity information, so it cannot be classified by
 * NAME the way `customerRepo` can. `GENERIC_RECEIVER_SITES` below classifies
 * those by FILE instead, and an unclassified one fails the build — the guard
 * cannot infer what `repository` writes, so a human has to say.
 */
const WRITE_CALL_RE = new RegExp(
  String.raw`\b((?:[A-Za-z_][A-Za-z0-9_]*)?[Rr]epo(?:sitory)?)\.(${WRITE_METHODS.join('|')})\s*\(`,
);

/** A receiver whose name says nothing about what it writes. */
function isGenericReceiver(receiver: string): boolean {
  return /^(repo|repository)$/i.test(receiver);
}

export interface RepoWrite {
  readonly at: string;
  readonly file: string;
  readonly line: number;
  /** e.g. `customerRepo` */
  readonly receiver: string;
  /** e.g. `create` */
  readonly method: string;
  readonly snippet: string;
}

/**
 * Every repository write call under `roots`, comment-stripped.
 *
 * Pure in its roots — this is what lets the negative control point the same
 * function at a planted tree.
 */
export function findRepositoryWrites(roots: readonly string[]): RepoWrite[] {
  const files: SourceFile[] = listSourceFiles(roots);
  const writes: RepoWrite[] = [];
  for (const file of files) {
    const codeLines = file.code.split('\n');
    const textLines = file.text.split('\n');
    for (let i = 0; i < codeLines.length; i += 1) {
      const m = codeLines[i].match(WRITE_CALL_RE);
      if (!m) continue;
      writes.push({
        at: `${file.rel}:${i + 1}`,
        file: file.rel,
        line: i + 1,
        receiver: m[1],
        method: m[2],
        snippet: (textLines[i] ?? '').trim(),
      });
    }
  }
  return writes;
}

// ─── The allowed-exception list, stated explicitly ──────────────────────────

/**
 * Repository receivers whose target is an AI-PLANE record, not an operational
 * entity. Writing these is what the AI is FOR (a proposal), what CLAUDE.md
 * mandates (an audit event), or AI bookkeeping that never appears on a
 * customer-facing record.
 *
 * Matched case-insensitively against the receiver identifier, so
 * `this.deps.auditRepo` and `auditRepo` are the same entry.
 */
const AI_PLANE_REPOS: ReadonlyArray<{ receiver: string; why: string }> = [
  {
    receiver: 'auditRepo',
    why: 'D-004/CLAUDE.md — every mutation emits an audit event; the trail is not an operational entity.',
  },
  {
    receiver: 'proposalRepo',
    why: 'The typed proposal IS the AI\'s only output (D-004). Drafting and status bookkeeping are the sanctioned write.',
  },
  {
    receiver: 'aiRunRepo',
    why: 'LLM-gateway run telemetry (cost/retries/audit trail, D-005). AI-plane only.',
  },
  {
    receiver: 'diffRepository',
    why: 'ai/diff-analysis artifact — a derived analysis record, never an operational row.',
  },
  {
    receiver: 'invoiceRevisionRepo',
    why: 'ai/evaluation/invoice-revision.ts writes a revision SNAPSHOT (provenance artifact); it never writes the invoice.',
  },
  {
    receiver: 'sessionRepo',
    why: 'Onboarding-conversation session state — AI conversation plane, no customer-visible record.',
  },
  {
    receiver: 'smsEventRepo',
    why: 'RV-225 — records a voice edit request in the proposal approval-rail event store so it blocks approval exactly like an SMS EDIT. Approval-rail bookkeeping on the proposal, not an operational entity.',
  },
];

/**
 * Bare-receiver (`repo` / `repository`) write sites, classified by FILE
 * because the identifier carries no entity information.
 *
 * Added in review (PR #1063). An unclassified generic-receiver write fails the
 * build rather than being guessed at in either direction.
 */
const GENERIC_RECEIVER_SITES: ReadonlyArray<{
  file: string;
  as: 'ai-plane' | 'violation';
  why: string;
}> = [
  {
    file: 'ai/document-revision.ts',
    as: 'ai-plane',
    why: 'Writes a document REVISION snapshot — a provenance artifact, never the document itself (same shape as invoiceRevisionRepo).',
  },
  {
    file: 'ai/prompt-registry.ts',
    as: 'ai-plane',
    why: 'Prompt-version records for the AI gateway; no customer-visible entity.',
  },
  {
    file: 'ai/evaluation/dataset-hooks.ts',
    as: 'ai-plane',
    why: 'Eval dataset rows for the offline evaluation harness — AI-plane telemetry.',
  },
  {
    file: 'ai/evaluation/invoice-approval.ts',
    as: 'ai-plane',
    why: 'Evaluation record ABOUT an invoice approval, written to the eval store; it never writes the invoice.',
  },
  {
    file: 'ai/evaluation/invoice-edit-delta.ts',
    as: 'ai-plane',
    why: 'Evaluation record of an invoice edit delta; eval store only.',
  },
  {
    file: 'ai/evaluation/invoice-provenance.ts',
    as: 'ai-plane',
    why: 'Evaluation record of invoice field provenance; eval store only.',
  },
  {
    file: 'ai/tasks/estimate-template.ts',
    as: 'violation',
    why: 'repository.create(template) mints a tenant ESTIMATE TEMPLATE — priced, catalog-adjacent, operational — straight from an AI task module with no proposal. Found by the review that relaxed the receiver pattern; it was invisible to the first edition of this guard.',
  },
];

/**
 * Files exempt from the guard entirely, each with the reason.
 *
 * `ai/voice-quality/**` is the Layer-1 corpus / inapp-50 EVAL HARNESS. It
 * lives under `src` only because `npm run voice-quality` and the inapp-50 CI
 * job import it from the built output; it seeds a fixture world (`world.ts`,
 * `runner.ts`) and is never on a caller-facing path. It is exempted by PATH
 * rather than by receiver so an operational write cannot hide behind a
 * harness-shaped name elsewhere.
 */
const EXEMPT_FILE_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  {
    prefix: 'ai/voice-quality/',
    why: 'Layer-1 corpus + inapp-50 eval harness — seeds a fixture world, not a caller-facing AI path.',
  },
];

/**
 * The genuine I1′ violations found on `origin/main` at 2026-09-12. Production
 * AI modules that write an operational entity directly.
 *
 * These are RECORDED, not excused: the `it.fails` case below asserts I1′ as
 * written and fails on exactly this list. Keeping them enumerated means a
 * SIXTH one still breaks the build.
 */
const KNOWN_VIOLATIONS: ReadonlyArray<{ at: string; why: string }> = [
  {
    at: 'ai/skills/find-or-create-customer.ts:116',
    why: 'customerRepo.create — mints a customer row mid-call under actor `system:inbound-call`, with no proposal and no human approval.',
  },
  {
    at: 'ai/skills/find-or-create-lead.ts:122',
    why: 'leadRepo.create — same shape for the lead entity.',
  },
  {
    at: 'ai/skills/patch-owner-through.ts:238',
    why: 'callMeBackRepo.create — creates an owner call-back task row directly from the AI skill.',
  },
  {
    at: 'ai/voice-turn/create-voice-turn-processor.ts:2474',
    why: 'callMeBackRepo.create — same entity from the voice-turn processor.',
  },
  {
    at: 'ai/voice-turn/create-voice-turn-processor.ts:2639',
    why: 'appointmentRepo.update — the E1 revoke path CANCELS a held appointment (`status: canceled`) without a proposal. The strongest of the six: a state-changing write to a scheduled entity.',
  },
  {
    at: 'ai/tasks/estimate-template.ts:97',
    why: 'repository.create(template) — mints a tenant estimate template (priced, catalog-adjacent) from an AI task module with no proposal. Found in review (PR #1063): the bare `repository` receiver was invisible until the entity prefix was made optional.',
  },
];

// ─── Classification ─────────────────────────────────────────────────────────

function isExemptFile(rel: string): boolean {
  return EXEMPT_FILE_PREFIXES.some((e) => rel.startsWith(e.prefix));
}

function receiverBase(receiver: string): string {
  return receiver.toLowerCase();
}

function isAiPlane(write: RepoWrite): boolean {
  if (isGenericReceiver(write.receiver)) {
    return GENERIC_RECEIVER_SITES.some((g) => g.file === write.file && g.as === 'ai-plane');
  }
  const base = receiverBase(write.receiver);
  return AI_PLANE_REPOS.some((r) => base === r.receiver.toLowerCase());
}

/** Writes that must be classified: production AI code, non-AI-plane receiver. */
export function operationalWrites(roots: readonly string[]): RepoWrite[] {
  return findRepositoryWrites(roots)
    .filter((w) => !isExemptFile(w.file))
    .filter((w) => !isAiPlane(w));
}

// ─── The guard ──────────────────────────────────────────────────────────────

describe('§5 I1′ (STRUCTURAL) — no AI module may call an operational repository write', () => {
  it('every repository write under src/ai is classified: AI-plane, exempt harness, or a recorded violation', () => {
    const unclassified = operationalWrites([AI_ROOT]).filter(
      (w) => !KNOWN_VIOLATIONS.some((k) => k.at === w.at),
    );

    expect(
      formatViolations(unclassified),
      [
        'A new repository write appeared under src/ai that is neither AI-plane',
        'nor on the recorded I1′ violation list.',
        '',
        'If it writes an operational entity, it is an I1′ violation: route it',
        'through a typed proposal (D-004) instead. If its target is genuinely',
        'AI-plane, add the receiver to AI_PLANE_REPOS with the reason.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the recorded violations are still exactly where the report says they are', () => {
    const found = operationalWrites([AI_ROOT]).map((w) => w.at);
    for (const known of KNOWN_VIOLATIONS) {
      expect(found, `${known.at} — ${known.why}`).toContain(known.at);
    }
  });

  /**
   * I1′ AS WRITTEN. This is the honest state of the invariant: it does not
   * hold. `it.fails` records that without weakening the guard above and
   * without pretending the tree is clean — when the five call sites are moved
   * behind proposals, this case starts PASSING, which makes `it.fails` itself
   * fail and forces the row to be re-graded.
   *
   * Product gap, reported on #1021 for Fable's sign-off — not fixed here
   * (this lane is test-only).
   */
  it.fails(
    'I1′ as written — zero AI modules write an operational entity (KNOWN GAP: 6 call sites)',
    () => {
      expect(formatViolations(operationalWrites([AI_ROOT]))).toEqual([]);
    },
  );

  // ─── Negative control ─────────────────────────────────────────────────────

  it('NEGATIVE CONTROL — a planted operational write is reported', () => {
    const dir = plantTree('i1-plant', {
      'planted-ai-module.ts': [
        "import type { CustomerRepository } from '../../customers/customer';",
        '',
        'export async function draftSomething(customerRepo: CustomerRepository) {',
        '  // A new AI path that writes a customer directly — exactly what I1′ forbids.',
        "  return customerRepo.create({ id: 'x' } as never);",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = operationalWrites([dir]);
      expect(found).toHaveLength(1);
      expect(found[0].receiver).toBe('customerRepo');
      expect(found[0].method).toBe('create');
      expect(found[0].snippet).toContain('customerRepo.create');
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — the plant is detected through a `this.deps.` receiver chain too', () => {
    const dir = plantTree('i1-plant-deps', {
      'planted-nested.ts': [
        'export class Handler {',
        '  constructor(private deps: { invoiceRepo: { update: Function } }) {}',
        '  async run() {',
        "    await this.deps.invoiceRepo.update('t', 'i', { status: 'paid' });",
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = operationalWrites([dir]);
      expect(found.map((w) => `${w.receiver}.${w.method}`)).toEqual(['invoiceRepo.update']);
    } finally {
      removeTree(dir);
    }
  });

  /**
   * The guard must not be fooled by prose. `src/ai` quotes
   * `missingFields: ['invoiceId']` and repository-write shapes in doc comments
   * constantly; a guard that matched those would be measuring comments.
   */
  it('NEGATIVE CONTROL (inverse) — a repository write that appears only in a comment is NOT reported', () => {
    const dir = plantTree('i1-comment-only', {
      'commented.ts': [
        '/**',
        ' * Historically this called customerRepo.create(customer) directly;',
        ' * it now drafts a proposal instead.',
        ' */',
        '// await leadRepo.create(lead);',
        'export const ok = true;',
        '',
      ].join('\n'),
    });
    try {
      expect(operationalWrites([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('the allowed-exception list is explicit and reasoned (no bare entries)', () => {
    for (const entry of AI_PLANE_REPOS) {
      expect(entry.receiver.length, entry.receiver).toBeGreaterThan(0);
      expect(entry.why.length, entry.receiver).toBeGreaterThan(30);
    }
    for (const entry of EXEMPT_FILE_PREFIXES) {
      expect(entry.why.length, entry.prefix).toBeGreaterThan(30);
    }
    for (const entry of KNOWN_VIOLATIONS) {
      expect(entry.at, entry.at).toMatch(/^ai\/.+\.ts:\d+$/);
      expect(entry.why.length, entry.at).toBeGreaterThan(30);
    }
    for (const entry of GENERIC_RECEIVER_SITES) {
      expect(entry.why.length, entry.file).toBeGreaterThan(40);
    }
  });

  it('every bare-receiver write site is classified by file (the name cannot say what it writes)', () => {
    const generic = findRepositoryWrites([AI_ROOT])
      .filter((w) => !isExemptFile(w.file))
      .filter((w) => isGenericReceiver(w.receiver));
    const unclassified = generic.filter(
      (w) => !GENERIC_RECEIVER_SITES.some((g) => g.file === w.file),
    );
    expect(
      formatViolations(unclassified),
      'A `repo` / `repository` write appeared in a file nobody has classified. The receiver ' +
        'name says nothing about what it writes, so classify the FILE as ai-plane or violation.',
    ).toEqual([]);
    // Not vacuous: the relaxed receiver pattern really does reach these.
    expect(generic.length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL — a bare `repository.create` in an unclassified file is reported', () => {
    const dir = plantTree('i1-generic-receiver', {
      'planted-generic.ts': [
        'export async function save(repository: { create: Function }, row: unknown) {',
        '  return repository.create(row);',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = operationalWrites([dir]);
      expect(found).toHaveLength(1);
      expect(found[0].receiver).toBe('repository');
    } finally {
      removeTree(dir);
    }
  });
});
