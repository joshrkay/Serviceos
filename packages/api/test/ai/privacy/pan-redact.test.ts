/**
 * PRIV-3 — the one card-number scrubber every store and provider path uses.
 *
 * Expected values are written out by hand from the card networks' published
 * test numbers (Luhn-valid by construction) and from the audit's probe
 * samples — never recomputed the way the scrubber computes them.
 */
import { describe, expect, it } from 'vitest';
import {
  agentLinesAround,
  CARD_NUMBER_PLACEHOLDER,
  containsCardNumber,
  redactCardNumbers,
  redactCardNumbersAcrossTurns,
  redactCardNumbersInCallTurns,
} from '../../../src/ai/privacy/pan-redact';

const MARKER = CARD_NUMBER_PLACEHOLDER;

/** The agent mentions the card around the caller's turns. */
const AGENT_MENTIONS_CARD = { agentLines: ["I'm sorry, I can't take card numbers over the phone."] };

describe('redactCardNumbers', () => {
  it('replaces a space-grouped 16-digit Visa test number (the audit trigger)', () => {
    expect(
      redactCardNumbers('can I just pay now — my card is 4111 1111 1111 1111, expires 09/27'),
    ).toBe('can I just pay now — my card is [card number], expires 09/27');
  });

  it('replaces an unspaced 16-digit number', () => {
    expect(redactCardNumbers('card 4111111111111111 thanks')).toBe('card [card number] thanks');
  });

  it('replaces a dash-grouped Mastercard test number', () => {
    expect(redactCardNumbers('it is 5555-5555-5555-4444')).toBe('it is [card number]');
  });

  it('replaces a 15-digit Amex test number grouped 4-6-5', () => {
    expect(redactCardNumbers('amex 3782 822463 10005 ok')).toBe('amex [card number] ok');
  });

  it('replaces a 13-digit Visa test number', () => {
    expect(redactCardNumbers('old card 4222222222222')).toBe('old card [card number]');
  });

  it('keeps the CVV that follows a grouped card number', () => {
    expect(redactCardNumbers('4111 1111 1111 1111 123')).toBe('[card number] 123');
  });

  it('replaces two cards in one utterance', () => {
    expect(redactCardNumbers('either 4111111111111111 or 5555 5555 5555 4444')).toBe(
      'either [card number] or [card number]',
    );
  });

  it('leaves a 16-digit run that fails the Luhn check untouched', () => {
    expect(redactCardNumbers('ref 4111 1111 1111 1112')).toBe('ref 4111 1111 1111 1112');
  });

  it('leaves phone numbers untouched', () => {
    expect(redactCardNumbers('call me at 6025550199 or +1 (602) 555-0199')).toBe(
      'call me at 6025550199 or +1 (602) 555-0199',
    );
  });

  // A phone number said straight before another number (a zip, a unit, a
  // second phone) is a 13–19 digit grouped run, and about one in ten of those
  // happens to pass the Luhn check. Without the phone-shape guard the stored
  // turn lost the callback number and the call's audio was deleted early.
  it('leaves a grouped phone number followed by a zip code untouched', () => {
    // 602 555 0199 85006 → 602555019985006 passes the Luhn check.
    expect(redactCardNumbers('call me at 602 555 0199 85006')).toBe('call me at 602 555 0199 85006');
    expect(redactCardNumbers('texted from 602-555-0199 85006')).toBe('texted from 602-555-0199 85006');
  });

  it('leaves an unspaced or country-coded phone number followed by more digits untouched', () => {
    expect(redactCardNumbers('my cell 6025550199 85006')).toBe('my cell 6025550199 85006');
    expect(redactCardNumbers('call 1 602 555 0199 85004')).toBe('call 1 602 555 0199 85004');
  });

  it('still replaces a card number said straight after a phone number', () => {
    expect(redactCardNumbers('602 555 0199 4111 1111 1111 1111')).toBe('602 555 0199 [card number]');
  });

  it('leaves integer cents and short codes untouched', () => {
    expect(redactCardNumbers('you owe 1234500 cents, gate code 4821')).toBe(
      'you owe 1234500 cents, gate code 4821',
    );
  });

  // Speech-to-text punctuates the pause between spoken digit groups: Twilio
  // Gather returns "4111, 1111, 1111, 1111." and there is no upstream
  // redaction on that path, so these must be caught here.
  it('replaces a card whose groups STT separated with commas', () => {
    expect(redactCardNumbers('my card is 4111, 1111, 1111, 1111.')).toBe('my card is [card number].');
  });

  it('replaces a card whose groups STT separated with periods', () => {
    expect(redactCardNumbers('4111. 1111. 1111. 1111')).toBe('[card number]');
  });

  it('replaces a card whose groups are separated by double spaces or spaced dashes', () => {
    expect(redactCardNumbers('card 4111  1111  1111  1111 ok')).toBe('card [card number] ok');
    expect(redactCardNumbers('card 5555 - 5555 - 5555 - 4444 ok')).toBe('card [card number] ok');
  });

  it('keeps the CVV and its comma after a comma-grouped card', () => {
    expect(redactCardNumbers('4111, 1111, 1111, 1111, 123')).toBe('[card number], 123');
  });

  it('leaves a comma-grouped run that fails the Luhn check untouched', () => {
    expect(redactCardNumbers('ref 4111, 1111, 1111, 1112.')).toBe('ref 4111, 1111, 1111, 1112.');
  });

  it('leaves a period-separated phone number followed by a zip untouched', () => {
    expect(redactCardNumbers('call 602.555.0199, 85006')).toBe('call 602.555.0199, 85006');
  });

  it('leaves digits that are part of a longer token untouched', () => {
    expect(redactCardNumbers('id ab4111111111111111cd')).toBe('id ab4111111111111111cd');
  });

  // Only an ASCII letter or digit next to the digits makes them part of a
  // longer token (an id, a reference). A non-ASCII letter next to them is how
  // Spanish writes "number" (nº, nª) or an accented word STT ran onto the
  // digits, and the card must still be caught there.
  it('replaces a card that touches a non-ASCII letter on either side', () => {
    expect(redactCardNumbers('tarjeta nº4111111111111111')).toBe('tarjeta nº[card number]');
    expect(redactCardNumbers('la 4111111111111111ª')).toBe('la [card number]ª');
    expect(redactCardNumbers('é4111111111111111')).toBe('é[card number]');
    expect(redactCardNumbers('4111111111111111é gracias')).toBe('[card number]é gracias');
    expect(redactCardNumbers('nº 4111-1111-1111-1111ñ')).toBe('nº [card number]ñ');
  });

  it("maps Deepgram's redaction tag for a card to the same marker", () => {
    expect(redactCardNumbers('my card is [CREDIT_CARD_1] expiring [CREDIT_CARD_EXPIRATION_1]')).toBe(
      'my card is [card number] expiring [CREDIT_CARD_EXPIRATION_1]',
    );
  });

  it('accepts a custom placeholder', () => {
    expect(redactCardNumbers('4111 1111 1111 1111', '[CARD_NUMBER]')).toBe('[CARD_NUMBER]');
  });
});

/**
 * The digit-only scrubber as it shipped before digit words were read
 * (packages/api/src/ai/privacy/pan-redact.ts at da456f812), kept verbatim in
 * behaviour as the oracle for written digits: reading words must not change
 * a single redaction of text that holds none.
 */
function digitOnlyScrubber(text: string, onRedact: (matched: string, offset: number) => void): string {
  const sep = String.raw`(?:[ \t]*[,.\-][ \t]*|[ \t]+)`;
  const run = new RegExp(String.raw`(?<![0-9A-Za-z])\d+(?:${sep}\d+)*(?![0-9A-Za-z])`, 'g');
  const split = new RegExp(`(${sep})`);
  const luhn = (d: string): boolean => {
    let sum = 0;
    for (let i = d.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
      let n = d.charCodeAt(i) - 48;
      if (dbl) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      sum += n;
    }
    return d.length > 0 && sum % 10 === 0;
  };
  const phoneAt = (g: string[], i: number): number => {
    const len = (k: number): number => g[i + k]?.length ?? 0;
    if (g[i].length === 10 || (g[i].length === 11 && g[i].startsWith('1'))) return 1;
    if (len(0) === 3 && len(1) === 3 && len(2) === 4) return 3;
    if (g[i] === '1' && len(1) === 3 && len(2) === 3 && len(3) === 4) return 4;
    return 0;
  };
  return text.replace(/\[CREDIT_CARD(?:_\d+)?\]/g, '[card number]').replace(run, (match: string, offset: number) => {
    if (match.replace(/\D/g, '').length < 13) return match;
    const parts = match.split(split);
    const groups = parts.filter((_, k) => k % 2 === 0);
    const seps = parts.filter((_, k) => k % 2 === 1);
    const starts: number[] = [];
    parts.reduce((pos, p, k) => (k % 2 === 0 && starts.push(pos), pos + p.length), 0);
    const out: string[] = [];
    let i = 0;
    while (i < groups.length) {
      const phone = phoneAt(groups, i);
      if (phone > 0) {
        for (let g = i; g < i + phone; g++) out.push(groups[g], ...(g + 1 < groups.length ? [seps[g]] : []));
        i += phone;
        continue;
      }
      let digits = '';
      let end = -1;
      for (let j = i; j < groups.length && (digits += groups[j]).length <= 19; j++) {
        if (digits.length >= 13 && luhn(digits)) end = j;
      }
      const last = end >= 0 ? end : i;
      if (end >= 0) {
        onRedact(match.slice(starts[i], starts[last] + groups[last].length), offset + starts[i]);
        out.push('[card number]');
      } else {
        out.push(groups[i]);
      }
      if (last + 1 < groups.length) out.push(seps[last]);
      i = last + 1;
    }
    return out.join('');
  });
}

/** Deterministic PRNG (mulberry32) so the parity run is the same every time. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `body` plus the digit that makes it pass the Luhn check. */
function withLuhnCheckDigit(body: string): string {
  for (let d = 0; d <= 9; d++) {
    const candidate = body + d;
    let sum = 0;
    for (let i = candidate.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
      let n = candidate.charCodeAt(i) - 48;
      if (dbl) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      sum += n;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('unreachable');
}

describe('redactCardNumbers — written digits behave exactly as the digit-only scrubber did', () => {
  it('matches it on seeded random digit text with ASCII and non-ASCII neighbours', () => {
    const random = seededRandom(0x5eed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
    const digitString = (n: number): string => Array.from({ length: n }, () => String(Math.floor(random() * 10))).join('');
    // No neighbour is, or can combine into, a digit word or a filler: this is
    // text the digit-only scrubber was written for.
    const neighbours = ['a', 'x', 'Q', 'ref', 'nº', 'º', 'ª', 'é', 'ñ', 'Ü', 'ß', 'Ω', 'д', '中', '́',
      '#', '(', ')', '/', '$', '€', '%', '_', '*', ':', '?', '…', '—', '[CREDIT_CARD_1]'];
    const separators = [' ', '  ', ', ', ',', '-', ' - ', '. ', '.', '\t', ' , ', '\n', ' / ', ''];
    const groupsOf = (digits: string): string[] => {
      const groups: string[] = [];
      for (let i = 0; i < digits.length; ) {
        const size = random() < 0.6 ? 4 : 1 + Math.floor(random() * 7);
        groups.push(digits.slice(i, i + size));
        i += size;
      }
      return groups;
    };
    let compared = 0;
    let redacted = 0;
    for (let n = 0; n < 4000; n++) {
      const pieces: string[] = [];
      for (let p = 0, count = 1 + Math.floor(random() * 6); p < count; p++) {
        const roll = random();
        if (roll < 0.35) {
          const card = withLuhnCheckDigit(digitString(12 + Math.floor(random() * 7)));
          pieces.push(groupsOf(card).join(pick(separators)));
        } else if (roll < 0.7) {
          pieces.push(groupsOf(digitString(1 + Math.floor(random() * 19))).join(pick(separators)));
        } else {
          pieces.push(pick(neighbours));
        }
      }
      const text = pieces.reduce((acc, piece) => acc + (acc && random() < 0.5 ? pick(separators) : '') + piece, '');
      const expected: Array<[string, number]> = [];
      const actual: Array<[string, number]> = [];
      const want = digitOnlyScrubber(text, (m, o) => expected.push([m, o]));
      const got = redactCardNumbers(text, CARD_NUMBER_PLACEHOLDER, (m, o) => actual.push([m, o]));
      expect({ text, got, actual }).toEqual({ text, got: want, actual: expected });
      compared++;
      if (want !== text) redacted++;
    }
    expect(compared).toBe(4000);
    // The run exercised the redacting path, not just pass-through.
    expect(redacted).toBeGreaterThan(500);
  });
});

// A number word said just before (or after) a written card is read as a
// digit, so it joins the card's run. Searched from that word, a shorter
// window (the word and the first three groups) passed the Luhn check about
// one time in ten and was taken instead, leaving the card's last group in
// clear: the digit-only scrubber had redacted the whole card.
describe('redactCardNumbers — a written card beside a number word', () => {
  it('redacts the written card exactly as the digit-only scrubber did, and leaves the word', () => {
    for (const [text, want] of [
      ['card number one: 5410 6952 7846 2767', 'card number one: [card number]'],
      ['option two, 5208 7943 0457 0176', 'option two, [card number]'],
      ['es la tarjeta uno, 4341 6522 1706 0290', 'es la tarjeta uno, [card number]'],
      ['5650575480048\ncuatro,,49\t68411\t1628\t5085\t8510', '[card number]\ncuatro,,[card number]'],
    ]) {
      expect(redactCardNumbers(text)).toBe(want);
    }
  });

  // A card read partly as words and partly as digits is read in its groups
  // ("4111 one one one one, 1111 1111"). A number word beside any other
  // written number (an order or tracking number) joined it and passed the
  // Luhn check one time in ten.
  it('never joins a digit word to written digits that are not grouped like a card', () => {
    for (const text of ['option two, 172723237814996', 'ticket 412626 8402 8441 dos', 'tracking 285784454837 one']) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  it('still redacts every digit the digit-only scrubber did, on seeded text with number-word neighbours', () => {
    const random = seededRandom(0x0dd5);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
    const digitString = (n: number): string => Array.from({ length: n }, () => String(Math.floor(random() * 10))).join('');
    // Words that read as digits, pairs or fillers, said beside written digits.
    const numberWords = ['one', 'two', 'oh', 'o', 'four', 'nine', 'ten', 'eleven', 'twenty', 'forty', 'and', 'uh',
      'double one', 'number one', 'uno', 'dos', 'cero', 'cuatro', 'once', 'veinte', 'y', 'este', 'card two'];
    const others = ['card', 'tarjeta', 'nº', 'é', '#', '(', ')', '…', '[CREDIT_CARD_1]'];
    const separators = [' ', ', ', ',', '-', ' - ', '. ', '\t', '\n', ': ', ',,', ''];
    const groupsOf = (digits: string): string[] => {
      const groups: string[] = [];
      for (let i = 0; i < digits.length; ) {
        const size = random() < 0.6 ? 4 : 1 + Math.floor(random() * 7);
        groups.push(digits.slice(i, i + size));
        i += size;
      }
      return groups;
    };
    const covered = (text: string, scrub: typeof redactCardNumbers): boolean[] => {
      const marks = Array<boolean>(text.length).fill(false);
      scrub(text, CARD_NUMBER_PLACEHOLDER, (m, o) => marks.fill(true, o, o + m.length));
      return marks;
    };
    let redacting = 0;
    for (let n = 0; n < 4000; n++) {
      const pieces: string[] = [];
      for (let p = 0, count = 2 + Math.floor(random() * 5); p < count; p++) {
        const roll = random();
        if (roll < 0.35) pieces.push(groupsOf(withLuhnCheckDigit(digitString(12 + Math.floor(random() * 7)))).join(pick([' ', ' ', ', ', '-'])));
        else if (roll < 0.55) pieces.push(groupsOf(digitString(1 + Math.floor(random() * 19))).join(pick(separators)));
        else if (roll < 0.9) pieces.push(pick(numberWords));
        else pieces.push(pick(others));
      }
      const text = pieces.reduce((acc, piece) => acc + (acc ? pick(separators) : '') + piece, '');
      const tagged = text.replace(/\[CREDIT_CARD(?:_\d+)?\]/g, CARD_NUMBER_PLACEHOLDER);
      const want = covered(text, (t, p, on) => digitOnlyScrubber(t, on!));
      const got = covered(text, redactCardNumbers);
      const leaked = [...tagged].flatMap((ch, k) => (want[k] && !got[k] && /[0-9]/.test(ch) ? [k] : []));
      expect({ text, leaked, got: redactCardNumbers(text) }).toEqual({ text, leaked: [], got: expect.any(String) });
      if (want.some(Boolean)) redacting++;
    }
    expect(redacting).toBeGreaterThan(1000);
  });
});

// Whisper (the recording transcription worker) and other STT can write a
// card read aloud as words, and a Spanish caller reads it in Spanish.
describe('redactCardNumbers — a card number read out as words', () => {
  it('replaces an English card read as one unbroken run of digit words', () => {
    expect(
      redactCardNumbers('my card is four one one one one one one one one one one one one one one one'),
    ).toBe('my card is [card number]');
  });

  it('replaces an English card read in comma-separated groups, whatever the capitalisation', () => {
    expect(
      redactCardNumbers('Four one one one, one one one one, one one one one, One one one one. Thanks.'),
    ).toBe('[card number]. Thanks.');
  });

  it('replaces a Spanish card read in groups', () => {
    expect(
      redactCardNumbers(
        'mi tarjeta es cuatro uno uno uno, uno uno uno uno, uno uno uno uno, uno uno uno uno, gracias',
      ),
    ).toBe('mi tarjeta es [card number], gracias');
  });

  it('reads zero, oh and o as 0 in English and cero in Spanish (Discover test number)', () => {
    expect(
      redactCardNumbers('six oh one one, zero zero zero nine, nine o one three, nine four two four'),
    ).toBe('[card number]');
    expect(
      redactCardNumbers('es seis cero uno uno cero cero cero nueve nueve cero uno tres nueve cuatro dos cuatro'),
    ).toBe('es [card number]');
  });

  it('expands double and triple, and doble and triple', () => {
    expect(
      redactCardNumbers('four one double one, double one double one, one one one one, triple one one'),
    ).toBe('[card number]');
    expect(
      redactCardNumbers('cuatro uno doble uno, doble uno doble uno, uno uno uno uno, triple uno uno'),
    ).toBe('[card number]');
  });

  it('allows the fillers a caller says between groups: and, dash, uh, y', () => {
    expect(
      redactCardNumbers(
        'it is four one one one and one one one one dash one one one one, uh, one one one one ok',
      ),
    ).toBe('it is [card number] ok');
    expect(
      redactCardNumbers(
        'es cinco cinco cinco cinco y cinco cinco cinco cinco y cinco cinco cinco cinco y cuatro cuatro cuatro cuatro',
      ),
    ).toBe('es [card number]');
  });

  it('replaces a 15-digit Amex read in its 4-6-5 groups', () => {
    expect(
      redactCardNumbers('amex three seven eight two, eight two two four six three, one zero zero zero five'),
    ).toBe('amex [card number]');
  });

  it('replaces a card read partly as digits and partly as words', () => {
    expect(redactCardNumbers('card 4111 one one one one, 1111 1111 ok')).toBe('card [card number] ok');
    expect(redactCardNumbers('four one one one 1111 1111 1111')).toBe('[card number]');
  });

  it('keeps a CVV read after the card in words', () => {
    expect(
      redactCardNumbers('four one one one, one one one one, one one one one, one one one one, one two three'),
    ).toBe('[card number], one two three');
  });

  it('leaves a word-form run that fails the Luhn check untouched', () => {
    const text = 'four one one one one one one one one one one one one one one two';
    expect(redactCardNumbers(text)).toBe(text);
  });

  it('leaves a phone number read back in words untouched, with or without a zip after it', () => {
    for (const text of [
      'so that is six oh two five five five oh one nine nine, right?',
      // 602555019985006 passes the Luhn check: only the phone shape keeps it.
      'six oh two, five five five, oh one nine nine, eight five oh oh six',
      'mi número es seis cero dos cinco cinco cinco cero uno nueve nueve',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  it('leaves amounts, times and ordinary speech untouched', () => {
    for (const text of [
      'it came to two hundred fifty dollars, plus one twenty for parts',
      'one or two units, maybe three, oh and the second floor',
      'call me at one, I am free from two to four',
      'son doscientos cincuenta dólares, uno o dos días',
      'someone said nineteen eighty four, and the ozone alone is one thing',
      'double check the four units on one two three four Main Street',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  // A phone number and zip (or a house number) said with no pause are one run
  // of 13 to 15 digit words, and about one in ten passes the Luhn check. No
  // card issued today is 13 digits, and a 14 or 15 digit one starts like a
  // Diners Club International (36) or an Amex (34, 37).
  it('reads a phone number and zip, or a house number, said as one run of words as no card', () => {
    for (const text of [
      'call me at six oh four eight four four six four nine one one four eight one seven',
      'five two one eight five seven six three two seven four five four seven oh',
      // A phone number and a house number.
      'six eight four five five five oh one four two one six eight four',
      'three eight eight eight three nine six two eight eight nine nine four oh',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
    // An Amex read as one run of words is still a card.
    expect(redactCardNumbers('amex three seven eight two eight two two four six three one oh oh oh five')).toBe(
      'amex [card number]',
    );
  });

  it('leaves a phone number read as digit words with its last four in pairs untouched, with a zip after it', () => {
    const text = 'mi teléfono es siete ocho tres, cuatro nueve ocho, cero cinco, cero nueve, siete uno cinco tres nueve';
    expect(redactCardNumbers(text)).toBe(text);
  });

  // Years read digit by digit fall into groups of four as a card does, and
  // four of them joined pass the Luhn check one time in ten. A card has at
  // most one group that reads as a year, two where the card is mentioned.
  it('leaves a list of years read digit by digit untouched', () => {
    const text = 'two oh two five, two oh one two, two oh oh six, two oh oh five';
    expect(redactCardNumbers(text)).toBe(text);
    // 4929 8438 1983 1978: a card with two year-like groups.
    const card = 'four nine two nine, eight four three eight, one nine eight three, one nine seven eight';
    expect(redactCardNumbers(`my card is ${card}`)).toBe(`my card is ${MARKER}`);
    expect(redactCardNumbers(card)).toBe(card);
  });

  it('does not read double as a digit unless a digit word follows it', () => {
    expect(
      redactCardNumbers('double check: four one one one one one one one one one one one one one one one'),
    ).toBe('double check: [card number]');
  });

  it('reports the original word span and its offset to the listener', () => {
    const seen: Array<[string, number]> = [];
    const spoken = 'four one one one, one one one one, one one one one, one one one one';
    expect(redactCardNumbers(`card ${spoken} ok`, '[X]', (m, o) => seen.push([m, o]))).toBe('card [X] ok');
    expect(seen).toEqual([[spoken, 5]]);
  });
});

// Written as digits, STT leaves a space between the card and the CVV or
// expiry said after it ("4012888888881881 0427"), so they are separate
// groups. Written as words, every word is space-separated, so with no pause
// the card and the digits said straight after (or before) it are one run of
// words, and the card has to be cut out of it. Test card: Visa
// 4012 8888 8888 1881.
describe('redactCardNumbers — a card read as words that runs straight into other digit words', () => {
  const VISA_EN = 'four oh one two eight eight eight eight eight eight eight eight one eight eight one';
  const VISA_ES = 'cuatro cero uno dos ocho ocho ocho ocho ocho ocho ocho ocho uno ocho ocho uno';

  it('keeps the CVV said straight after the card', () => {
    expect(redactCardNumbers(`my card is ${VISA_EN} one two three thanks`)).toBe(
      'my card is [card number] one two three thanks',
    );
  });

  it('keeps the expiry said straight after the card, in English and in Spanish', () => {
    expect(redactCardNumbers(`${VISA_EN} oh four two seven`)).toBe('[card number] oh four two seven');
    expect(redactCardNumbers(`es ${VISA_ES} cero cuatro dos siete`)).toBe('es [card number] cero cuatro dos siete');
    // The month runs on; "twenty" ends the run.
    expect(redactCardNumbers(`${VISA_EN} oh four twenty seven`)).toBe('[card number] oh four twenty seven');
    // The month runs on, and the year comes after a pause.
    expect(redactCardNumbers(`${VISA_EN} oh four, twenty seven`)).toBe('[card number] oh four, twenty seven');
  });

  it("keeps an Amex's four-digit code said straight after it", () => {
    // Amex test number 3782 822463 10005.
    expect(
      redactCardNumbers('three seven eight two eight two two four six three one oh oh oh five one two three four'),
    ).toBe('[card number] one two three four');
  });

  it('cuts the card out of its last group when the expiry runs onto a card read in groups', () => {
    expect(
      redactCardNumbers(
        'four oh one two, eight eight eight eight, eight eight eight eight, one eight eight one oh four two seven',
      ),
    ).toBe('[card number] oh four two seven');
  });

  it('keeps a stray digit word said straight before the card', () => {
    expect(redactCardNumbers(`number one ${VISA_EN}`)).toBe('number one [card number]');
  });

  it('leaves long runs of digit words that are not a card untouched', () => {
    for (const text of [
      // 602555010285006: a phone number and zip. The whole fails the Luhn
      // check, but its first 13 digits and its last 13 pass. A card cut out
      // of words must be 15 to 19 digits, as cards issued today are.
      'call me back at six oh two five five five oh one oh two eight five oh oh six',
      // 94382844037879583025: its first 16 digits pass the Luhn check, but
      // no payment card starts with 9.
      'tracking nine four three eight two eight four four oh three seven eight seven nine five eight three oh two five',
      // 8113906652830166176: its last 16 digits pass the Luhn check, but a
      // card is cut from at most two digit words into a run.
      'my claim number is eight one one three nine oh six six five two eight three oh one six six one seven six',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  // A card is cut out of a run of words only where what is left reads like
  // what follows a card (a CVV or code, an expiry, both) or a stray digit
  // word before it. Any other cut is one more window that can pass the Luhn
  // check by chance: two phone numbers read back to back had one in three cut
  // into a "card", and each hit purges the call's audio.
  it('leaves two phone numbers read back to back as words untouched', () => {
    // 54833042145579777936: its first 19 digits pass the Luhn check; the one
    // digit left is no CVV or expiry.
    const text = 'five four eight three three oh four two one four five five seven nine seven seven seven nine three six';
    expect(redactCardNumbers(text)).toBe(text);
  });

  it('cuts a card out of a run of words only where the rest reads as a CVV or an expiry', () => {
    for (const text of [
      // 1820631810003635817: its last 17 digits pass the Luhn check, after two
      // stray words; a card cut out of words is 15 (Amex) or 16 digits.
      'one eight two oh six three one eight one oh oh oh three six three five eight one seven',
      // A 16-digit window whose last four, "1399", is no month and year.
      'reference four oh one two eight eight eight eight eight eight eight eight one eight eight one one three nine nine',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
    // The same card with an expiry, or a CVV and an expiry, after it.
    expect(
      redactCardNumbers('four oh one two eight eight eight eight eight eight eight eight one eight eight one one two two nine'),
    ).toBe('[card number] one two two nine');
    expect(
      redactCardNumbers(
        'four oh one two eight eight eight eight eight eight eight eight one eight eight one one two three oh four two seven',
      ),
    ).toBe('[card number] one two three oh four two seven');
  });

  it('reads a bare "o" beside Spanish digit words as "or", not zero', () => {
    // Two callback numbers: read as one 21-digit run, its last 19 digits
    // would be cut out as a card.
    const phones =
      'llámame al seis cero dos cinco cinco cinco cero uno nueve nueve o cuatro ocho cero cinco cinco cinco cero uno cero tres, gracias';
    expect(redactCardNumbers(phones)).toBe(phones);
    // "o sea" ("I mean") straight after a card ends the card.
    expect(redactCardNumbers(`mi tarjeta es ${VISA_ES} o sea la Visa`)).toBe('mi tarjeta es [card number] o sea la Visa');
    // Beside English digit words it is still "oh".
    expect(redactCardNumbers('six o one one, o o o nine, nine o one three, nine four two four')).toBe('[card number]');
  });
});

// A caller who pauses mid-number leaves several turns, each under 13 digits.
describe('redactCardNumbersAcrossTurns', () => {
  it('replaces the span each turn contributed to a card split over three turns', () => {
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111', '1111', '1111 thanks'])).toEqual([
      'my card is [card number]',
      '[card number]',
      '[card number] thanks',
    ]);
  });

  it('joins turns across the pause punctuation STT writes at a turn end', () => {
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111...', '1111, 1111.'])).toEqual([
      'my card is [card number]...',
      '[card number].',
    ]);
  });

  it('joins a card read as words over four turns, Spanish fillers included', () => {
    expect(
      redactCardNumbersAcrossTurns([
        'mi tarjeta es cuatro uno uno uno',
        'y uno uno uno uno',
        'uno uno uno uno',
        'uno uno uno uno',
      ]),
    ).toEqual(['mi tarjeta es [card number]', 'y [card number]', '[card number]', '[card number]']);
  });

  it('cuts the card out of the last turn when the caller runs straight on into the expiry', () => {
    expect(
      redactCardNumbersAcrossTurns([
        'four oh one two, eight eight eight eight',
        'eight eight eight eight',
        'one eight eight one oh four two seven',
      ]),
    ).toEqual(['[card number]', '[card number]', '[card number] oh four two seven']);
  });

  // A caller reading on after a pause often opens the next turn with a filler
  // or an acknowledgement of the agent's "go on".
  it('joins a continuation turn that opens with a filler', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'um, 1111 1111'])).toEqual([MARKER, `um, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'and 1111 1111'])).toEqual([MARKER, `and ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'uh... 1111', 'y 1111'])).toEqual([
      MARKER,
      `uh... ${MARKER}`,
      `y ${MARKER}`,
    ]);
    // A filler the earlier turn trails off with joins too.
    expect(redactCardNumbersAcrossTurns(['4111 1111, um', '1111 1111'])).toEqual([`${MARKER}, um`, MARKER]);
  });

  it('joins a continuation turn that opens with a short acknowledgement, in English and Spanish', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'Okay, 1111 1111'])).toEqual([MARKER, `Okay, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'ok 1111', 'so 1111'])).toEqual([
      MARKER,
      `ok ${MARKER}`,
      `so ${MARKER}`,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'vale, 1111 1111'])).toEqual([MARKER, `vale, ${MARKER}`]);
    expect(
      redactCardNumbersAcrossTurns(['cuatro uno uno uno, uno uno uno uno', 'bueno, uno uno uno uno', 'uno uno uno uno']),
    ).toEqual([MARKER, `bueno, ${MARKER}`, MARKER]);
  });

  it('joins a continuation turn that opens with an apology or a back-channel', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'Sorry, 1111 1111'])).toEqual([MARKER, `Sorry, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'mm-hmm, 1111 1111'])).toEqual([MARKER, `mm-hmm, ${MARKER}`]);
    // STT often drops the accent of "sí".
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'si, 1111 1111'])).toEqual([MARKER, `si, ${MARKER}`]);
  });

  it('joins a continuation turn that says which group comes next', () => {
    // "four" here counts the digits; it is not one of them.
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111', 'the next four are 1111'])).toEqual([
      MARKER,
      `the next four are ${MARKER}`,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111', 'and the last four digits are 1111.'])).toEqual([
      MARKER,
      `and the last four digits are ${MARKER}.`,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111', 'los últimos cuatro son 1111'])).toEqual([
      MARKER,
      `los últimos cuatro son ${MARKER}`,
    ]);
  });

  it('keeps fillers and acknowledgements inside a turn as they were', () => {
    // Between written groups in one turn only the written separators join.
    for (const text of ['4111 1111 um 1111 1111', '4111 1111, okay, 1111 1111', '4111 1111 1111 the next four are 1111']) {
      expect(redactCardNumbers(text)).toBe(text);
    }
    // An acknowledgement joins only at the start of the turn that reads on.
    expect(redactCardNumbersAcrossTurns(['4111 1111', '1111 okay 1111'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111 1111 okay', '1111 1111'])).toBeNull();
    // Still subject to every cross-turn rule: a zip after "okay" is not a group.
    expect(redactCardNumbersAcrossTurns(['4823', 'okay, 2018', 'um 85006'])).toBeNull();
  });

  it('leaves the turns alone when the joined digits fail the Luhn check', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', '1111 1112'])).toBeNull();
  });

  it('never stitches a phone number to the zip said in the next turn', () => {
    // 602555019985006 passes the Luhn check: only the phone shape keeps it.
    expect(redactCardNumbersAcrossTurns(['my number is 602 555 0199', '85006'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['six oh two five five five oh one nine nine', 'eight five oh oh six'])).toBeNull();
  });

  it('never stitches the bare numbers a caller answers an intake flow with', () => {
    // Each passes the Luhn check joined: a house number then a callback
    // number (48236025550199), and a zip, a year and a house number
    // (8500620184821). A card read with pauses is neither phone-shaped in
    // any turn nor starts outside 2–6.
    expect(redactCardNumbersAcrossTurns(['4823', '602 555 0199'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['85006', '2018', '4821'])).toBeNull();
  });

  // Each of these passes the Luhn check joined and starts with 2–6 (a zip in
  // 20000–69999, a house number starting 2–6), so the first-digit rule alone
  // let them through. A hit rewrites the caller's lines and flags the
  // recording for an early audio purge that cannot be undone. A card read in
  // turns is read in its groups: fours, Amex 4-6-5, halves of eight.
  it('never stitches intake answers whose digits are not grouped like a card read aloud', () => {
    for (const turns of [
      ['24', '1994', '58981', '1988', '24'], // quantity, year, zip, year, quantity
      ['4825', '33333', '54347'], // house number, two zips
      ['52721', '1980', '2007'], // zip, two years
      ['2687', '66521', '43543', '2088', '2019'],
      ['5', '3532', '29705', '1068', '18463'],
      ['zip is 30004', '4747', '63573.', '1237 dollars', "it's 17197"],
      ['$2794.37', '415', '66064', '5893 Main Street'], // price, house number, zip, address
      ['(768) 310-3352', '2062', '836.', '11'], // a phone whose area code STT bracketed
    ]) {
      expect(redactCardNumbersAcrossTurns(turns)).toBeNull();
    }
    // Even where the card is mentioned: an Amex is 4-6-5 only when it starts
    // 34 or 37, and a card never starts in the middle of a written number
    // ("987-2420").
    for (const turns of [
      ["it's 3129", '886299', '89558', '1396', '$2683'],
      ['five two eight six five', 'three five five six one three', 'seven three zero two eight'],
      ['(236) 987-2420', '2375', '0692', '1597216'],
    ]) {
      expect(redactCardNumbersAcrossTurns(turns, MARKER, AGENT_MENTIONS_CARD)).toBeNull();
    }
    // Groups of four one per turn and a last turn of seven read like a
    // 19-digit card only where the card is mentioned (see below).
    for (const turns of [
      ['1312', 'apartment 2323', '1991', '7439', '7069970'],
      ['4073', '6906', '1973', '5149259', '5:00'],
    ]) {
      expect(redactCardNumbersAcrossTurns(turns)).toBeNull();
    }
  });

  it('still stitches every way a card is read aloud in turns', () => {
    // Visa 4111 1111 1111 1111. A group of four per turn needs the card
    // mentioned (see below); here the agent did.
    expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'], MARKER, AGENT_MENTIONS_CARD)).toEqual(
      Array(4).fill(MARKER),
    );
    expect(redactCardNumbersAcrossTurns(['41111111', '11111111'])).toEqual([MARKER, MARKER]);
    expect(redactCardNumbersAcrossTurns(['4111', '1111 1111 1111'])).toEqual([MARKER, MARKER]);
    // A 19-digit Visa read 4-4-4-4-3, the last two groups together or apart.
    expect(redactCardNumbersAcrossTurns(['4000', '0000', '0000', '0000', '006'], MARKER, AGENT_MENTIONS_CARD)).toEqual(
      Array(5).fill(MARKER),
    );
    expect(redactCardNumbersAcrossTurns(['4000 0000', '0000', '0000 006'])).toEqual(Array(3).fill(MARKER));
    // Amex 3782 822463 10005 in its 4-6-5 groups.
    expect(redactCardNumbersAcrossTurns(['3782', '822463', '10005'])).toEqual(Array(3).fill(MARKER));
    expect(redactCardNumbersAcrossTurns(['3782 822463', '10005'])).toEqual([MARKER, MARKER]);
    // A Diners Club International 3614 890064 7913 in its 4-6-4 groups, and an
    // Amex read in fours (3782 8224 6310 005).
    expect(redactCardNumbersAcrossTurns(['card 3614', '890064', '7913'])).toEqual([`card ${MARKER}`, MARKER, MARKER]);
    expect(redactCardNumbersAcrossTurns(['3614 890064', '7913'])).toEqual([MARKER, MARKER]);
    expect(redactCardNumbersAcrossTurns(['3782 8224', '6310 005'])).toEqual([MARKER, MARKER]);
    // A 13-digit Visa: three fours, then the last digit.
    expect(redactCardNumbersAcrossTurns(['my card is 4222', '2222', '2222', '2'])).toEqual([
      `my card is ${MARKER}`,
      MARKER,
      MARKER,
      MARKER,
    ]);
  });

  // Years, gate codes, last-four answers and prices said one per turn are
  // groups of four, and joined they pass the Luhn check one time in ten: each
  // hit rewrote the caller's lines (the agent lost the years or codes) and
  // purged the recording's audio early.
  it('never stitches years said one per turn, written or as words', () => {
    for (const turns of [
      ['2025', '2012', '2006', '2005'],
      ['around 2011', '2021', '2010', '2009', '2016'],
      ['twenty eighteen', 'twenty twenty-six', 'twenty twelve', 'twenty eighteen'],
      // Two years among the groups are a list of years even where the card
      // is mentioned.
      ['my card is 2025', '2012', '2006', '2005'],
    ]) {
      expect(redactCardNumbersAcrossTurns(turns, MARKER, AGENT_MENTIONS_CARD)).toBeNull();
    }
  });

  it('stitches groups of four or fewer said one per turn only where the card is mentioned', () => {
    // Three gate codes and a quantity: 3287 9106 3649 7 passes the Luhn check.
    expect(redactCardNumbersAcrossTurns(['3287', '9106', '3649', '7'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'])).toBeNull();
    // A card already scrubbed earlier in the window is no mention.
    expect(redactCardNumbersAcrossTurns([MARKER, '3287', '9106', '3649', '7'])).toBeNull();
    // Mentioned by the caller, in a turn being read or before it.
    expect(redactCardNumbersAcrossTurns(['my card is 4111', '1111', '1111', '1111'])).toEqual([
      `my card is ${MARKER}`,
      MARKER,
      MARKER,
      MARKER,
    ]);
    expect(redactCardNumbersAcrossTurns(['I want to pay with my Visa', '4111', '1111', '1111', '1111'])).toEqual([
      'I want to pay with my Visa',
      ...Array(4).fill(MARKER),
    ]);
    expect(redactCardNumbersAcrossTurns(['mi tarjeta', '4111', '1111', '1111', '1111'])).toEqual([
      'mi tarjeta',
      ...Array(4).fill(MARKER),
    ]);
    // By a turn that reads on from the digits before it.
    expect(redactCardNumbersAcrossTurns(['4111', 'the next four are 1111', 'next four 1111', 'and the last four 1111'])).toEqual([
      MARKER,
      `the next four are ${MARKER}`,
      `next four ${MARKER}`,
      `and the last four ${MARKER}`,
    ]);
    // "The last four" alone is how a caller answers for an account or a
    // phone, not a mention of a card.
    // 2016 6231 1686 3207 passes the Luhn check.
    expect(redactCardNumbersAcrossTurns(['2016', '6231', 'last four 1686', 'last four 3207'])).toBeNull();
    // Or by the agent around the turns.
    expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'], MARKER, AGENT_MENTIONS_CARD)).toEqual(
      Array(4).fill(MARKER),
    );
    expect(
      redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'], MARKER, { agentLines: ['What is the gate code?'] }),
    ).toBeNull();
    // The agent talking about paying is no mention of a card: it says so while
    // it takes gate codes and years.
    expect(
      redactCardNumbersAcrossTurns(['3287', '9106', '3649', '7'], MARKER, {
        agentLines: ["I'll text you a payment link. What is the gate code?"],
      }),
    ).toBeNull();
  });

  it('does not join digits that do not touch the turn boundary', () => {
    expect(redactCardNumbersAcrossTurns(['card 4111 1111 1111 please', '1111'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111', 'what is it', '1111'])).toBeNull();
    // The earlier part was already replaced: the rest is 12 digits on its own.
    expect(redactCardNumbersAcrossTurns(['[card number]', '1111 1111 1111'])).toBeNull();
  });

  it('also scrubs a whole card inside one turn and maps the Deepgram tag (a stored row written before the scrubber)', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111 1111', 'ok', 'it was [CREDIT_CARD_1]'])).toEqual([
      '[card number]',
      'ok',
      'it was [card number]',
    ]);
  });

  it('returns null for a window with no card number', () => {
    expect(redactCardNumbersAcrossTurns(['I need a plumber', 'tomorrow at two'])).toBeNull();
    expect(redactCardNumbersAcrossTurns([])).toBeNull();
  });
});

/**
 * A seeded simulation of what a cross-turn false positive costs: callers
 * answer an intake flow with bare numbers in a row (house numbers, zips,
 * years, prices, phone numbers, quantities), and every stitched "card"
 * rewrites their lines and purges the recording's audio early. Before the
 * card-grouping rule (`readLikeACard`) 516 of these 20,000 bare-answer
 * sequences (2.6 %) and 142 of 20,000 with ordinary phrasing (0.7 %) were
 * stitched; with it, 25 (0.125 %) and 7 (0.035 %), every one three or four
 * four-digit answers in a row; with the year and mention rules, none.
 */
describe('redactCardNumbersAcrossTurns — seeded intake simulation', () => {
  const random = seededRandom(427);
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const anyDigits = (n: number): string => Array.from({ length: n }, () => String(int(0, 9))).join('');
  /** No leading zero: how a house number or a price is said. */
  const digits = (n: number): string => String(int(1, 9)) + anyDigits(n - 1);

  /** One intake answer: bare, or with the words a caller says around it. */
  function answer(bare: boolean): string {
    const say = (value: string, ...phrased: string[]): string => (bare ? value : pick([value, value, ...phrased]));
    switch (pick(['house', 'zip', 'year', 'price', 'phone', 'quantity'] as const)) {
      case 'house': {
        const n = digits(pick([1, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5]));
        return say(n, `it's ${n}`, `${n} Main Street`, `${n}.`);
      }
      case 'zip': {
        const z = String(int(1000, 99999)).padStart(5, '0');
        return say(z, `${z}.`, `zip is ${z}`, `it's ${z}`);
      }
      case 'year': {
        const y = String(int(1950, 2025));
        return say(y, `${y}.`, `it was ${y}`, `around ${y}`);
      }
      case 'price': {
        const p = int(20, 5000);
        const grouped = p >= 1000 ? `${Math.floor(p / 1000)},${String(p % 1000).padStart(3, '0')}` : String(p);
        return say(String(p), `$${p}`, `${p} dollars`, `$${grouped}`, `$${p}.${String(int(0, 99)).padStart(2, '0')}`);
      }
      case 'phone': {
        const [a, b, c] = [String(int(201, 989)), String(int(200, 999)), String(int(0, 9999)).padStart(4, '0')];
        return bare ? `${a} ${b} ${c}` : pick([`${a} ${b} ${c}`, `${a}-${b}-${c}`, `${a}${b}${c}`, `(${a}) ${b}-${c}`]);
      }
      case 'quantity': {
        const q = String(int(1, 24));
        return say(q, `${q} units`, `just ${q}`);
      }
    }
  }

  function stitchedSequences(bare: boolean): number {
    let stitched = 0;
    for (let n = 0; n < 20_000; n++) {
      const turns = Array.from({ length: int(2, 5) }, () => answer(bare));
      if (redactCardNumbersAcrossTurns(turns)) stitched++;
    }
    return stitched;
  }

  it('stitches none of 20,000 bare-answer sequences', () => {
    expect(stitchedSequences(true)).toBe(0);
  });

  it('stitches none of 20,000 sequences with ordinary phrasing', () => {
    expect(stitchedSequences(false)).toBe(0);
  });

  // A card read one group of four (or fewer) per turn is caught where the
  // card is mentioned: here the caller's first turn says so ("my card is"),
  // or else the agent does around the turns. Every other grouping needs no
  // mention.
  it('still catches every card read in its groups over several turns', () => {
    const groupings: ReadonlyArray<{ length: number; prefix: string; turns: number[] }> = [
      { length: 16, prefix: '4', turns: [4, 4, 4, 4] },
      { length: 16, prefix: '5', turns: [8, 8] }, // two halves of eight
      { length: 16, prefix: '6011', turns: [4, 4, 8] },
      { length: 16, prefix: '2', turns: [12, 4] },
      { length: 19, prefix: '4', turns: [4, 4, 4, 4, 3] },
      { length: 19, prefix: '6', turns: [8, 4, 7] },
      { length: 15, prefix: '37', turns: [4, 6, 5] }, // Amex
      { length: 15, prefix: '34', turns: [10, 5] },
      { length: 13, prefix: '4', turns: [4, 4, 4, 1] },
    ];
    const fours = (part: string): string => part.match(/.{1,4}/g)!.join(pick([' ', ' ', '-']));
    // An Amex is read 4-6-5: its first ten digits are never one unbroken
    // (phone-shaped) group.
    const amex = (part: string): string => (part.length === 10 ? `${part.slice(0, 4)} ${part.slice(4)}` : part);
    let caught = 0;
    let total = 0;
    for (const { length, prefix, turns } of groupings) {
      for (let n = 0; n < 300; n++) {
        const card = withLuhnCheckDigit(prefix + anyDigits(length - prefix.length - 1));
        const parts: string[] = [];
        turns.reduce((at, size) => (parts.push(card.slice(at, at + size)), at + size), 0);
        const spoken = parts.map((part, k) => {
          const written = length === 15 ? amex(part) : random() < 0.5 ? part : fours(part);
          const lead = k === 0 ? pick(['', 'my card is ', 'it is ']) : pick(['', '', '', 'um, ', 'okay, ', 'and ', 'so ']);
          const trail = k === parts.length - 1 ? pick(['', ' thanks', '.']) : pick(['', ',', '...']);
          return `${lead}${written}${trail}`;
        });
        const mentioned = turns.some((size) => size > 4) || spoken[0].startsWith('my card is');
        const agentLines = mentioned
          ? []
          : [
              pick([
                "Sorry, I can't take card numbers over the phone.",
                "For your security, please don't read your card number to me.",
                'Is that a credit card?',
              ]),
            ];
        total++;
        const rewritten = redactCardNumbersAcrossTurns(spoken, MARKER, { agentLines });
        if (rewritten && rewritten.every((t) => t.includes(MARKER)) && !/\d/.test(rewritten.join(' '))) caught++;
      }
    }
    expect(caught).toBe(total);
  });
});

/**
 * The answers that are groups of four themselves, one per turn: years
 * (equipment put in 2005, 2012, 2018), gate and lockbox codes, last-four
 * answers and prices, written or said as words. Joined they are read exactly
 * like a card read group by group: before the year and mention rules 35, 133
 * and 323 of these 5,000-sequence sets were stitched.
 */
describe('redactCardNumbersAcrossTurns — seeded simulation of four-digit answers', () => {
  const random = seededRandom(2026);
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const four = (): string => String(int(0, 9999)).padStart(4, '0');
  const year = (): number => int(2000, 2026);
  const sequences: Record<string, () => string[]> = {
    'equipment years': () => Array.from({ length: int(3, 5) }, () => pick(['', '', 'around ', 'in ', 'it was '])  + `${year()}${pick(['', '.'])}`),
    'three codes and a quantity': () => [four(), four(), pick(['', 'the code is ']) + four(), String(int(1, 12))],
    'four-digit answers': () =>
      Array.from({ length: int(3, 5) }, () => pick([String(year()), four(), `last four ${four()}`, String(int(1000, 9999))])),
  };

  it('stitches none of 15,000 such sequences', () => {
    const stitched: Record<string, string[][]> = {};
    for (const [kind, make] of Object.entries(sequences)) {
      stitched[kind] = [];
      for (let n = 0; n < 5000; n++) {
        const turns = make();
        if (redactCardNumbersAcrossTurns(turns)) stitched[kind].push(turns);
      }
    }
    expect(stitched).toEqual(Object.fromEntries(Object.keys(sequences).map((kind) => [kind, []])));
  });
});

// The recording boundary re-reads a whole leg's stored turns, in case the
// live rewrite of the stored rows failed or had not landed yet; it must read
// the caller's turns exactly as the live path did, turn by turn, in the same
// window, with the agent's lines around them.
describe('redactCardNumbersInCallTurns', () => {
  const at = (seconds: number) => seconds * 1000;
  const caller = (text: string, seconds: number) => ({ speaker: 'caller' as const, text, at: at(seconds) });
  const agent = (text: string, seconds: number) => ({ speaker: 'agent' as const, text, at: at(seconds) });

  it('finds a card split across turns said within a minute, as the live window does', () => {
    expect(
      redactCardNumbersInCallTurns([
        caller('I need a plumber', 0),
        agent('Sure, what is the address?', 5),
        caller('my card is 4111 1111', 10),
        agent('go on', 12),
        caller('1111', 14),
        caller('1111 thanks', 20),
      ]),
    ).toEqual(['I need a plumber', 'Sure, what is the address?', `my card is ${MARKER}`, 'go on', MARKER, `${MARKER} thanks`]);
  });

  it('never joins a turn said more than a minute before', () => {
    expect(redactCardNumbersInCallTurns([caller('4111 1111', 0), caller('1111 1111', 61)])).toBeNull();
  });

  it("reads the agent's lines around the window for a mention of the card, and never rewrites them", () => {
    const groups = ['4111', '1111', '1111', '1111'];
    // A group of four per turn, and nobody mentions the card: no card.
    expect(
      redactCardNumbersInCallTurns([agent('What is the gate code?', 0), ...groups.map((g, k) => caller(g, 2 + k))]),
    ).toBeNull();
    // The agent's line before the window mentions it.
    expect(
      redactCardNumbersInCallTurns([
        agent('I can text you a link to pay by card.', 0),
        ...groups.map((g, k) => caller(g, 2 + k)),
      ]),
    ).toEqual(['I can text you a link to pay by card.', ...Array(4).fill(MARKER)]);
    // A line between the turns mentions it; the agent's own digits stay.
    expect(
      redactCardNumbersInCallTurns([
        caller('4111', 0),
        agent("Sorry, I can't take card numbers, 1111.", 1),
        caller('1111', 2),
        caller('1111', 3),
        caller('1111', 4),
      ]),
    ).toEqual([MARKER, "Sorry, I can't take card numbers, 1111.", MARKER, MARKER, MARKER]);
  });

  it('reads a long call turn by turn: every card in it is found, each in its own window', () => {
    // A 19-digit card over the first five turns, then a 16-digit one over the
    // next two (read with the three markers before it, which join nothing).
    const turns = ['my card is 4000', '0000', '0000', '0000', '006', '4111 1111', '1111 1111'].map((text, k) =>
      caller(text, k),
    );
    expect(redactCardNumbersInCallTurns(turns)).toEqual([`my card is ${MARKER}`, ...Array(6).fill(MARKER)]);
    // A turn with no digits between the halves ends the run, as live.
    expect(
      redactCardNumbersInCallTurns([caller('4111 1111', 0), caller('sorry, what?', 2), caller('1111 1111', 4)]),
    ).toBeNull();
  });

  it('returns null when nothing changes, and leaves a clean (already rewritten) call alone', () => {
    expect(redactCardNumbersInCallTurns([])).toBeNull();
    expect(
      redactCardNumbersInCallTurns([caller(`my card is ${MARKER}`, 0), caller(MARKER, 3), caller(`${MARKER} thanks`, 6)]),
    ).toBeNull();
  });
});

describe('agentLinesAround', () => {
  it("takes the agent's last line before the window's first turn and every agent line after it", () => {
    const lines = [
      { speaker: 'agent' as const, text: 'hi' },
      { speaker: 'caller' as const, text: 'I need a plumber' },
      { speaker: 'agent' as const, text: 'what is the address?' },
      { speaker: 'caller' as const, text: '12 Main' },
      { speaker: 'caller' as const, text: '4111' },
      { speaker: 'agent' as const, text: 'go on' },
      { speaker: 'caller' as const, text: '1111' },
      { speaker: 'agent' as const, text: 'said after the current turn' },
    ];
    // Window: the caller turns at 3, 4 and 6; the current turn is 6.
    expect(agentLinesAround(lines, 3, 6)).toEqual(['what is the address?', 'go on']);
    // No agent line before the first turn.
    expect(agentLinesAround(lines.slice(1), 0, 3)).toEqual(['what is the address?']);
  });
});

describe('containsCardNumber', () => {
  it('is true for text that carries the marker and false otherwise', () => {
    expect(CARD_NUMBER_PLACEHOLDER).toBe('[card number]');
    expect(containsCardNumber('caller: my card is [card number]')).toBe(true);
    expect(containsCardNumber('caller: what is my card number on file')).toBe(false);
  });
});
