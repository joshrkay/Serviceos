/**
 * PRIV-3 — the one card-number scrubber every store and provider path uses.
 *
 * Expected values are written out by hand from the card networks' published
 * test numbers (Luhn-valid by construction) and from the audit's probe
 * samples — never recomputed the way the scrubber computes them.
 */
import { describe, expect, it } from 'vitest';
import { CARD_NUMBER_PLACEHOLDER, containsCardNumber, redactCardNumbers } from '../../../src/ai/privacy/pan-redact';

const MARKER = CARD_NUMBER_PLACEHOLDER;

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

describe('containsCardNumber', () => {
  it('is true for text that carries the marker and false otherwise', () => {
    expect(CARD_NUMBER_PLACEHOLDER).toBe('[card number]');
    expect(containsCardNumber('caller: my card is [card number]')).toBe(true);
    expect(containsCardNumber('caller: what is my card number on file')).toBe(false);
  });
});
