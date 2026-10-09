/**
 * P18-001 — detect a Twilio `From` value that represents a withheld /
 * blocked / private caller-id. Twilio surfaces these as common literal
 * strings; an empty string signals "we never recorded one". Returns true
 * ONLY for explicitly blocked indicators — a plain missing string returns
 * false so the caller can prompt for a callback rather than assuming the
 * caller chose to withhold.
 *
 * #1601 step 2 — the one copy. It lived verbatim in both
 * `telephony/twilio-adapter.ts` and `ai/voice-turn/create-voice-turn-processor.ts`
 * (the processor re-implemented it to avoid importing the adapter); both now
 * import it from here. Pure: no deps, no I/O.
 */
export function isBlockedCallerId(from: string | undefined): boolean {
  if (!from) return false;
  const v = from.trim().toLowerCase();
  if (v.length === 0) return false;
  return (
    v === 'restricted' ||
    v === 'private' ||
    v === 'blocked' ||
    v === 'unknown' ||
    v === 'anonymous' ||
    v === 'unavailable'
  );
}
