/**
 * Voice command matching for navigation and common actions.
 * Returns a matched route if the transcript matches a known command,
 * otherwise returns null to fall through to the assistant.
 */

interface CommandMatch {
  route: string;
  label: string;
}

const COMMANDS: { patterns: RegExp; route: string; label: string }[] = [
  // Navigation
  { patterns: /\b(show|open|go to|see)\b.*(today'?s?\s+)?jobs?\b/i,   route: '/jobs',        label: 'Opening jobs' },
  { patterns: /\b(show|open|go to|see)\b.*schedule\b|calendar\b/i,    route: '/schedule',    label: 'Opening schedule' },
  { patterns: /\b(show|open|go to|see)\b.*customers?\b|clients?\b/i,  route: '/customers',   label: 'Opening customers' },
  { patterns: /\b(show|open|go to|see)\b.*estimates?\b|quotes?\b/i,   route: '/estimates',   label: 'Opening estimates' },
  { patterns: /\b(show|open|go to|see)\b.*invoices?\b|billing\b/i,    route: '/invoices',    label: 'Opening invoices' },
  { patterns: /\b(go\s+)?home\b|dashboard\b/i,                         route: '/',            label: 'Going home' },

  // Creation shortcuts
  { patterns: /\b(new|create|add)\b.*\bjob\b/i,                        route: '/jobs/new',       label: 'Creating new job' },
  { patterns: /\b(new|create|add)\b.*\bestimate\b|\bquote\b/i,         route: '/estimates/new',  label: 'Creating new estimate' },
  { patterns: /\b(new|create|add)\b.*\bcustomer\b|\bclient\b/i,        route: '/customers/new',  label: 'Adding new customer' },

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
