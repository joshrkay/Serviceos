/**
 * Deterministic `update_job` FIELD parsing — the spoken words → the two
 * canonical enums (`jobStatusSchema` / `jobPrioritySchema`).
 *
 * WHY THIS MODULE EXISTS (in-app 50-case register, `job-02`): "Set Johnson's
 * water heater job to in progress" resolved a `jobId` and nothing else. The
 * classifier's `update_job` entity set is `jobReference` only — the STATUS
 * lives in the caller's own words — so `buildVoiceProposalPayload` minted an
 * `update_job` payload carrying no status/priority/title at all. That payload
 * fails `updateJobPayloadSchema`'s "at least one field to change" refine,
 * which is a WHOLE-OBJECT refine (`path: []`), so `fieldPathsFrom` had nothing
 * to name and the in-app card was persisted with `missingFields: []`:
 * an approve-to-fail proposal — the operator taps approve and the execution
 * handler throws. Parsing the phrase here turns that into either a real edit
 * or an honestly gated one.
 *
 * DELIBERATELY NOT AN LLM CALL. `ai/tasks/job-edit-task.ts`
 * (`UpdateJobTaskHandler`) already owns the LLM drafting leg for the
 * recorded-memo / chat paths and keeps it; this is the LIVE-TURN fallback for
 * the surfaces that reach `buildVoiceProposalPayload` directly with only
 * classifier entities in hand, and it must be synchronous, free and
 * deterministic. It only ever ADDS a field the payload did not already have.
 *
 * NOT A GUESS: every phrase below is an explicit spoken status/priority
 * ("in progress", "on hold", "urgent"). Anything else parses to `{}` and the
 * caller gates with `missingFields` — never a default status.
 *
 * `proposals/` may not import `ai/*` (see voice-payload.ts's module doc), so
 * this lives next to the contract it feeds and `ai/tasks/job-edit-task.ts`
 * imports the normalizers FROM here rather than keeping its own copy of the
 * two value sets.
 */
import { jobStatusSchema, jobPrioritySchema } from '@ai-service-os/shared';

export type JobStatusValue = (typeof jobStatusSchema)['options'][number];
export type JobPriorityValue = (typeof jobPrioritySchema)['options'][number];

const VALID_STATUSES: ReadonlySet<string> = new Set<string>(jobStatusSchema.options);
const VALID_PRIORITIES: ReadonlySet<string> = new Set<string>(jobPrioritySchema.options);

/**
 * Normalize an already-named status value ("In Progress", "in progress") onto
 * the canonical `jobStatusSchema` spelling. Returns undefined for anything the
 * enum doesn't contain — never a nearest guess.
 */
export function normalizeJobStatus(value: unknown): JobStatusValue | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  return VALID_STATUSES.has(normalized) ? (normalized as JobStatusValue) : undefined;
}

/** Priority twin of `normalizeJobStatus`, against `jobPrioritySchema`. */
export function normalizeJobPriority(value: unknown): JobPriorityValue | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return VALID_PRIORITIES.has(normalized) ? (normalized as JobPriorityValue) : undefined;
}

/**
 * Spoken status phrases → canonical status. Ordered longest-idea-first so
 * "not started" can never be read as "started".
 *
 * `on hold` maps to `scheduled` deliberately: `jobStatusSchema` has no
 * `on_hold` member (new / scheduled / dispatched / in_progress / completed /
 * invoiced / closed / canceled), and inventing one here would put a value in
 * the payload that the jobs table's CHECK constraint rejects at execution —
 * the exact approve-to-fail shape this module exists to remove. A paused job
 * is back on the calendar and off the truck, which is `scheduled`.
 */
const STATUS_PHRASES: ReadonlyArray<{ re: RegExp; status: JobStatusValue }> = [
  { re: /\bnot\s+started\b/i, status: 'new' },
  { re: /\bin\s+progress\b/i, status: 'in_progress' },
  { re: /\b(?:start(?:ed|ing)?|under\s+way|underway)\b/i, status: 'in_progress' },
  { re: /\b(?:complete[d]?|done|finish(?:ed)?|wrapped\s+up)\b/i, status: 'completed' },
  { re: /\bon\s+hold\b/i, status: 'scheduled' },
  { re: /\b(?:pause[d]?|pausing)\b/i, status: 'scheduled' },
  { re: /\bcancel(?:l?ed|l?ing)?\b/i, status: 'canceled' },
  { re: /\bdispatch(?:ed)?\b/i, status: 'dispatched' },
  { re: /\bschedul(?:ed|e)\b/i, status: 'scheduled' },
  { re: /\binvoiced\b/i, status: 'invoiced' },
  { re: /\bclosed\b/i, status: 'closed' },
];

/**
 * Spoken priority phrases. ANCHORED to the word "priority" (either side of the
 * value) so an ordinary "urgent" inside a job description — "the urgent leak
 * job" — is never read as a priority CHANGE. "medium" and "normal" both land
 * on `normal`, the canonical middle rung (`jobPrioritySchema` has no
 * `medium`, unlike `createJobPayloadSchema`'s own independent enum).
 */
const PRIORITY_WORDS: ReadonlyArray<{ re: RegExp; priority: JobPriorityValue }> = [
  { re: /\burgent\b/i, priority: 'urgent' },
  { re: /\bhigh\b/i, priority: 'high' },
  { re: /\b(?:medium|normal)\b/i, priority: 'normal' },
  { re: /\blow\b/i, priority: 'low' },
];
const PRIORITY_CONTEXT = /\bpriorit(?:y|ies)\b/i;

export interface ParsedJobEditFields {
  status?: JobStatusValue;
  priority?: JobPriorityValue;
}

/**
 * Parse the operator's own words for an explicit `update_job` field change.
 *
 * Returns `{}` when nothing was explicitly said — the caller must then gate
 * (`missingFields`) rather than mint an edit that changes nothing.
 *
 * `title` is deliberately NOT parsed: a spoken rename ("rename the Smith job
 * to …") is free text whose boundaries a regex cannot find without guessing at
 * the new title, and a WRONG title is a silent data corruption rather than a
 * gate. That phrasing stays on `UpdateJobTaskHandler`'s LLM leg, which sees
 * the whole transcript.
 */
export function parseJobEditFields(text: string | undefined): ParsedJobEditFields {
  if (typeof text !== 'string' || text.trim().length === 0) return {};
  const out: ParsedJobEditFields = {};

  for (const { re, status } of STATUS_PHRASES) {
    if (re.test(text)) {
      out.status = status;
      break;
    }
  }

  if (PRIORITY_CONTEXT.test(text)) {
    for (const { re, priority } of PRIORITY_WORDS) {
      if (re.test(text)) {
        out.priority = priority;
        break;
      }
    }
  }

  return out;
}
