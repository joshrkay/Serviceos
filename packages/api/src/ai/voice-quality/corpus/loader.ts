/**
 * VQ-008 — Corpus loader.
 *
 * Walks `corpus/scripts/<bucket>/*.json`, parses each file through
 * `VoiceQualityScriptSchema`, and returns a sorted (by `id`) array of
 * scripts. Invalid files surface as an aggregated error so authors
 * see every malformed file in a single run rather than fixing them
 * one at a time.
 *
 * Default corpus root is the sibling `scripts/` directory next to this
 * file. Tests override the root with a temp directory so they don't
 * depend on the real corpus existing yet (Phase-2 stories author it).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  VoiceQualityScriptSchema,
  type VoiceQualityScript,
} from '../schema';
import { isAffirmation } from '../../agents/customer-calling/confirm-turn';

/**
 * Default scripts directory. Co-located so importing `loadCorpus()`
 * with no args produces the canonical Layer-1 corpus.
 */
export function defaultCorpusRoot(): string {
  return path.resolve(__dirname, 'scripts');
}

/**
 * The Layer 1 corpus: every authored script, read through the phone persona
 * for the Gather surface (`asPhonePersona`) — the transport the text-mode
 * driver is the twin of. Throws, as `loadRawCorpus` does, when any file is
 * malformed.
 */
export function loadCorpus(corpusRoot?: string): VoiceQualityScript[] {
  return loadRawCorpus(corpusRoot).map((s) => asPhonePersona(s, 'gather'));
}

/**
 * Walk every bucket subdirectory under `corpusRoot`, parse every
 * `*.json` file in each, and return the validated scripts exactly as
 * authored (ids and turns untouched), sorted by id.
 *
 * If any file fails to parse (either invalid JSON or schema
 * mismatch), we collect every failure and throw a single aggregated
 * error containing all of them. Authors fixing a corpus see every
 * problem in one pass.
 */
function loadRawCorpus(corpusRoot?: string): VoiceQualityScript[] {
  const root = corpusRoot ?? defaultCorpusRoot();
  if (!fs.existsSync(root)) {
    return [];
  }

  const failures: { file: string; reason: string }[] = [];
  const scripts: VoiceQualityScript[] = [];

  // Walk top-level entries — each subdir is a bucket. Non-directory
  // entries are ignored (the corpus may contain a README or .gitkeep
  // alongside the buckets).
  const buckets = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name));

  for (const bucket of buckets) {
    const files = fs
      .readdirSync(bucket, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.json'))
      .map((f) => path.join(bucket, f.name));

    for (const file of files) {
      try {
        scripts.push(loadScript(file));
      } catch (err) {
        failures.push({
          file,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (failures.length > 0) {
    const summary = failures
      .map((f) => `  ${f.file}: ${f.reason}`)
      .join('\n');
    throw new Error(
      `loadCorpus: ${failures.length} script file(s) failed validation:\n${summary}`,
    );
  }

  scripts.sort((a, b) => a.id.localeCompare(b.id));
  return scripts;
}

/**
 * VQ2-014 — Layer 2 corpus loader. Returns the subset of the corpus where
 * `layer2Eligible === true`, as the media-streams surface runs it.
 * Layer-2-only scripts (those with `layer2Only: true`) are included here
 * even though Layer 1 skips them, so the Layer 2 runner exercises the full
 * audio-only corpus.
 */
export function loadLayer2Corpus(corpusRoot?: string): VoiceQualityScript[] {
  return loadRawCorpus(corpusRoot)
    .filter((s) => s.layer2Eligible)
    .map((s) => asPhonePersona(s, 'media_streams'));
}

/**
 * #1331 / #1587 — a corpus script as the production phone surface runs it.
 * Both lanes drive `createVoiceTurnProcessor().speechTurn` (Layer 2 through
 * media streams, Layer 1 through the text-mode driver), so both read the
 * corpus through this one view; `loadCorpus` applies it once.
 * (1) Owner line (D-028 follow-up, owner decision 2026-10-01) — a script that asks
 * operator-only actions declares `fixtures.tenant.harnessOperatorTaxonomy`.
 * The production processor correctly refuses operator actions on a
 * customer's line (S1), so the script runs as the OWNER line
 * (`callerIsOwner` → RV-070 ownerSession, S2 surface) — the real production
 * surface for an owner asking these actions by phone. Drafting needs no
 * voice PIN; the PIN gates owner APPROVAL of money movement.
 * (2) Record ids become UUIDs — see `withUuidRecordIds`.
 * (3) Every write turn answers the phone readback — see `answerPhoneReadback`.
 */
export type PhoneSurface = 'gather' | 'media_streams';

export function asPhonePersona(
  script: VoiceQualityScript,
  surface: PhoneSurface,
): VoiceQualityScript {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  const owner = tenant.harnessOperatorTaxonomy === true;
  const withUuids = withUuidRecordIds(script);
  return {
    ...withUuids,
    ...(owner ? { callerIsOwner: true } : {}),
    turns: withUuids.turns.flatMap((turn, i, all) =>
      answerPhoneReadback(turn, all[i + 1], surface),
    ),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A record-id key in a fixture row: `id` or `<x>Id` — never `tenantId`. */
function isRecordIdKey(key: string): boolean {
  return key === 'id' || (key.endsWith('Id') && key !== 'tenantId');
}

/** Stable name-based UUID (v5 layout over sha1) for a readable fixture id. */
function stableUuid(readable: string): string {
  const h = createHash('sha1').update(`voice-quality-fixture:${readable}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * #1331 — production payload contracts and lookups validate record ids as
 * UUIDs; corpus fixtures are authored with readable ids
 * ("cust_02_add_material_owner"). Against the production engine those ids
 * failed every write proposal's contract (`customerId: Invalid uuid`, so the
 * draft was gated) and broke lookup_balance outright. Every readable record id
 * found in a fixture row is mapped to a stable UUID, and every string equal to
 * it — in the fixtures and in the turns' expected slots — is rewritten, so
 * references stay intact.
 */
function withUuidRecordIds(script: VoiceQualityScript): VoiceQualityScript {
  const mapping = new Map<string, string>();
  for (const [key, rows] of Object.entries(script.fixtures)) {
    if (key === 'tenant' || !Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
        if (isRecordIdKey(field) && typeof value === 'string' && !UUID_RE.test(value)) {
          mapping.set(value, stableUuid(value));
        }
      }
    }
  }
  if (mapping.size === 0) return script;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return mapping.get(value) ?? value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewrite(v)]),
      );
    }
    return value;
  };
  return {
    ...script,
    fixtures: Object.fromEntries(
      Object.entries(script.fixtures).map(([k, v]) => [k, k === 'tenant' ? v : rewrite(v)]),
    ) as VoiceQualityScript['fixtures'],
    turns: script.turns.map((turn) =>
      turn.expected.slots
        ? {
            ...turn,
            expected: {
              ...turn.expected,
              slots: rewrite(turn.expected.slots) as typeof turn.expected.slots,
            },
          }
        : turn,
    ),
  };
}

/** The caller's answer to the phone engine's yes/no readback. */
const READBACK_YES = "Yes, that's right.";

/**
 * #1331 — the phone turn engine (the voice-turn processor) never drafts a
 * write on the request turn: it reads the request back ("Just to confirm — …
 * Is that right?") and drafts only on the caller's yes. The corpus authors a
 * write as one request turn, so the caller answers the readback here. The
 * request turn keeps the intent / proposal / slot expectations (the drafted
 * proposal is still that turn's proposal); the drafted-reply copy and any
 * hangup move to the answer.
 */
function answerPhoneReadback(
  turn: VoiceQualityScript['turns'][number],
  next: VoiceQualityScript['turns'][number] | undefined,
  surface: PhoneSurface,
): VoiceQualityScript['turns'] {
  if (turn.expected.proposalType === undefined) return [turn];
  // Raised without a readback: a clarification the engine mints itself (an
  // ambiguous caller-ID), the after-hours booking callback (D-040 §1, minted
  // on the request turn), and the Gather transport's one-turn create_customer
  // flow (coverage-table.ts: P18-001; media streams takes the readback).
  if (turn.expected.proposalType === 'voice_clarification') return [turn];
  if (turn.expected.proposalType === 'callback') return [turn];
  if (turn.expected.proposalType === 'create_customer' && surface === 'gather') return [turn];
  // The script already answers the readback itself.
  if (next && isAffirmation(next.caller)) return [turn];
  const { spokenAnswerMatches, ...requestExpected } = turn.expected;
  return [
    { ...turn, expected: requestExpected, hangupAfter: false },
    {
      caller: READBACK_YES,
      expected: spokenAnswerMatches !== undefined ? { spokenAnswerMatches } : {},
      hangupAfter: turn.hangupAfter,
    },
  ];
}

/**
 * Load and validate a single script file. Throws on filesystem
 * errors, malformed JSON, or schema validation errors. Each error
 * carries the file path so call-sites (and CLI tooling) can produce
 * actionable messages.
 */
export function loadScript(scriptPath: string): VoiceQualityScript {
  const raw = fs.readFileSync(scriptPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadScript: invalid JSON in ${scriptPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = VoiceQualityScriptSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `loadScript: schema validation failed for ${scriptPath}: ${result.error.message}`,
    );
  }
  return result.data;
}
