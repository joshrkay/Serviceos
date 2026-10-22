/**
 * What an owner's spoken answer means on one onboarding screen (voice-only
 * onboarding, build plan PR 1).
 *
 * Every screen that listens hands its finished utterances here, on the client,
 * before any server call. The answer is exactly one of:
 *
 *   - pick: it named one of the screen's two cards ("the second one", "hold it")
 *   - help: it asked Rivet for help (say that again, what does that mean,
 *     give me an example, what do most shops do), on a screen that offers it
 *   - command: one of the screen's own phrases ("make it mine", "that works")
 *   - free: anything else, on a screen that takes an answer in the owner's own
 *     words (a business name, a price)
 *   - unclear: none of those. Never a guess: the screen says what it heard and
 *     what it accepts (`unclearReply`).
 *
 * Help is checked first, so "what does the first one mean" is a question, not
 * a pick. A screen only gets the kinds it declares: a screen with no help list
 * hears "repeat that" as whatever else it might be.
 *
 * Pure and deterministic: no DOM, no network, no AI. It wraps the card matcher
 * (`option-matcher.ts`) and adds plain word lists.
 */
import type { OnboardingHelpRequest, OnboardingOptionKey } from '@ai-service-os/shared';
import { matchOption, spokenWords, type MatchableOptions, type OptionMatch } from './option-matcher';

export type HelpRequest = OnboardingHelpRequest;

export interface ScreenCommand {
  /** What the screen does with it ("make_it_mine"). */
  id: string;
  /** How an owner says it, most natural first: the first one is offered back on a miss. */
  phrases: readonly string[];
}

/** What one screen listens for. */
export interface UtteranceScreen {
  /** The screen's two cards, as rendered. */
  options?: MatchableOptions;
  /** The help this screen answers. */
  help?: readonly HelpRequest[];
  commands?: readonly ScreenCommand[];
  /** Words that are none of the above are the answer itself (a name, a price). */
  freeAnswer?: boolean;
}

export type Utterance =
  | { kind: 'pick'; key: OnboardingOptionKey; by: OptionMatch['by']; confidence: number; transcript: string }
  | { kind: 'help'; help: HelpRequest; transcript: string }
  | { kind: 'command'; command: string; transcript: string }
  | { kind: 'free'; text: string }
  | { kind: 'unclear'; transcript: string };

/** Over the normalized words (lowercase, no punctuation or apostrophes, no "um"/"please"). */
const HELP_PATTERNS: ReadonlyArray<[HelpRequest, RegExp]> = [
  ['repeat', /\b(say (that|it) again|say again|repeat( that| it)?|come again|one more time|what did you say|pardon|i didnt (catch|hear) (that|it|you))\b/],
  ['example', /\b(for (an )?example|an example|example|like what)\b/],
  ['most_shops', /\b(what (do|does|would) most|most (shops|people|plumbers|folks|businesses)|what (would|should) (you|i) (pick|choose|do)|which (one )?(do|would|should) (you|i) (pick|choose|recommend|suggest)|(you|do you) recommend)\b/],
  ['explain', /\b(what (does|do) .*\bmean|what is (that|this)|whats (that|this)|what do you mean|explain|i dont (understand|get it)|whats the difference|what is the difference)\b/],
];

/** Words that turn a command around ("that doesn't work"). */
const NEGATIONS = new Set(['not', 'dont', 'doesnt', 'never', 'no', 'nope', 'wait', 'isnt', 'cant']);
/** A command may come wrapped in a few words ("yeah, that works for me"), not buried in a sentence. */
const COMMAND_EXTRA_WORDS = 3;

function helpFor(said: string, offered: readonly HelpRequest[]): HelpRequest | null {
  for (const [help, pattern] of HELP_PATTERNS) {
    if (offered.includes(help) && pattern.test(said)) return help;
  }
  return null;
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

function commandFor(said: readonly string[], commands: readonly ScreenCommand[]): string | null {
  if (said.some((w) => NEGATIONS.has(w))) return null;
  for (const command of commands) {
    for (const phrase of command.phrases) {
      const p = spokenWords(phrase);
      if (said.length - p.length <= COMMAND_EXTRA_WORDS && containsRun(said, p)) return command.id;
    }
  }
  return null;
}

export function interpretUtterance(transcript: string, screen: UtteranceScreen): Utterance {
  const said = spokenWords(transcript);
  if (said.length === 0) return { kind: 'unclear', transcript };
  const text = transcript.trim();

  const help = helpFor(said.join(' '), screen.help ?? []);
  if (help) return { kind: 'help', help, transcript: text };

  const command = commandFor(said, screen.commands ?? []);
  if (command) return { kind: 'command', command, transcript: text };

  const match = screen.options ? matchOption(transcript, screen.options) : null;
  if (match) return { kind: 'pick', key: match.key, by: match.by, confidence: match.confidence, transcript: text };

  if (screen.freeAnswer) return { kind: 'free', text };
  return { kind: 'unclear', transcript: text };
}

/** "say first or second" / "say “make it mine”" / "just say it": what this screen accepts, for a miss. */
function accepts(screen: UtteranceScreen): string[] {
  const ways: string[] = [];
  if (screen.options) ways.push('say first or second');
  for (const command of screen.commands ?? []) {
    if (command.phrases[0]) ways.push(`say “${command.phrases[0]}”`);
  }
  if (screen.freeAnswer) ways.push('just say your answer');
  return ways;
}

function example(screen: UtteranceScreen): string | null {
  if (screen.options) {
    return screen.help?.includes('explain') ? 'For example, say “first”, or ask “what does that mean?”' : 'For example, say “first”.';
  }
  const phrase = screen.commands?.[0]?.phrases[0];
  return phrase ? `For example, say “${phrase}”.` : null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What Rivet says and shows when an answer was unclear: what was heard and what this
 * screen accepts, plus an example from the second miss on. `misses` counts this one.
 */
export function unclearReply(transcript: string, misses: number, screen: UtteranceScreen): string {
  const heard = transcript.trim() ? `I heard “${transcript.trim()}”.` : "I didn't catch that.";
  const ways = accepts(screen);
  const how = screen.options
    ? `Tap one, or ${ways.join(', or ')}.`
    : ways.length > 0
      ? `${capitalize(ways.join(', or '))}.`
      : 'Tap your answer instead.';
  const hint = misses >= 2 ? example(screen) : null;
  return [heard, how, hint].filter(Boolean).join(' ');
}
