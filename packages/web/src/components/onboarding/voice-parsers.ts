/**
 * Simple keyword-based parsers for voice answers during onboarding.
 * No LLM needed — we're matching against known option sets.
 */

const SERVICE_KEYWORDS: Record<string, string[]> = {
  HVAC:        ['hvac', 'heating', 'cooling', 'air conditioning', 'ac'],
  Plumbing:    ['plumbing', 'plumber', 'pipes', 'drains'],
  Painting:    ['painting', 'painter', 'paint'],
  Electrical:  ['electrical', 'electrician', 'wiring', 'electric'],
  Contracting: ['contracting', 'contractor', 'construction', 'remodel', 'renovation'],
  Other:       ['other'],
};

export function parseServices(transcript: string): string[] {
  const lower = transcript.toLowerCase();
  const matched: string[] = [];
  for (const [service, keywords] of Object.entries(SERVICE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(service);
    }
  }
  return matched;
}

const TEAM_SIZE_MAP: [RegExp, string][] = [
  [/\b(just me|solo|alone|one person|myself|by myself)\b/i, 'Just me'],
  [/\b(2[–\-\s]5|two to five|couple|small crew|few people|2 to 5)\b/i, '2–5 people'],
  [/\b(6[–\-\s]15|six to fifteen|growing|medium|6 to 15)\b/i, '6–15 people'],
  [/\b(16\+|sixteen|large|bigger|20|30|50|hundred|lots of)\b/i, '16+ people'],
];

export function parseTeamSize(transcript: string): string | null {
  for (const [pattern, value] of TEAM_SIZE_MAP) {
    if (pattern.test(transcript)) return value;
  }
  return null;
}

export function parseTerminology(
  transcript: string,
  options: { value: string; label: string }[]
): string | null {
  const lower = transcript.toLowerCase();
  // Check for exact or close match against option labels/values
  for (const opt of options) {
    if (
      lower.includes(opt.value.toLowerCase()) ||
      lower.includes(opt.label.toLowerCase())
    ) {
      return opt.value;
    }
  }
  return null;
}

const DISABLE_PATTERNS = /\b(turn off|disable|remove|skip|no|don't want|without)\b/i;
const ENABLE_PATTERNS = /\b(turn on|enable|add|keep|yes|want)\b/i;

export function parseRuleToggle(
  transcript: string,
  rules: { id: string; title: string; enabled: boolean }[]
): { id: string; enabled: boolean }[] | null {
  const lower = transcript.toLowerCase();
  const isDisable = DISABLE_PATTERNS.test(transcript);
  const isEnable = ENABLE_PATTERNS.test(transcript);

  if (!isDisable && !isEnable) return null;

  const matchedRules: { id: string; enabled: boolean }[] = [];
  for (const rule of rules) {
    // Check if the rule title keywords appear in the transcript
    const titleWords = rule.title.toLowerCase().split(/\s+/);
    const hasMatch = titleWords.some(
      (word) => word.length > 3 && lower.includes(word)
    );
    if (hasMatch) {
      matchedRules.push({ id: rule.id, enabled: isEnable });
    }
  }

  return matchedRules.length > 0 ? matchedRules : null;
}

const CONFIRM_PATTERNS = /\b(looks good|confirm|yes|correct|perfect|great|that's right|go ahead|launch|let's go)\b/i;
const EDIT_PATTERNS = /\b(change|edit|update|fix|wrong|no|back|redo)\b/i;

export function parseConfirmation(
  transcript: string
): 'confirm' | 'edit' | null {
  if (CONFIRM_PATTERNS.test(transcript)) return 'confirm';
  if (EDIT_PATTERNS.test(transcript)) return 'edit';
  return null;
}
