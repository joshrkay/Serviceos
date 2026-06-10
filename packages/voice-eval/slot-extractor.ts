/**
 * slot-extractor.ts — offline heuristic slot extractor (CI baseline).
 *
 * Extracts the 5 critical slots (name, address, service_type, time_window,
 * problem_description) from a transcript using deterministic cue patterns. Like
 * the baseline classifier, this is the offline floor — the production extractor
 * (LLM via the gateway) is what targets F1 >= 0.88 in --live mode.
 */

const STREET_SUFFIX = /(Avenue|Ave|Street|St|Boulevard|Blvd|Court|Ct|Drive|Dr|Road|Rd|Lane|Ln|Way|Place|Pl|Terrace|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Trail|Trl)/;

const SERVICE_KEYWORDS: Record<string, RegExp> = {
  hvac: /\b(ac|a\/c|air conditioner|furnace|heat pump|condenser|thermostat|mini split|hvac|cooling|evaporator|air handler|swamp cooler|duct)\b/i,
  plumbing: /\b(water heater|toilet|drain|faucet|sink|sewer|sump|pipe|plumb|garbage disposal|shutoff valve|shower valve|p-trap)\b/i,
  electrical: /\b(breaker|panel|outlet|gfci|electrical|wiring|fixture|ceiling fan|sub-panel|generator)\b/i,
};

export interface ExtractedSlots {
  name?: string;
  address?: string;
  service_type?: string;
  time_window?: string;
  problem_description?: string;
}

export function extractSlots(transcript: string): ExtractedSlots {
  const out: ExtractedSlots = {};

  // name — "this is X" / "This is ... This is X at"
  const name = transcript.match(/this is ([A-Z][a-z]+(?:\s+[A-Z][a-z]+))/);
  if (name) out.name = name[1];

  // address — <number> <Capitalized words> <suffix>
  const addr = transcript.match(new RegExp(`\\b\\d+\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*\\s+${STREET_SUFFIX.source}\\b`));
  if (addr) out.address = addr[0];

  // service_type — max keyword hits
  let best = '', bestN = 0;
  for (const [svc, re] of Object.entries(SERVICE_KEYWORDS)) {
    const n = (transcript.match(new RegExp(re.source, 'gi')) ?? []).length;
    if (n > bestN) { bestN = n; best = svc; }
  }
  if (best) out.service_type = best;

  // time_window — a time expression span
  const tw = transcript.match(/\b((?:tomorrow|today|this (?:morning|afternoon|weekend)|next \w+|first thing tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)[^.?!]*?(?:am|pm|noon|\d(?:\s|$)|morning|afternoon))/i);
  if (tw) out.time_window = tw[1].trim();

  // problem_description — cue-based clause
  const prob =
    transcript.match(/because my ([^.?!]+?)\./i) ||
    transcript.match(/my ([^.?!]+?) and it'?s getting/i) ||
    transcript.match(/status (?:of|on) my ([^.?!]+?)(?: job| and|\.)/i) ||
    transcript.match(/reschedule my appointment for the ([^.?!]+?)\./i);
  if (prob) out.problem_description = prob[1].trim();

  return out;
}
