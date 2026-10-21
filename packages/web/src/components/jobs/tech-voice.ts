/**
 * The technician job screen's voice update: what one spoken sentence becomes.
 *
 * The words go to the assistant with this job pinned as the open record
 * (pageContext), so "used a capacitor and two hours labor" or "they want a
 * quote for a new condenser" are drafted by the same pipeline as every other
 * surface: priced from the tenant catalog, entity-resolved, and held for
 * approval. Nothing here prices or parses parts.
 *
 * The one thing decided on the device is a SUGGESTED status change, because
 * it maps onto the job's own status buttons. It is only a suggestion: the tech
 * sees it on the confirm card and can untick it before anything is sent.
 */

export type TechStatus = 'en_route' | 'on_site' | 'in_progress' | 'waiting' | 'complete';

// Checked in this order; the first match wins. "Waiting" comes first so that
// "waiting on parts, should be done tomorrow" is waiting, not complete.
const STATUS_PATTERNS: Array<[RegExp, TechStatus]> = [
  [/\b(waiting (?:on|for)|need to order|ordered|back.?order(?:ed)?|getting parts|parts (?:are )?coming|come back)\b/i, 'waiting'],
  [/\b(on my way|heading (?:over|there|out)|leaving now|en route|driving over)\b/i, 'en_route'],
  [/\b(all done|i'?m done|we'?re done|done here|finished up|job(?:'s| is) (?:done|complete|finished)|wrapping up|that'?s it for (?:this|the) job)\b/i, 'complete'],
  [/\b(arrived|on site|i'?m here|we'?re here|starting (?:the )?(?:job|work)|getting started)\b/i, 'in_progress'],
];

// "not done", "almost finished", "should be done tomorrow" never complete a job.
const NOT_DONE_RE =
  /\b(not|isn'?t|aren'?t|won'?t|haven'?t|hasn'?t|almost|nearly|should be|will be|hope to be|tomorrow|later)\b[^.!?]{0,25}\b(done|finished|complete)/i;

export function suggestTechStatus(text: string): TechStatus | undefined {
  for (const [pattern, status] of STATUS_PATTERNS) {
    if (!pattern.test(text)) continue;
    if (status === 'complete' && NOT_DONE_RE.test(text)) continue;
    return status;
  }
  return undefined;
}

export interface TechVoiceDraft {
  id: string;
  title: string;
  proposalType?: string;
  status?: string;
}

export type TechVoiceOutcome =
  | { ok: true; reply: string; draft?: TechVoiceDraft }
  | { ok: false };

/** Send the tech's words to the assistant with this job as the open record. */
export async function sendTechVoiceUpdate(
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>,
  jobId: string,
  transcript: string,
  /**
   * The screen offered a status for these words (ticked or not). Only then is
   * status the tech's call: words the screen did not recognize as a status
   * ("set this job to completed") stay with the assistant, so they draft a
   * status change for approval instead of being dropped.
   */
  statusOffered: boolean,
): Promise<TechVoiceOutcome> {
  try {
    const res = await apiFetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: transcript }],
        inputMode: 'voice',
        pageContext: { entityType: 'job', entityId: jobId },
        // When the screen offered a status, it is the tech's call (the tick
        // box), never the assistant's: an unticked "all done" must not
        // complete the job.
        ...(statusOffered ? { jobStatusHandled: true } : {}),
      }),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as {
      message?: { content?: string; proposal?: TechVoiceDraft | null };
    };
    const reply = data.message?.content?.trim();
    if (!reply) return { ok: false };
    const proposal = data.message?.proposal;
    return proposal?.id ? { ok: true, reply, draft: proposal } : { ok: true, reply };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether the tech's words still need saving as a job note. They do unless
 * the assistant drafted them as a note that is already approved and on its
 * way to the job. A pending note draft has no card on this screen to approve
 * it, so skipping the save would leave the job without the note.
 */
export function needsFieldNote(outcome: TechVoiceOutcome): boolean {
  return !(outcome.ok && outcome.draft?.proposalType === 'add_note' && outcome.draft.status === 'Approved');
}
