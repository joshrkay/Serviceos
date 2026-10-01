/**
 * #1331 (owner decision 2026-10-01) — the caller-name identity check.
 *
 * A caller identified by caller ID who ALSO says who they are ("Hi, this is
 * Maria Rodriguez") is matched against the account on that number. When the
 * spoken name does not clear τ_ent — the entity resolver's "resolved" bar
 * (ai/resolution/entity-resolver.ts) — the agent asks ONE yes/no check ("is
 * this Maria Rodriguez?") before acting on the account. Below τ_ent the name
 * is at best in the resolver's confirm band ("probably right, confirm before
 * acting"), and a mumble/mis-hearing scores lower still; on a caller-ID line
 * the number is a strong prior either way, so the one safe action for every
 * sub-τ_ent name is the same yes/no — never a silent guess in either
 * direction.
 *
 * Pure helpers; the dialogue lives in the voice-turn processor
 * (`handleCallerIdentityCheck`), shared by both phone transports.
 */
import { nameSimilarity } from '../../../customers/dedup';
import { TAU_ENT } from '../../resolution/entity-resolver';

/** Lead-ins after which a caller names themselves. Case-insensitive. */
const SELF_NAME_LEAD = /\b(?:this is|my name is|me llamo)\s+/i;

/** Words that end a self-introduction rather than continue the name. */
const NAME_STOP_WORDS = new Set([
  'calling', 'and', 'from', 'about', 'with', 'here', 'speaking', 'again', 'regarding',
  'i', "i'm", 'im', 'on', 'at', 'for', 'to', 'the', 'my', 'y', 'de', 'llamando',
]);

/**
 * The name a caller gives for themselves, or undefined. Only Capitalised
 * words count as a name (STT capitalises names), so "this is urgent" or
 * "this is about my bill" are not self-introductions. At most three words.
 */
export function spokenSelfName(utterance: string): string | undefined {
  const lead = SELF_NAME_LEAD.exec(utterance);
  if (!lead) return undefined;
  const rest = utterance.slice(lead.index + lead[0].length);
  const words: string[] = [];
  for (const raw of rest.split(/\s+/)) {
    const word = raw.replace(/[.,!?;:]+$/, '');
    if (word.length === 0 || NAME_STOP_WORDS.has(word.toLowerCase())) break;
    if (!/^\p{Lu}/u.test(word)) break;
    words.push(word);
    if (words.length === 3 || /[.,!?;:]$/.test(raw)) break;
  }
  return words.length > 0 ? words.join(' ') : undefined;
}

/**
 * How well a spoken name matches the account: the best trigram similarity
 * (pg_trgm-equivalent, customers/dedup.ts) against the full name, the first
 * name alone and the last name alone — "this is Maria" names Maria Rodriguez.
 */
export function callerNameMatchScore(
  spokenName: string,
  account: { displayName: string; firstName?: string; lastName?: string },
): number {
  const targets = [account.displayName, account.firstName, account.lastName].filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0,
  );
  return Math.max(0, ...targets.map((t) => nameSimilarity(spokenName, t)));
}

/** True when the spoken name confidently names the account (≥ τ_ent). */
export function callerNameMatchesAccount(
  spokenName: string,
  account: { displayName: string; firstName?: string; lastName?: string },
): boolean {
  return callerNameMatchScore(spokenName, account) >= TAU_ENT;
}

/**
 * The caller's held request, re-voiced with the account name they just
 * confirmed in place of the name they mumbled. After "yes, that's me" the
 * name is no longer in doubt, and the garbled spelling only costs the
 * classifier its confidence: Layer 2 run 36925905917 classified "Hi this is
 * Mmmmaria Roddrrgez calling about my appointment" as unknown in 2 of 3
 * runs and the caller, who had just said yes, was asked to repeat it.
 * An utterance with no self-introduction is returned unchanged.
 */
export function withConfirmedSelfName(utterance: string, accountName: string): string {
  const spokenName = spokenSelfName(utterance);
  if (!spokenName) return utterance;
  const lead = SELF_NAME_LEAD.exec(utterance);
  if (!lead) return utterance;
  const at = utterance.indexOf(spokenName, lead.index + lead[0].length);
  if (at < 0) return utterance;
  return utterance.slice(0, at) + accountName + utterance.slice(at + spokenName.length);
}

/** The one yes/no check. */
export function callerIdentityCheckLine(accountName: string): string {
  return `Just to make sure I have the right account — is this ${accountName}?`;
}
