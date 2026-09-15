/**
 * VQ — cassette staleness analysis.
 *
 * The replay gateway falls back to a fuzzy (schema + system-fingerprint +
 * user) match whenever a recorded request hash misses — which happens by
 * design as the classifier's intent taxonomy drifts over the corpus's life
 * (see cassette-gateway.ts `findFallbackEntry`). That fallback keeps the
 * launch gate green, but it is otherwise SILENT: nothing surfaces how much of
 * the corpus is served by stale recordings rather than exact replays, so a
 * maintainer has no signal for when to re-record.
 *
 * This module turns that into a deterministic, offline metric. It groups each
 * cassette's entries by the SAME key the fallback matches on, so a call's
 * "accretion depth" (how many recordings share one logical call) is a direct
 * count of how many times that call has drifted and been re-recorded. Paired
 * with the newest recording's age, it answers "how stale is the corpus, and
 * which scripts lean hardest on the fallback" — with no LLM calls and no
 * pipeline run, just the committed cassette JSON.
 */
import {
  lastUserContentFromPromptString,
  systemFingerprintFromPromptString,
  type CassetteEntry,
} from './cassette-gateway';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CassetteInput {
  scriptId: string;
  entries: CassetteEntry[];
}

export interface StalenessThresholds {
  /** A cassette whose newest recording is older than this (days) is stale. */
  maxAgeDays: number;
  /** A single logical call re-recorded more than this many times is stale. */
  maxDepth: number;
}

export const DEFAULT_THRESHOLDS: StalenessThresholds = {
  maxAgeDays: 14,
  maxDepth: 3,
};

export interface CassetteStaleness {
  scriptId: string;
  entryCount: number;
  /** Distinct (schema, system-fp, user) logical calls. */
  callCount: number;
  /** Deepest accretion across calls = (drift re-records + 1) for that call. */
  maxDepth: number;
  /** Calls that have drifted at least once (depth >= 2). */
  driftedCalls: number;
  newestRecordedAt: string | null;
  oldestRecordedAt: string | null;
  ageDays: number | null;
  /** Freshness signal: newest recording older than the age threshold → re-record. */
  stale: boolean;
  /** Bloat signal: a call carries more than the depth threshold of recordings,
   *  i.e. several superseded ones the fallback never returns → prune via refresh. */
  deeplyAccreted: boolean;
  reasons: string[];
}

export interface StalenessReport {
  generatedAt: string;
  thresholds: StalenessThresholds;
  cassetteCount: number;
  totalEntries: number;
  /** Cassettes where some logical call has >1 recording (drifted at least once). */
  accretedCassettes: number;
  /** Cassettes carrying a call with more recordings than the depth threshold. */
  deeplyAccretedCassettes: number;
  /** Cassettes whose newest recording is older than the age threshold. */
  staleCassettes: number;
  newestRecordedAt: string | null;
  oldestRecordedAt: string | null;
  medianAgeDays: number | null;
  /** Per-cassette detail, most-stale first. */
  cassettes: CassetteStaleness[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Order ISO timestamp strings chronologically (not lexically). */
function chronologicalRecordedAts(raws: string[]): string[] {
  return raws
    .map((raw) => ({ raw, t: Date.parse(raw) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.raw);
}

/**
 * The same "one logical call" key the replay fallback narrows on: response
 * schema + first-sentence system fingerprint + last user message. Entries
 * sharing it are re-recordings of one call as its prompt drifted.
 */
function callKey(entry: CassetteEntry): string {
  const schema = entry.request.schema;
  const fp = systemFingerprintFromPromptString(entry.request.prompt) ?? '(no-system)';
  const user = lastUserContentFromPromptString(entry.request.prompt) ?? '(no-user)';
  // Structured (not delimiter-joined) so a "::" inside a fingerprint or user
  // message can't shift field boundaries and collide two distinct calls.
  return JSON.stringify([schema, fp, user]);
}

function analyzeCassette(
  input: CassetteInput,
  now: Date,
  thresholds: StalenessThresholds,
): CassetteStaleness {
  const entries = input.entries ?? [];

  const byCall = new Map<string, number>();
  for (const e of entries) {
    const key = callKey(e);
    byCall.set(key, (byCall.get(key) ?? 0) + 1);
  }
  let maxDepth = 0;
  let driftedCalls = 0;
  for (const depth of byCall.values()) {
    if (depth > maxDepth) maxDepth = depth;
    if (depth >= 2) driftedCalls++;
  }

  // Parse timestamps once and order them chronologically (not lexically — a
  // bare string .sort() would mis-rank a hand-edited offset timestamp). A
  // non-empty but unparseable recordedAt is surfaced loudly rather than
  // silently treated as fresh: `new Date('bad').getTime()` is NaN, and
  // `Math.max(0, NaN)` is NaN, which `NaN > maxAge` would read as "not stale".
  const rawRecordedAts = entries
    .map((e) => e.recordedAt)
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
  const parsedAts = rawRecordedAts
    .map((raw) => ({ raw, t: Date.parse(raw) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const malformedCount = rawRecordedAts.length - parsedAts.length;
  const newest = parsedAts.length ? parsedAts[parsedAts.length - 1]! : null;
  const newestRecordedAt = newest ? newest.raw : null;
  const oldestRecordedAt = parsedAts.length ? parsedAts[0]!.raw : null;
  const ageDays = newest ? Math.max(0, (now.getTime() - newest.t) / DAY_MS) : null;

  const reasons: string[] = [];
  const staleByAge = ageDays !== null && ageDays > thresholds.maxAgeDays;
  const deeplyAccreted = maxDepth > thresholds.maxDepth;
  const stale = staleByAge || malformedCount > 0;
  if (staleByAge) {
    reasons.push(`newest recording ${round1(ageDays!)}d old (> ${thresholds.maxAgeDays}d) — re-record`);
  }
  if (malformedCount > 0) {
    reasons.push(`${malformedCount} unparseable recordedAt timestamp(s) — re-record`);
  }
  if (deeplyAccreted) {
    reasons.push(
      `a call has ${maxDepth} recordings (> ${thresholds.maxDepth}); ${maxDepth - 1} superseded — prune via refresh`,
    );
  }

  return {
    scriptId: input.scriptId,
    entryCount: entries.length,
    callCount: byCall.size,
    maxDepth,
    driftedCalls,
    newestRecordedAt,
    oldestRecordedAt,
    ageDays: ageDays === null ? null : round1(ageDays),
    stale,
    deeplyAccreted,
    reasons,
  };
}

/**
 * Analyze a set of cassettes for drift/staleness. Pure: deterministic given
 * `inputs` + `now`, so it is unit-testable without touching the filesystem.
 */
export function analyzeCassetteStaleness(
  inputs: CassetteInput[],
  now: Date = new Date(),
  thresholds: StalenessThresholds = DEFAULT_THRESHOLDS,
): StalenessReport {
  const cassettes = inputs
    .map((c) => analyzeCassette(c, now, thresholds))
    // Most-stale first: by age desc (unknown age last), then deepest accretion.
    .sort((a, b) => {
      const ageA = a.ageDays ?? -1;
      const ageB = b.ageDays ?? -1;
      if (ageB !== ageA) return ageB - ageA;
      return b.maxDepth - a.maxDepth;
    });

  const sortedRecordedAts = chronologicalRecordedAts(
    cassettes.flatMap((c) => [c.newestRecordedAt, c.oldestRecordedAt]).filter((r): r is string => r !== null),
  );
  const ages = cassettes.map((c) => c.ageDays).filter((a): a is number => a !== null);
  const med = median(ages);

  return {
    generatedAt: now.toISOString(),
    thresholds,
    cassetteCount: cassettes.length,
    totalEntries: cassettes.reduce((sum, c) => sum + c.entryCount, 0),
    accretedCassettes: cassettes.filter((c) => c.maxDepth >= 2).length,
    deeplyAccretedCassettes: cassettes.filter((c) => c.deeplyAccreted).length,
    staleCassettes: cassettes.filter((c) => c.stale).length,
    newestRecordedAt: sortedRecordedAts.length ? sortedRecordedAts[sortedRecordedAts.length - 1]! : null,
    oldestRecordedAt: sortedRecordedAts.length ? sortedRecordedAts[0]! : null,
    medianAgeDays: med === null ? null : round1(med),
    cassettes,
  };
}

/**
 * Render a human-readable report. Shows the flagged (stale or accreted)
 * cassettes — the actionable ones — and summarizes the rest as fresh.
 */
export function formatStalenessReport(report: StalenessReport): string {
  const lines: string[] = [];
  lines.push('# Voice-quality cassette staleness');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(
    `Cassettes: ${report.cassetteCount} | entries: ${report.totalEntries} | ` +
      `accreted (a call re-recorded ≥1×): ${report.accretedCassettes} | ` +
      `deeply accreted (depth > ${report.thresholds.maxDepth}, prunable): ${report.deeplyAccretedCassettes} | ` +
      `stale by age (> ${report.thresholds.maxAgeDays}d): ${report.staleCassettes}`,
  );
  lines.push(
    `Recording span: ${report.oldestRecordedAt ?? 'n/a'} … ${report.newestRecordedAt ?? 'n/a'} | ` +
      `median age: ${report.medianAgeDays ?? 'n/a'}d`,
  );
  lines.push('');

  const flagged = report.cassettes.filter((c) => c.stale || c.deeplyAccreted);
  if (flagged.length === 0) {
    lines.push('No stale or deeply-accreted cassettes — corpus is fresh. ✅');
    return lines.join('\n');
  }

  const MAX_ROWS = 25;
  const shown = flagged.slice(0, MAX_ROWS);
  lines.push('| Script | Entries | Calls | Max depth | Drifted calls | Age (d) | Flag |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | :---: |');
  for (const c of shown) {
    const flag = [c.stale ? 'age⚠️' : '', c.deeplyAccreted ? 'depth🗂️' : ''].filter(Boolean).join(' ');
    lines.push(
      `| ${c.scriptId} | ${c.entryCount} | ${c.callCount} | ${c.maxDepth} | ${c.driftedCalls} | ` +
        `${c.ageDays ?? 'n/a'} | ${flag} |`,
    );
  }
  if (flagged.length > MAX_ROWS) {
    lines.push('');
    lines.push(`…and ${flagged.length - MAX_ROWS} more flagged cassette(s).`);
  }
  const freshCount = report.cassetteCount - flagged.length;
  if (freshCount > 0) {
    lines.push('');
    lines.push(`…and ${freshCount} fresh cassette(s) (single recording per call, within age threshold).`);
  }
  return lines.join('\n');
}

export interface CassettePruneResult {
  /** Survivors, in their ORIGINAL relative file order (unchanged). */
  kept: CassetteEntry[];
  /** Removed entries — not (re)written by the refresh pass that just ran. */
  pruned: CassetteEntry[];
}

/**
 * Keep only entries (re)written at or after `cutoffIso`; prune the rest.
 *
 * REJECTED DESIGN, kept here as a record of why (2026-08-09) — an earlier
 * version of this function grouped entries by `callKey` (the SAME
 * (schema, system-fingerprint, last-user-message) key the replay fallback
 * matches on — see `findFallbackEntry`, `analyzeCassette` above) and kept
 * only `pickNewestRecording` per group. That looked airtight — a hash
 * appears at most once per cassette (`CassetteLLMGateway.recordOrRefresh`
 * enforces it), and fallback replay only ever resolves a group via
 * `pickNewestRecording` — but it silently assumed at most ONE currently-
 * live hash per callKey group. That assumption is FALSE in this corpus:
 * running it against the real cassettes found scripts (e.g.
 * `spam-create-customer`) where the SAME (schema, fp, last-user-message)
 * triple legitimately produces TWO DIFFERENT live requests every single
 * refresh (traced to two distinct call sites sharing an utterance, one
 * with an extra context section the other lacks) — `callKey` is a lossy
 * fallback-matching heuristic, not a true identity, and grouping-based
 * pruning discarded one of the two live entries, breaking strict replay
 * (`cassette drift` failures) the very next run. Proven by an actual
 * grouping-based prune run against the committed corpus, which took the
 * replay suite from 73/73 to 36/73 — see
 * scripts/seed-voice-quality-cassettes.ts's `--prune` doc comment.
 *
 * (ACCURACY NOTE, review follow-up N2, 2026-08-09 — this paragraph is the
 * safety argument for a tool that deletes committed data, so its details
 * have to be checkable, and three of them were not. It used to cite "the
 * seven `pruneCassetteEntries`-era tests below": `pruneCassetteEntries`
 * exists nowhere in the tree — the rejected design was never committed
 * under that name — and the tests below number eleven and exercise THIS
 * design, not the rejected one. It also called the 73/73 -> 36/73 run a
 * "`--prune` dry run"; it was a real prune, and no dry-run mode existed at
 * the time. One does now: `--dry-run` on the seed script, added by the same
 * review, and it is the documented required first step.)
 *
 * THIS design sidesteps the whole problem by not grouping at all: a
 * cutoff timestamp captured immediately BEFORE an authoritative refresh
 * pass (the REAL `npm run voice-quality:refresh` — i.e. `vitest run -c
 * vitest.voice-quality.config.ts` with `VOICE_QUALITY_CASSETTE_MODE=
 * refresh`, not a hand-rolled re-implementation of it — see the caller)
 * is compared against each entry's own `recordedAt`. `CassetteLLMGateway.
 * recordOrRefresh` bumps `recordedAt` to "now" for EVERY hash it touches
 * in refresh mode, whether that hash already existed or is brand new —
 * so after a full refresh pass, EVERY currently-reachable hash (via
 * strict OR fallback replay — fallback can only ever pick among entries
 * that exist, and a freshly-touched entry is, if still live, always at
 * least as new as any stale sibling) has `recordedAt >= cutoffIso`,
 * REGARDLESS of how many live variants share a callKey. Anything older
 * was not reproduced by that authoritative pass and is safe to drop.
 *
 * Pure and side-effect-free: callers own capturing `cutoffIso`, running
 * the refresh, and reading/writing the cassette file.
 *
 * THROWS on a cutoff that does not parse (review follow-up J5). Entry
 * timestamps are guarded meticulously below; leaving the one parameter that
 * decides the BLAST RADIUS unguarded was the asymmetry worth fixing. With
 * `cutoffMs = NaN`, `recordedMs >= NaN` is false for EVERY entry, so a
 * typo'd cutoff quietly returned `{kept: [], pruned: everything}` — the
 * maximally destructive answer — from a delete-deciding function. Fail
 * closed on the parameter that decides what dies.
 */
export function pruneEntriesBefore(entries: CassetteEntry[], cutoffIso: string): CassettePruneResult {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(
      `pruneEntriesBefore: cutoff is not a parseable timestamp (${JSON.stringify(cutoffIso)}). ` +
        'Refusing to prune — an unparseable cutoff would prune every entry.',
    );
  }
  const kept: CassetteEntry[] = [];
  const pruned: CassetteEntry[] = [];
  for (const e of entries) {
    // Compared as parsed instants, NOT raw strings — a malformed
    // recordedAt (e.g. "not-a-date") can sort lexically AFTER a valid
    // ISO timestamp (`'n' > '2'`), which a plain string `>=` would
    // misread as "fresh." A missing/malformed recordedAt can never prove
    // "touched by this refresh" — treat it as prunable rather than
    // silently keeping it (mirrors analyzeCassette's own "unparseable
    // timestamp is surfaced, never treated as fresh" posture above).
    const recordedMs = typeof e.recordedAt === 'string' ? Date.parse(e.recordedAt) : NaN;
    if (Number.isFinite(recordedMs) && recordedMs >= cutoffMs) {
      kept.push(e);
    } else {
      pruned.push(e);
    }
  }
  return { kept, pruned };
}
