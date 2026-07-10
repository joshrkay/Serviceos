/**
 * Voice command matching for navigation and common actions.
 * Returns a matched route if the transcript matches a known command,
 * otherwise returns null to fall through to the assistant.
 */

interface CommandMatch {
  route: string;
  label: string;
}

// Filler words allowed between a creation verb and its noun ("add a new
// customer", "create another estimate"). Kept tight and contiguous so that
// dictated prose like "add a note that the customer wasn't home" does NOT
// read as "add … customer" — the run of fillers breaks at "note".
const FILLER = String.raw`(?:(?:a|an|the|new|another)\s+)*`;

const COMMANDS: { patterns: RegExp; route: string; label: string }[] = [
  // Navigation — an explicit navigation verb is required, and every noun
  // alternation is grouped. Previously the alternations were unparenthesized
  // (e.g. `.*schedule\b|calendar\b`), so the trailing branch matched the bare
  // keyword anywhere in a sentence and hijacked ordinary dictation.
  { patterns: /\b(show|open|go to|see)\b.*(today'?s?\s+)?jobs?\b/i,          route: '/jobs',      label: 'Opening jobs' },
  { patterns: /\b(show|open|go to|see)\b.*\b(schedule|calendar)\b/i,        route: '/schedule',  label: 'Opening schedule' },
  { patterns: /\b(show|open|go to|see)\b.*\b(customers?|clients?)\b/i,      route: '/customers', label: 'Opening customers' },
  { patterns: /\b(show|open|go to|see)\b.*\b(estimates?|quotes?)\b/i,       route: '/estimates', label: 'Opening estimates' },
  { patterns: /\b(show|open|go to|see)\b.*\b(invoices?|billing)\b/i,        route: '/invoices',  label: 'Opening invoices' },
  // Home/dashboard: anchored to the whole phrase. "home" is too common a word
  // to match mid-sentence ("the customer wasn't home" must NOT navigate).
  { patterns: /^(go\s+(to\s+)?)?(home|dashboard)$/i,                        route: '/',          label: 'Going home' },

  // Creation shortcuts — the verb must be followed (through optional fillers)
  // directly by the noun, so long dictated notes that merely contain the noun
  // don't trigger a create navigation.
  { patterns: new RegExp(String.raw`\b(new|create|add)\s+${FILLER}job\b`, 'i'),                 route: '/jobs/new',      label: 'Creating new job' },
  { patterns: new RegExp(String.raw`\b(new|create|add)\s+${FILLER}(estimate|quote)\b`, 'i'),    route: '/estimates/new', label: 'Creating new estimate' },
  { patterns: new RegExp(String.raw`\b(new|create|add)\s+${FILLER}(customer|client)\b`, 'i'),   route: '/customers/new', label: 'Adding new customer' },

  // Direct page matches (less specific — checked last)
  { patterns: /^jobs?$/i,                                               route: '/jobs',        label: 'Opening jobs' },
  { patterns: /^schedule$/i,                                            route: '/schedule',    label: 'Opening schedule' },
  { patterns: /^customers?$/i,                                          route: '/customers',   label: 'Opening customers' },
  { patterns: /^estimates?$/i,                                          route: '/estimates',   label: 'Opening estimates' },
  { patterns: /^invoices?$/i,                                           route: '/invoices',    label: 'Opening invoices' },
];

export function matchVoiceCommand(transcript: string): CommandMatch | null {
  const trimmed = transcript.trim();
  for (const cmd of COMMANDS) {
    if (cmd.patterns.test(trimmed)) {
      return { route: cmd.route, label: cmd.label };
    }
  }
  return null;
}
