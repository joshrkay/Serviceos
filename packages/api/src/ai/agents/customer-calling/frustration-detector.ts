/**
 * Synchronous, free keyword-based frustration detector.
 *
 * Runs on every Deepgram final transcript BEFORE intent classification.
 * Matches a curated list of frustration-indicating phrases with word-
 * boundary regex (case-insensitive). Deliberately conservative — false
 * positives pull a dispatcher away from another call.
 *
 * Returns the FIRST matched keyword for telemetry, even if multiple
 * patterns hit. Add to the list only based on call-data evidence after
 * launch.
 */

export const FRUSTRATION_KEYWORDS: ReadonlyArray<string> = [
  // Explicit / declarative frustration
  'this is ridiculous',
  'this is stupid',
  'forget it',
  'never mind',
  // Demand for human
  'i want a human',
  'real person',
  'speak to a person',
  // Generic frustration markers
  "i'm frustrated",
  "this isn't working",
  'are you kidding',
  // Hang-up threats
  "i'll just hang up",
  'this is wasting my time',
];

const KEYWORD_REGEXES = FRUSTRATION_KEYWORDS.map((kw) => {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { keyword: kw, regex: new RegExp(`\\b${escaped}\\b`, 'i') };
});

export interface FrustrationMatch {
  matched: boolean;
  keyword?: string;
}

export function detectFrustration(transcript: string): FrustrationMatch {
  for (const { keyword, regex } of KEYWORD_REGEXES) {
    if (regex.test(transcript)) {
      return { matched: true, keyword };
    }
  }
  return { matched: false };
}
