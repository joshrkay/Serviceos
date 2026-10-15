/**
 * Extraction of caller utterances (+ whether the production baseline fired on
 * them) from call logs, for the TypeSafe frustration spike. Read-only and
 * source-agnostic: `UtteranceSource` is satisfied by the in-memory fixture in
 * tests today and by a read-only SQL source later (call_transcript_turns +
 * audit_events `agent.calling.*.keyword_frustration|llm_sentiment`).
 *
 * Scrubbing is a best-effort regex pass (phones, emails, card numbers, street
 * addresses). It does NOT remove names or spoken-out digits — human review of
 * the output file is still required before it is sent to any third party.
 */
import { prng, sampleN } from './seeded';

export interface CallerTurn {
  tenantId: string;
  callSid: string;
  sessionId: string;
  turnIndex: number;
  text: string;
  /** epoch ms */
  at: number;
}

export interface FrustrationEvent {
  tenantId: string;
  callSid: string;
  sessionId: string;
  source: 'keyword' | 'llm_sentiment';
  /** epoch ms */
  at: number;
}

export interface WindowQuery {
  tenantId: string;
  from: number;
  to: number;
}

export interface UtteranceSource {
  listCallerTurns(q: WindowQuery): Promise<CallerTurn[]>;
  listFrustrationEvents(q: WindowQuery): Promise<FrustrationEvent[]>;
}

export interface ExtractedUtterance {
  text: string;
  firedBaseline: boolean;
  eventSource?: FrustrationEvent['source'];
}

const STREET_SUFFIX =
  'Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Highway|Hwy';

export function scrubPii(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[EMAIL]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[CARD]')
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]')
    .replace(
      new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z0-9'.]+\\s+){1,3}(?:${STREET_SUFFIX})\\b\\.?`, 'gi'),
      '[ADDRESS]'
    );
}

// The voice session id identifies one call leg; `audit_events` rows may carry no
// callSid (in-app sessions), so the join key is tenant + session only.
const callKey = (r: { tenantId: string; sessionId: string }) => `${r.tenantId}\u0000${r.sessionId}`;

export async function extractFrustrationUtterances(
  source: UtteranceSource,
  opts: WindowQuery & { limit: number; seed: number }
): Promise<ExtractedUtterance[]> {
  const q = { tenantId: opts.tenantId, from: opts.from, to: opts.to };
  const [rawTurns, events] = await Promise.all([
    source.listCallerTurns(q),
    source.listFrustrationEvents(q),
  ]);

  // Defense in depth: never let a source leak another tenant's rows into the file.
  const turns = rawTurns
    .filter((t) => t.tenantId === opts.tenantId && t.text.trim() !== '')
    .sort((a, b) => a.at - b.at || a.turnIndex - b.turnIndex);

  const byCall = new Map<string, CallerTurn[]>();
  for (const t of turns) {
    const k = callKey(t);
    const list = byCall.get(k);
    if (list) list.push(t);
    else byCall.set(k, [t]);
  }

  // The frustrating utterance is the latest caller turn at or before the event.
  const fired = new Map<CallerTurn, FrustrationEvent['source']>();
  for (const e of events) {
    if (e.tenantId !== opts.tenantId) continue;
    const candidates = byCall.get(callKey(e)) ?? [];
    let hit: CallerTurn | undefined;
    for (const t of candidates) if (t.at <= e.at) hit = t;
    if (hit && !fired.has(hit)) fired.set(hit, e.source);
  }

  const rand = prng(opts.seed);
  const firedTurns = turns.filter((t) => fired.has(t));
  const otherTurns = turns.filter((t) => !fired.has(t));
  const keptFired = firedTurns.length > opts.limit ? sampleN(firedTurns, opts.limit, rand) : firedTurns;
  const keptOthers = sampleN(otherTurns, opts.limit - keptFired.length, rand);

  return [...keptFired, ...keptOthers]
    .sort((a, b) => a.at - b.at || a.turnIndex - b.turnIndex)
    .map((t) => ({
      text: scrubPii(t.text).trim(),
      firedBaseline: fired.has(t),
      ...(fired.has(t) ? { eventSource: fired.get(t) } : {}),
    }))
    .filter((r) => r.text !== '');
}

/** The one-utterance-per-line file the sampler (`sample-for-labeling.ts`) reads. */
export function toUtterancesFile(rows: readonly ExtractedUtterance[]): string {
  return rows.map((r) => r.text.replace(/\s*[\r\n]+\s*/g, ' ')).join('\n') + '\n';
}
