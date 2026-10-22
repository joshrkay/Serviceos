/**
 * Voice command matching for navigation and common actions.
 * Returns a matched route if the transcript matches a known command,
 * otherwise returns null to fall through to the assistant.
 *
 * Every pattern is anchored to the WHOLE utterance. A command only navigates
 * when navigating is all it says: "open invoices", "new customer". As soon as
 * the sentence carries anything else ("New customer Maria Alvarez,
 * 480-555-0102", "Show me the jobs Carlos has today", "Create an estimate for
 * the Khan install") it is a request for the assistant, which can draft or
 * answer it. Navigating to a blank form threw those details away.
 */

interface CommandMatch {
  route: string;
  label: string;
}

// Filler words allowed between a creation verb and its noun ("add a new
// customer", "create another estimate").
const FILLER = String.raw`(?:(?:a|an|the|new|another)\s+)*`;
// Politeness and punctuation a spoken command may carry without saying more.
const LEAD = String.raw`^(?:(?:please|ok(?:ay)?|hey rivet|rivet)[,\s]+)?`;
const TAIL = String.raw`(?:\s+(?:page|list|screen|tab))?(?:[,\s]+please)?[.!?]*$`;
const NAV_VERB = String.raw`(?:show(?:\s+me)?|open(?:\s+up)?|go\s+to|take\s+me\s+to|see|view|pull\s+up)\s+(?:(?:the|my|all|all\s+the)\s+)?`;

function nav(nouns: string): RegExp {
  return new RegExp(`${LEAD}${NAV_VERB}${nouns}${TAIL}`, 'i');
}
function create(nouns: string): RegExp {
  return new RegExp(String.raw`${LEAD}(?:new|create|add|start)\s+${FILLER}${nouns}(?:[,\s]+please)?[.!?]*$`, 'i');
}
function bare(nouns: string): RegExp {
  return new RegExp(`${LEAD}${nouns}${TAIL}`, 'i');
}

const COMMANDS: { patterns: RegExp; route: string; label: string }[] = [
  { patterns: nav(String.raw`(?:today'?s\s+)?jobs?`),           route: '/jobs',      label: 'Opening jobs' },
  { patterns: nav(String.raw`(?:today'?s\s+)?(?:schedule|calendar)`), route: '/schedule', label: 'Opening schedule' },
  { patterns: nav(String.raw`(?:customers?|clients?)`),          route: '/customers', label: 'Opening customers' },
  { patterns: nav(String.raw`(?:estimates?|quotes?)`),           route: '/estimates', label: 'Opening estimates' },
  { patterns: nav(String.raw`(?:invoices?|billing)`),            route: '/invoices',  label: 'Opening invoices' },
  { patterns: /^(go\s+(to\s+)?)?(home|dashboard)[.!?]*$/i,      route: '/',          label: 'Going home' },

  { patterns: create('job'),                 route: '/jobs/new',      label: 'Creating new job' },
  { patterns: create('(?:estimate|quote)'),  route: '/estimates/new', label: 'Creating new estimate' },
  { patterns: create('(?:customer|client)'), route: '/customers/new', label: 'Adding new customer' },
  // #881: the Home "New invoice" quick action submits "Create a new invoice".
  { patterns: create('(?:invoice|bill)'),    route: '/invoices/new',  label: 'Creating new invoice' },

  { patterns: bare('jobs?'),                 route: '/jobs',      label: 'Opening jobs' },
  { patterns: bare('schedule'),              route: '/schedule',  label: 'Opening schedule' },
  { patterns: bare('customers?'),            route: '/customers', label: 'Opening customers' },
  { patterns: bare('estimates?'),            route: '/estimates', label: 'Opening estimates' },
  { patterns: bare('invoices?'),             route: '/invoices',  label: 'Opening invoices' },
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
