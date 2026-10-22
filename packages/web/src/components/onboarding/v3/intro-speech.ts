/**
 * The opening questions, answered out loud (voice-only onboarding, build plan
 * PR 4): what to answer the phone as, the trade, and the owner's cell.
 *
 * Rivet asks them one at a time on "What should I answer as?" and each answer
 * fills the same form the owner can see and fix. Everything here is plain
 * matching on the final transcript: no DOM, no network, no model. An answer that
 * means nothing is never guessed at; the screen says what it heard instead.
 */
import { isUsCellNumber } from './cell-number';
import { spokenWords } from '../../../lib/option-matcher';

export const TRADES = [
  { packId: 'plumbing', label: 'Plumbing', spoken: 'plumbing' },
  { packId: 'hvac', label: 'HVAC', spoken: 'HVAC' },
  { packId: 'electrical', label: 'Electrical', spoken: 'electrical' },
  { packId: 'other', label: 'Something else', spoken: 'something else' },
] as const;

export type TradePackId = (typeof TRADES)[number]['packId'];

/** The field Rivet is asking for. `spell` is the name again, letter by letter. */
export type IntroStep = 'name' | 'spell' | 'trade' | 'cell' | 'confirm';

/** Same limit as the name field. */
const NAME_MAX = 120;

// ---------------------------------------------------------------------------
// The business name
// ---------------------------------------------------------------------------

/** How owners start the answer ("it's Walsh Plumbing", "we're called…"): dropped, longest first. */
const NAME_LEAD_INS = [
  'the name of my business is',
  'the name of the business is',
  'my business is called',
  'the business is called',
  'my company is called',
  'the company is called',
  'my business name is',
  'the business name is',
  'my business is',
  'the name is',
  'were called',
  'we are called',
  'its called',
  'it is called',
  'call it',
  'it is',
  'its',
  'were',
  'we are',
  'called',
].map((p) => p.split(' '));

/** "W A L S H" or "W-A-L-S-H": a run of two or more single letters. */
function collapseSpelled(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let j = i;
    while (j < tokens.length && /^[a-z]$/i.test(tokens[j]!)) j += 1;
    if (j - i >= 2) {
      const letters = tokens.slice(i, j).join('');
      // Two or three letters are initials ("ABC Plumbing"); more is a spelled word ("Walsh").
      out.push(letters.length <= 3 ? letters.toUpperCase() : letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase());
      i = j;
    } else {
      out.push(tokens[i]!);
      i += 1;
    }
  }
  return out;
}

/** "walsh plumbing" -> "Walsh Plumbing"; a word that already has capitals ("HVAC", "McNeil") is kept as said. */
function capitalizeLowerWords(tokens: string[]): string[] {
  return tokens.map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w));
}

/**
 * The business name in a spoken answer, ready for the field, or null when there is none
 * ("um", or only "it's"). Lead-ins and the closing full stop go; spelled letters join up.
 */
export function spokenBusinessName(transcript: string): string | null {
  const text = transcript.trim().replace(/[.!?,;:]+$/, '').trim();
  // Split letters joined by hyphens or dots ("W-A-L-S-H", "A.B.C.") so they read as a spelled run.
  const tokens = text
    .split(/\s+/)
    .flatMap((t) => (/^([a-z][-.])+[a-z]?\.?$/i.test(t) ? t.split(/[-.]/).filter(Boolean) : [t]))
    .filter((t) => !['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'hmm'].includes(t.toLowerCase().replace(/[^a-z]/g, '')));
  if (tokens.length === 0) return null;

  // Lead-ins are matched on the cleaned words but cut from the tokens as said, so "Its" or "It's" both go.
  const lower = tokens.map((t) => t.toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]/g, ''));
  const lead = NAME_LEAD_INS.find((p) => p.length < lower.length && p.every((w, i) => lower[i] === w));
  const rest = lead ? tokens.slice(lead.length) : tokens;

  const name = capitalizeLowerWords(collapseSpelled(rest)).join(' ').trim().slice(0, NAME_MAX).trim();
  return name === '' || spokenWords(name).length === 0 ? null : name;
}

// ---------------------------------------------------------------------------
// The trade
// ---------------------------------------------------------------------------

/** Words, and two-word phrases, that name each trade. Anything that names another trade is "something else". */
const TRADE_WORDS: ReadonlyArray<[TradePackId, readonly string[]]> = [
  ['plumbing', ['plumber', 'plumbers', 'plumbing', 'drain', 'drains', 'sewer', 'rooter']],
  [
    'hvac',
    ['hvac', 'heating', 'cooling', 'air', 'ac', 'furnace', 'furnaces', 'heat pump', 'heat pumps', 'air conditioning', 'refrigeration'],
  ],
  ['electrical', ['electrician', 'electricians', 'electrical', 'electric', 'wiring']],
  [
    'other',
    [
      'something else', 'other', 'none of those', 'none of them', 'roofing', 'roofer', 'roofers', 'landscaping', 'landscaper',
      'lawn', 'painting', 'painter', 'painters', 'cleaning', 'cleaner', 'cleaners', 'handyman', 'pest', 'garage door',
      'garage doors', 'appliance', 'appliances', 'locksmith', 'pool', 'pools', 'carpentry', 'carpenter', 'flooring',
      'remodeling', 'construction', 'contractor', 'general contractor', 'solar', 'gutter', 'gutters', 'window',
      'windows', 'concrete', 'masonry', 'fencing', 'tree', 'trees', 'pressure washing', 'junk', 'moving',
    ],
  ],
];

/**
 * "not plumbing", "we don't do HVAC": the trade right after is not the answer. "no" is not one:
 * "no, plumbing" is a correction.
 */
const TRADE_NEGATIONS = new Set(['not', 'dont', 'doesnt', 'never', 'isnt', 'arent']);

/** Words that can sit between the negation and the trade ("don't do HVAC", "not a plumber"). */
const NEGATION_BRIDGES = new Set(['do', 'does', 'a', 'an', 'the', 'offer', 'really']);

function negated(said: readonly string[], at: number): boolean {
  const one = said[at - 1] ?? '';
  const two = said[at - 2] ?? '';
  return TRADE_NEGATIONS.has(one) || (NEGATION_BRIDGES.has(one) && TRADE_NEGATIONS.has(two));
}

export type TradeMatch =
  | { kind: 'trade'; packId: TradePackId }
  /** More than one trade named ("plumbing and heating"): ask which, never pick one. */
  | { kind: 'ambiguous'; packIds: TradePackId[] }
  | { kind: 'none' };

export function matchTrade(transcript: string): TradeMatch {
  // "H V A C" and "A C" are said as letters: join a run of single letters into one word.
  const said: string[] = [];
  let joining = false;
  for (const w of spokenWords(transcript)) {
    if (/^[a-z]$/.test(w)) {
      if (joining) said[said.length - 1] += w;
      else said.push(w);
      joining = true;
    } else {
      said.push(w);
      joining = false;
    }
  }

  const found = new Set<TradePackId>();
  for (const [packId, phrases] of TRADE_WORDS) {
    for (const phrase of phrases) {
      const p = phrase.split(' ');
      for (let i = 0; i + p.length <= said.length; i += 1) {
        if (!p.every((w, k) => said[i + k] === w)) continue;
        if (negated(said, i)) continue;
        found.add(packId);
      }
    }
  }
  if (found.size === 1) return { kind: 'trade', packId: [...found][0]! };
  if (found.size > 1) return { kind: 'ambiguous', packIds: TRADES.map((t) => t.packId).filter((id) => found.has(id)) };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// The cell
// ---------------------------------------------------------------------------

const DIGIT_WORDS = new Map(
  Object.entries({ zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }),
);
const TEEN_WORDS = new Map(
  Object.entries({ ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' }),
);
const TENS_WORDS = new Map(Object.entries({ twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' }));

export type SpokenCell =
  /** A US cell the API will take, as the field shows it: "(216) 555-0142". */
  | { kind: 'cell'; display: string }
  /** Digits were said, but not a 10-digit US cell (seven digits, +44, area code 0…). */
  | { kind: 'not_us'; digits: string }
  /** No number in it at all. */
  | { kind: 'none' };

/**
 * The cell in a spoken answer. Deepgram's smart formatting usually sends digits
 * ("216-555-0142"); spoken digit words ("two one six…", "oh", "double five",
 * "forty two") are read too. Whether it is a cell is `isUsCellNumber`'s call,
 * the same check the typed field makes.
 */
export function parseSpokenCell(transcript: string): SpokenCell {
  const tokens = transcript
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/(\d)\s*[-.()]\s*(?=\d)/g, '$1 ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  let digits = '';
  let plus = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t === '+' || t === 'plus') {
      if (digits === '') plus = true;
      continue;
    }
    if (/^\+?\d+$/.test(t)) {
      if (t.startsWith('+') && digits === '') plus = true;
      digits += t.replace('+', '');
      continue;
    }
    const repeat = t === 'double' ? 2 : t === 'triple' ? 3 : 0;
    if (repeat > 0) {
      const next = DIGIT_WORDS.get(tokens[i + 1] ?? '') ?? (/^\d$/.test(tokens[i + 1] ?? '') ? tokens[i + 1] : undefined);
      if (next !== undefined) {
        digits += next.repeat(repeat);
        i += 1;
      }
      continue;
    }
    // "o" and "oh" are a zero only among digits ("five oh two"), never "oh, it's…" (no area code starts with 0).
    const digit = (t === 'o' || t === 'oh') && digits === '' ? undefined : DIGIT_WORDS.get(t);
    if (digit !== undefined) {
      digits += digit;
      continue;
    }
    const teen = TEEN_WORDS.get(t);
    if (teen !== undefined) {
      digits += teen;
      continue;
    }
    const tens = TENS_WORDS.get(t);
    if (tens !== undefined) {
      const unit = DIGIT_WORDS.get(tokens[i + 1] ?? '');
      if (unit !== undefined && unit !== '0') {
        digits += tens + unit;
        i += 1;
      } else {
        digits += `${tens}0`;
      }
    }
  }

  if (digits === '') return { kind: 'none' };
  const typed = `${plus ? '+' : ''}${digits}`;
  if (!isUsCellNumber(typed)) return { kind: 'not_us', digits: typed };
  const national = digits.length === 11 ? digits.slice(1) : digits;
  return { kind: 'cell', display: `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` };
}

/** "(216) 555-0142" read out digit by digit in its three groups, so no voice says "two hundred sixteen". */
export function cellReadback(cell: string): string {
  const national = cell.replace(/\D/g, '').slice(-10);
  return [national.slice(0, 3), national.slice(3, 6), national.slice(6)].map((g) => g.split('').join(' ')).join(', ');
}

// ---------------------------------------------------------------------------
// What Rivet asks, and in what order
// ---------------------------------------------------------------------------

export interface IntroAnswers {
  name: string;
  packId: string | null;
  /** The cell is one the API will take and was not refused. */
  cellOk: boolean;
}

/** The first thing still missing, in the order Rivet asks: the name, the trade, the cell; then the check. */
export function nextIntroStep(answers: IntroAnswers): IntroStep {
  if (answers.name.trim() === '') return 'name';
  if (answers.packId === null) return 'trade';
  if (!answers.cellOk) return 'cell';
  return 'confirm';
}

export const ASK_NAME = "What's your business called?";
export const ASK_SPELL = 'Go ahead and spell it, letter by letter.';
export const ASK_TRADE = "What's your trade: plumbing, HVAC, electrical, or something else?";
export const ASK_CELL = "What's your cell number, with the area code?";
export const TRADE_MISS = "I didn't catch the trade. Plumbing, HVAC, electrical, or something else?";
export const NAME_MISS = "I didn't catch a name. What's your business called?";
export const CELL_NONE = "I didn't catch a number. Say your cell with the area code, 10 digits.";
export const SAY_GO = 'Say “show me my shop”, or fix anything above.';

const spokenTrade = (packId: string | null) => TRADES.find((t) => t.packId === packId)?.spoken ?? '';

/** Rivet's question for `step`, given what the form holds now. */
export function askFor(step: IntroStep, answers: { name: string; packId: string | null; cell: string }): string[] {
  switch (step) {
    case 'name':
      return [ASK_NAME];
    case 'spell':
      return [ASK_SPELL];
    case 'trade':
      return [ASK_TRADE];
    case 'cell':
      return [ASK_CELL];
    case 'confirm':
      return [`${answers.name}, ${spokenTrade(answers.packId)}, and your cell is ${cellReadback(answers.cell)}.`, SAY_GO];
  }
}

/** The name read back, with the two ways to fix it. */
export const nameHeard = (name: string) => `I've got ${name}. If that's not right, say “spell it”, or type it above.`;

/** "Got it, HVAC." */
export const tradeHeard = (packId: TradePackId) => (packId === 'other' ? 'Got it.' : `Got it, ${spokenTrade(packId)}.`);

/** "I heard plumbing and HVAC. Which one do you do most?" */
export function tradeAmbiguous(packIds: readonly TradePackId[]): string {
  const names = packIds.map(spokenTrade);
  const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  return `I heard ${list}. Which one do you do most?`;
}

/** On the check, anything that is not a command: what was heard, and what to say. */
export const confirmMiss = (transcript: string) => `I heard “${transcript.trim()}”. ${SAY_GO}`;
