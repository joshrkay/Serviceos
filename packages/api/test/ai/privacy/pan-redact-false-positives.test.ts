/**
 * PRIV-3 — the card-number scrubber's false-positive rate and recall, pinned
 * on a seeded corpus of what callers say (`card-number-corpus.ts`).
 *
 * A "card" found where there is none rewrites the caller's words in the
 * stored transcript and the call's rows and has the recording's audio purged
 * early, which cannot be undone. The rules that need the card mentioned (a
 * card read in pairs, two year-shaped groups, a window over turns with a
 * turn of four digits or fewer) used to take any talk of paying ("can I
 * pay", "payment", "pago", "pagar") and "credit", "debit" or "discover"
 * alone as a mention, anywhere in the text (a whole call's transcript, for
 * the transcription worker) or anywhere in the five-turn window; a window
 * over turns needed one only where every turn gave four digits or fewer; and
 * a window stitched from turns or cut out of a run of words took any 13–19
 * digit length. Now only words naming a card count (not the agent's "tap the
 * card to approve"), near the digits (in a long turn, near the digits that
 * turn gives), and those windows take only the lengths a card is issued at
 * for its first digits; 14 or 15 digit words said with no pause (a phone
 * number and a zip) need the card named too.
 *
 * Measured on 5,000 samples each (counts of samples with any "card" found;
 * "beyond the digit path" counts those where something other than the
 * digit-only rules for written digits, which are unchanged, found it):
 *
 *   corpus                          all, before → after   beyond the digit path
 *   utterance, no payment talk          44 → 41                8 → 5
 *   utterance, payment talk             71 → 58               20 → 7
 *   utterance, a card mentioned         76 → 59               23 → 6
 *   whole call, no payment talk        183 → 169              29 → 13
 *   whole call, payment talk           178 → 151              42 → 14
 *   whole call, a card mentioned       190 → 155              52 → 15
 *   call leg, no payment talk           64 → 55               13 → 4
 *   call leg, payment talk              78 → 64               25 → 11
 *   call leg, card asked about before   73 → 55               27 → 8
 *   call leg, card mentioned earlier    90 → 70               30 → 10
 *   call leg, the agent on cards        89 → 73               22 → 6
 *   bare answers, no card talk          27 → 9                27 → 9
 *   bare answers, the agent on cards    46 → 23               46 → 23
 *
 * Bare answers: a call leg of three to six bare intake answers, one per turn
 * with the agent's question between (`qaLeg`). With a gate code, a serial
 * number read in two fours and a time in a row, any shape with a turn of
 * four digits or fewer (4-8-4, 8-4-4, 4-4-8, 4-12) passed the Luhn check
 * joined; the nine left are two eight-digit answers in a row (a serial number
 * read in two fours, then a model number), which reads exactly like a card
 * read in two halves: stitching those with no card mentioned at all is the
 * owner's open decision. The agent saying "we take all major credit cards"
 * right before the answers is a mention near them, as it is meant to be.
 *
 * What is left beyond the digit path reads exactly like a card: a long
 * account, serial or tracking number read as words, 16–19 digits starting
 * like a card and passing the Luhn check, as a written one always did, and
 * two eight-digit bare answers in a row. Over twenty other seeds (1,000
 * samples of each corpus per seed, 260,000 in all) the only samples found
 * that were not found before have the card named right before the numbers
 * (19 of 260,000): a Diners Club's 14 from 38–39, a card's length now, read
 * in pairs or cut out of a run of words with a month after it, or bare answers
 * falling into a 13-digit card's [8,5] or read on after "sure". A Diners
 * Club's 14 cut out of a run of words (its CVV or expiry run on) found one
 * where none was found before, in a 17- or 18-digit order, serial or
 * confirmation number starting 36 with no card named at all; that cut now
 * needs the card named near it (pinned below), as do 14 or 15 digit words
 * said with no pause (a phone number and a house number or a zip).
 *
 * Every card below is caught, where before 47 of the 5,000 read in one
 * utterance (a Diners Club with its CVV or expiry run on, a card in pairs
 * with "pago con", a window of a length no card is issued at taken instead of
 * the card) and 63 of the 5,000 read over turns (a 19-digit card read group
 * by group with the card mentioned in the turn before the five) were not.
 * This corpus reads no 13-digit Visa and no 19-digit UnionPay. On one that
 * does (30,000 cards, the card named), four caught before are missed now:
 * two 13-digit Visas with the CVV run straight on (13 is no length a card is
 * cut at: before, a 16-digit window from its second digit passed the Luhn
 * check by chance), and two 19-digit cards read in pairs where "fifty seven"
 * (50, then 7) reads as 57, so eighteen digits, no length a Visa or UnionPay
 * is issued at. With no card named, a Diners Club's 14 with its CVV run on,
 * or a Diners Club's 14 or an Amex read as words with no pause at all, is
 * now missed too. So is a Diners Club's 14 from 300–305, 3095 or 38–39 read
 * as words with no pause at all and nothing run on, even with the card named
 * (this corpus reads Diners Clubs from 36 only): those ranges start area
 * codes, and a phone number from 301–305 or 380/385/386 read straight into
 * four more digits, with the card named a few words before it, was replaced
 * 1,040 and 1,008 times in 10,000. Read in its groups, with its CVV or expiry
 * run on, or over turns, it is caught; from 36 it is caught read either way.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_NUMBER_PLACEHOLDER,
  redactCardNumbers,
  redactCardNumbersInCallTurns,
} from '../../../src/ai/privacy/pan-redact';
import { CardNumberCorpus, digitOnlyScrubber, type CallLine } from './card-number-corpus';

const SAMPLES = 5000;

/** Number words and written digits left in `text` (pairs count once). */
const NUMBER_WORD =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\S+|veint\S+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\b/gi;
function numbersLeft(text: string): number {
  return (text.match(/\d/g)?.length ?? 0) + (text.match(NUMBER_WORD)?.length ?? 0);
}

/** How many samples had a "card" found, and how many beyond the digit-only rules. */
function falsePositives(found: (k: number) => 'none' | 'digit path' | 'beyond'): { all: number; beyond: number } {
  let all = 0;
  let beyond = 0;
  for (let k = 0; k < SAMPLES; k++) {
    const kind = found(k);
    if (kind !== 'none') all++;
    if (kind === 'beyond') beyond++;
  }
  return { all, beyond };
}

function inText(text: string): 'none' | 'digit path' | 'beyond' {
  const out = redactCardNumbers(text);
  return out === text ? 'none' : out === digitOnlyScrubber(text) ? 'digit path' : 'beyond';
}

function inCallLeg(lines: CallLine[]): 'none' | 'digit path' | 'beyond' {
  const out = redactCardNumbersInCallTurns(lines);
  if (!out) return 'none';
  const digitPath = lines.map((l) => (l.speaker === 'caller' ? digitOnlyScrubber(l.text) : l.text));
  return out.every((text, k) => text === digitPath[k]) ? 'digit path' : 'beyond';
}

describe('PRIV-3 — seeded corpus of numbers that are no card', () => {
  it.each([
    ['none', 1004, { all: 41, beyond: 5 }],
    ['payment', 1007, { all: 58, beyond: 7 }],
    ['card', 1004, { all: 59, beyond: 6 }],
  ] as const)('one utterance, %s talk near the numbers', (talk, seed, pinned) => {
    const corpus = new CardNumberCorpus(seed);
    const got = falsePositives(() => inText(corpus.utterance(talk)));
    expect(got.all).toBeLessThanOrEqual(pinned.all);
    expect(got.beyond).toBeLessThanOrEqual(pinned.beyond);
  });

  it.each([
    ['none', 2004, { all: 169, beyond: 13 }],
    ['payment', 2007, { all: 151, beyond: 14 }],
    ['card', 2004, { all: 155, beyond: 15 }],
  ] as const)('a whole call scrubbed as one text, %s talk far from the numbers', (talk, seed, pinned) => {
    const corpus = new CardNumberCorpus(seed);
    const got = falsePositives(() => inText(corpus.recording(talk)));
    expect(got.all).toBeLessThanOrEqual(pinned.all);
    expect(got.beyond).toBeLessThanOrEqual(pinned.beyond);
  });

  it.each([
    ['none', 3004, { all: 55, beyond: 4 }],
    ['payment', 3007, { all: 64, beyond: 11 }],
    ['card-adjacent', 3013, { all: 55, beyond: 8 }],
    ['card-early', 3010, { all: 70, beyond: 10 }],
    ['agent-card', 3010, { all: 73, beyond: 6 }],
  ] as const)('a call leg read turn by turn (the stored rows), %s', (talk, seed, pinned) => {
    const corpus = new CardNumberCorpus(seed);
    const got = falsePositives(() => inCallLeg(corpus.callLeg(talk)));
    expect(got.all).toBeLessThanOrEqual(pinned.all);
    expect(got.beyond).toBeLessThanOrEqual(pinned.beyond);
  });

  it.each([
    ['none', 7004, { all: 9, beyond: 9 }],
    ['agent-card', 7010, { all: 23, beyond: 23 }],
  ] as const)('a call leg of bare answers, one per turn (the stored rows), %s', (talk, seed, pinned) => {
    const corpus = new CardNumberCorpus(seed);
    const got = falsePositives(() => inCallLeg(corpus.qaLeg(talk)));
    expect(got.all).toBeLessThanOrEqual(pinned.all);
    expect(got.beyond).toBeLessThanOrEqual(pinned.beyond);
  });
});

describe('PRIV-3 — long numbers read as words with no card named', () => {
  // A 17- or 18-digit order, serial or confirmation number starting 36, read
  // as words: its first fourteen digits pass the Luhn check one time in ten,
  // and what follows them reads as a CVV or an expiry. Cut out as a Diners
  // Club's 14, 264 of these 5,000 had their first fourteen digits replaced
  // (1,122 had anything found, against 907 before that cut was added). The
  // cut needs the card named near it now; what is still found (886) is a
  // window of the whole number, or of all but its first digit, starting like
  // a card and passing the Luhn check, as written digits do.
  it('never cuts a Diners Club 14 out of a 17- or 18-digit number starting 36', () => {
    const corpus = new CardNumberCorpus(6000);
    const cut: string[] = [];
    let found = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const digits = `36${corpus.digits(corpus.pick([15, 16]), true)}`;
      const lang = corpus.chance(0.3) ? 'es' : 'en';
      const lead = corpus.pick(
        lang === 'en'
          ? ['order number ', 'serial number ', 'the confirmation number is ', 'my account number is ', 'the tracking number is ']
          : ['el número de orden es ', 'el número de serie es ', 'mi número de cuenta es '],
      );
      const text = `${lead}${corpus.sayGroup(digits, 'words', lang)}`;
      const out = redactCardNumbers(text, CARD_NUMBER_PLACEHOLDER, (matched) => {
        // One digit word per digit: fourteen words is a Diners Club's 14.
        if (matched.trim().split(/\s+/).length === 14) cut.push(text);
      });
      if (out !== text) found++;
    }
    expect(cut).toEqual([]);
    expect(found).toBeLessThanOrEqual(886);
  });
});

describe('PRIV-3 — seeded corpus of cards read with the card mentioned near them', () => {
  // Caught: the card's digits are gone, except what the caller said straight
  // after it (its CVV or expiry) and, for a 19-digit card whose first sixteen
  // digits pass the Luhn check by themselves, its last three.
  // All but a Diners Club's 14 from 300–305, 3095 or 38–39 read as words with
  // no pause at all and nothing run on: those ranges start area codes, and a
  // phone number read straight into four more digits is the same 14 digit
  // words (see "reads a phone number from 301–305 or 380–399 …" in
  // pan-redact.test.ts). Read in its groups, with its CVV or expiry run on,
  // or over turns, it is caught.
  it('catches every card read in one utterance: written, as words, in pairs, with a CVV or expiry run on', () => {
    const corpus = new CardNumberCorpus(4000);
    const missed: string[] = [];
    let unbrokenDinersOutside36 = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const { text, card, tail, unbroken } = corpus.cardUtterance();
      const out = redactCardNumbers(text);
      const allowed = tail + (card.length === 19 ? 3 : 0);
      if (out.includes(CARD_NUMBER_PLACEHOLDER) && numbersLeft(out) <= allowed) continue;
      if (unbroken && tail === 0 && card.length === 14 && !card.startsWith('36') && out === text) unbrokenDinersOutside36++;
      else missed.push(text);
    }
    expect(missed).toEqual([]);
    expect(unbrokenDinersOutside36).toBe(0);
  });

  it('catches every card read over several turns in its groups, the card mentioned in its turns, the turn before or by the agent', () => {
    const corpus = new CardNumberCorpus(5000);
    const missed: string[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      const { lines, card } = corpus.cardOverTurns();
      const out = redactCardNumbersInCallTurns(lines);
      const left = out ? lines.reduce((n, l, j) => n + (l.speaker === 'caller' ? numbersLeft(out[j]) : 0), 0) : Infinity;
      if (left > (card.length === 19 ? 3 : 0)) missed.push(JSON.stringify(lines.map((l) => l.text)));
    }
    expect(missed).toEqual([]);
  });
});
