/**
 * PRIV-3 — the one card-number scrubber every store and provider path uses.
 *
 * Expected values are written out by hand from the card networks' published
 * test numbers (Luhn-valid by construction) and from the audit's probe
 * samples — never recomputed the way the scrubber computes them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentLinesBefore,
  CARD_NUMBER_PLACEHOLDER,
  type CardSplitContext,
  containsCardNumber,
  redactCardNumbers,
  redactCardNumbersAcrossTurns,
  redactCardFragments,
  redactCardNumbersInCallTurns,
} from '../../../src/ai/privacy/pan-redact';
import { digitOnlyScrubber, seededRandom, withLuhnCheckDigit } from './card-number-corpus';

const MARKER = CARD_NUMBER_PLACEHOLDER;

/** A test number read out digit by digit ("3056" → "three zero five six"). */
const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const spell = (digits: string): string => [...digits].map((d) => DIGIT_NAMES[Number(d)]).join(' ');

/** The agent mentions the card right before the caller's turns. */
const AGENT_MENTIONS_CARD = { agentLines: [["I'm sorry, I can't take card numbers over the phone."]] };

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
    // An Amex read as one run of words is still a card where it is named…
    expect(redactCardNumbers('amex three seven eight two eight two two four six three one oh oh oh five')).toBe(
      'amex [card number]',
    );
    // …but a phone number and a zip said with no pause are 15 digit words
    // too, and 346 and 347 are area codes: 370 699 2688 71523 and 341 955
    // 5636 94226 pass the Luhn check and start like an Amex.
    for (const text of [
      'call me at three seven oh six nine nine two six eight eight seven one five two three',
      'three four one nine five five five six three six nine four two two six',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  // Diners Club International is issued at 14 to 19 digits from every one of
  // its ranges (300–305, 3095, 36, 38–39), not only 36; the networks' 14-digit
  // test numbers start 305 and 38. Read with its pauses (4-6-4), a Diners 14
  // is a card whatever range it is from; read as one run of words, 14 digit
  // words are a phone number and a house number as often (see above), so
  // there the card must be named near it, as for a cut, and only one from 36
  // is taken (see below).
  it('reads a Diners Club 14 from 300–305, 3095 or 38–39 as a card, as one from 36', () => {
    for (const card of ['30569309025904', '38520000023237', '30000000000004', '30951234567897', '39123456789010', '36227206271667']) {
      const groups = [card.slice(0, 4), card.slice(4, 10), card.slice(10)];
      const spoken = groups.map(spell).join(', ');
      expect(redactCardNumbers(`my diners card is ${spoken}`)).toBe(`my diners card is ${MARKER}`);
      expect(redactCardNumbers(spoken)).toBe(MARKER);
      // The CVV said straight after the last group.
      expect(redactCardNumbers(`my card is ${spoken} one two three`)).toBe(`my card is ${MARKER} one two three`);
      // Read as one run of words with the CVV run on (a cut): only with the card named near it.
      expect(redactCardNumbers(`my card is ${spell(card)} one two three`)).toBe(`my card is ${MARKER} one two three`);
      expect(redactCardNumbers(`${spell(card)} one two three`)).toBe(`${spell(card)} one two three`);
      // Read as one run of words and nothing else: only from 36, and only
      // with the card named near it.
      expect(redactCardNumbers(`my card is ${spell(card)}`)).toBe(card.startsWith('36') ? `my card is ${MARKER}` : `my card is ${spell(card)}`);
      expect(redactCardNumbers(spell(card))).toBe(spell(card));
      // Written, the digit path always took it.
      expect(redactCardNumbers(`card ${groups.join(' ')}`)).toBe(`card ${MARKER}`);
    }
    // In groups no card is read in, 14 digit words are a serial or reference
    // number (3894 9325 6957 51 passes the Luhn check): only with the card named.
    const serial = 'serial number four six two, and three eight nine, four nine three, and two five six nine five seven, and five one';
    expect(redactCardNumbers(serial)).toBe(serial);
    expect(redactCardNumbers('confirmation number three six nine seven nine nine four six one eight one two five five')).toBe(
      'confirmation number three six nine seven nine nine four six one eight one two five five',
    );
    expect(redactCardNumbers('my card is three eight nine, four nine three, two five six nine five seven, five one')).toBe(
      `my card is ${MARKER}`,
    );
    // 15 digits from those ranges are no card (an Amex's length alone):
    // 3056 930902 59049 passes the Luhn check.
    const fifteen = 'my card is three oh five six, nine three oh nine oh two, five nine oh four nine';
    expect(redactCardNumbers(fifteen)).toBe(fifteen);
  });

  // 300–305 and 38–39 start area codes (301–305, 380–399): a phone number
  // read as one run of words with four more digits straight after it (a gate
  // code, an extension) is 14 digit words starting like a Diners Club, and
  // one in ten passes the Luhn check. With the card named a few words before
  // it ("I'll pay by card at the visit, my number is …"), 1,040 and 1,008 of
  // 10,000 such phone numbers from 301–305 and 380/385/386 were replaced and
  // their recording's audio purged. A Diners Club's 14 read with no pause at
  // all is taken only from 36, its main range; from the others it is read in
  // its groups, cut with its CVV or expiry run on, or over turns.
  it('reads a phone number from 301–305 or 380–399 and four more digits said as one run of words as no card, even with the card named', () => {
    // Each passes the Luhn check as 14 digits.
    for (const digits of ['30154794486521', '30445770482504', '38570107934422', '38647214776811', '38025157356521', '39267043492602']) {
      const text = `I'll pay by card at the visit, my number is ${spell(digits)}`;
      expect(redactCardNumbers(text), digits).toBe(text);
      expect(redactCardNumbersAcrossTurns(["I'll pay by card at the visit", `my number is ${spell(digits)}`]), digits).toBeNull();
    }
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

// More of how a card is read aloud: the hesitations callers make between
// groups, a line break where a transcript wraps, and digits read in pairs
// ("forty-one eleven"), as people read a card's groups of four.
describe('redactCardNumbers — fillers, line breaks and a card read in pairs', () => {
  it('allows the fillers er, ah, este and pues between groups', () => {
    expect(
      redactCardNumbers('four one one one er one one one one ah one one one one, um, one one one one'),
    ).toBe(MARKER);
    expect(
      redactCardNumbers('es cuatro uno uno uno este uno uno uno uno pues uno uno uno uno, eh, uno uno uno uno'),
    ).toBe(`es ${MARKER}`);
  });

  it('reads a line break between spoken groups as a pause', () => {
    expect(redactCardNumbers('my card is four one one one\none one one one\none one one one\r\none one one one\nthanks')).toBe(
      `my card is ${MARKER}\nthanks`,
    );
    // Between written groups only the written separators join, as they always
    // did (the digit path is unchanged).
    expect(redactCardNumbers('4111\n1111\n1111\n1111')).toBe('4111\n1111\n1111\n1111');
  });

  it('reads English tens and teens as their two digits', () => {
    // Visa 4111 1111 1111 1111.
    expect(redactCardNumbers('the card is forty-one eleven, eleven eleven, eleven eleven, eleven eleven')).toBe(
      `the card is ${MARKER}`,
    );
    expect(redactCardNumbers('my card is forty one eleven eleven eleven eleven eleven eleven eleven')).toBe(
      `my card is ${MARKER}`,
    );
    // Mastercard 2221 0000 0000 0009: "twenty" and "twenty-one".
    expect(redactCardNumbers('Mastercard twenty-two twenty-one, oh oh oh oh, oh oh oh oh, oh oh oh nine')).toBe(
      `Mastercard ${MARKER}`,
    );
    // Digit words and pairs mixed in one group.
    expect(redactCardNumbers('pay with my card, four one eleven, one one one one, eleven eleven, one one eleven')).toBe(
      `pay with my card, ${MARKER}`,
    );
  });

  it('reads Spanish tens and teens as their two digits', () => {
    // 4111 2016 1111 1115: "cuarenta y uno", "once", "veinte", "dieciséis", "quince".
    expect(
      redactCardNumbers('mi tarjeta es cuarenta y uno once, veinte dieciséis, once once, once quince, gracias'),
    ).toBe(`mi tarjeta es ${MARKER}, gracias`);
    expect(redactCardNumbers('la tarjeta cuarenta y uno once once once once once once once')).toBe(`la tarjeta ${MARKER}`);
  });

  // Read in pairs, four house numbers, a run of prices or a list of times can
  // fall into fours just as a card does, so a card read in pairs is caught
  // only where the card is mentioned in the same text (across turns: in the
  // window or by the agent, see redactCardNumbersAcrossTurns).
  it('reads pairs as a card only where the card is mentioned', () => {
    for (const text of [
      'forty-one eleven, eleven eleven, eleven eleven, eleven eleven',
      'cuarenta y uno once once once once once once once',
      'we own fifty eighty-nine, forty-nine eighty-one, twelve sixty-one sixty-four seventy-eight Main',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
    // Written digits and digit words need no mention, as before.
    expect(redactCardNumbers('four one one one, one one one one, one one one one, one one one one')).toBe(MARKER);
  });

  it('leaves amounts, times, quantities and ordinary speech untouched', () => {
    for (const text of [
      'it was forty-five dollars, and I can do eleven thirty tomorrow',
      'we need twenty units and fifteen boxes, maybe sixteen',
      'I was born in nineteen eighty four and moved here in twenty twenty',
      'one two three four five six seven eight nine ten eleven twelve',
      'ages eleven and twelve, and four dogs',
      'son cuarenta y cinco dólares, a las once y media',
      'quiero veinte unidades y quince cajas',
      // English "once" and "quince" are not numbers beside English words.
      'I called once, four times maybe; the quince jam is twelve ninety nine',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  // Each pair is two digits, and a comma, "and", "y" or "uh" joins spoken
  // groups, so a list of three to five times, years or prices was a 13–19
  // digit run that only the Luhn check stood between and a "card": each hit
  // flags the recording for an audio purge that cannot be undone. A card read
  // in pairs is read in its groups of four (two pairs each).
  it('leaves lists of times, years and prices read in pairs untouched', () => {
    for (const text of [
      'we have openings at nine thirty, twelve fifteen, four forty-five and five thirty',
      'I can do ten thirty, eight fifty, uh, twelve forty and one ten, eight twenty',
      'it was twenty six and thirty four, eighty four seventy-one, fifty-six twenty one, eighty twelve dollars',
      // Grouped in fours, but they are years.
      'the systems are from twenty oh five, twenty oh six, twenty oh seven and twenty fourteen',
      'puedo a las dos cuarenta, diez cuarenta y cinco, uh, tres veinte, uno treinta',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  it('leaves phone numbers read in pairs untouched, with a zip or another phone after them', () => {
    for (const text of [
      // A US number read 3-3-2-2, then a zip.
      'mi teléfono es siete ocho tres, cuatro noventa y ocho, cero cinco, cero nueve, siete uno cinco tres nueve',
      // Two US numbers read 3-3-2-2.
      'dos cero uno, dos ochenta y ocho, ochenta y ocho, ochenta y uno, cinco cuatro tres, cinco cincuenta, ochenta, veintiuno',
      // A Mexican number read in five pairs, then a zip; and two of them.
      'es el cuarenta, ochenta y cinco, noventa y ocho, diecisiete, sesenta y ocho, nueve uno nueve cuatro ocho',
      'quince, cincuenta y tres, cuarenta y cinco, setenta y uno, sesenta y tres, veintisiete, treinta y dos, cuarenta, cincuenta y tres, setenta y dos',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  it('never joins a pair to written digits that are not grouped like a card', () => {
    for (const text of ['it was twenty, 5390111878303211', 'box twelve, 626805 6793 4187']) {
      expect(redactCardNumbers(text)).toBe(text);
    }
    // Nor shortens the written card it is said beside.
    expect(redactCardNumbers('twenty, 5315 6865 9304 8163')).toBe(`twenty, ${MARKER}`);
  });

  it('applies the Luhn check and the card lengths to pairs unchanged', () => {
    // One digit off the Visa: fails the Luhn check.
    const offByOne = 'forty-one eleven, eleven eleven, eleven eleven, eleven twelve';
    expect(redactCardNumbers(offByOne)).toBe(offByOne);
    // Twelve digits: too short for a card.
    const short = 'forty-one eleven, eleven eleven, eleven eleven';
    expect(redactCardNumbers(short)).toBe(short);
  });
});

/**
 * What counts as the card being mentioned, and where. A hit rewrites the
 * caller's words and purges the recording's audio early, which cannot be
 * undone, so the rules that need a mention (a card read in pairs, two
 * year-shaped groups, a group of four per turn) take only words that name a
 * card, said near the digits: talk of paying ("can I pay now", "store
 * credit", "debit or cash", "I want to discover what is wrong") goes with
 * gate codes and years as often as with a card.
 */
describe('the card mention: card words only, near the digits', () => {
  const PAIRS = 'forty-one eleven, eleven eleven, eleven eleven, eleven eleven';

  it('takes only words that name a card, a card network or its security code', () => {
    for (const cue of ['my card is', 'credit card', 'debit card', 'card number', 'Visa', 'Mastercard', 'master card', 'Amex', 'American Express', 'the Discover card', 'mi tarjeta es', 'número de tarjeta', 'tarjeta de crédito', 'the cvv is after']) {
      expect(redactCardNumbers(`${cue} ${PAIRS}`)).toBe(`${cue} ${MARKER}`);
    }
    for (const talk of ['can I pay now', "I'm paying today", 'about the payment', 'I have store credit', 'debit or cash', 'I want to discover', 'quiero pagar', 'el pago', 'tengo crédito', 'débito']) {
      const text = `${talk} ${PAIRS}`;
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  it('takes a mention only within a few words of the digits, never anywhere in a whole recording', () => {
    expect(redactCardNumbers(`my card number is uh let me grab it okay it is ${PAIRS}`)).toBe(
      `my card number is uh let me grab it okay it is ${MARKER}`,
    );
    const tooFar = `my card number is uh hold on one second let me go and grab my wallet from the car okay ${PAIRS}`;
    expect(redactCardNumbers(tooFar)).toBe(tooFar);
    expect(redactCardNumbers(`${PAIRS}, and that is the card`)).toBe(`${MARKER}, and that is the card`);
    // The transcription worker scrubs a whole call as one text: a card
    // mentioned at the start says nothing of numbers read minutes later.
    const recording = [
      'my card was declined last week so I would rather pay cash when you come out',
      'the water heater is in the garage and it has been leaking since Sunday',
      'the house is on the corner and there is a side gate you can use',
      `the units are ${PAIRS}`,
    ].join('. ');
    expect(redactCardNumbers(recording)).toBe(recording);
  });

  it('allows a second year-shaped group only where the card is mentioned near it', () => {
    // Visa 4111 1999 2005 0000: two of its groups read as years.
    const years = 'four one one one, one nine nine nine, two oh oh five, oh oh oh oh';
    expect(redactCardNumbers(`my card is ${years}`)).toBe(`my card is ${MARKER}`);
    expect(redactCardNumbers(`can I pay now, ${years}`)).toBe(`can I pay now, ${years}`);
  });
});

describe('redactCardNumbersAcrossTurns — the card mentioned near the turns', () => {
  const GROUPS = ['4111', '1111', '1111', '1111'];

  it('takes no talk of paying as a mention, from the caller or the agent', () => {
    for (const talk of ['can I pay now', 'I have a store credit', 'do you take debit', 'I want to discover the problem', 'quiero pagar']) {
      expect(redactCardNumbersAcrossTurns([talk, ...GROUPS])).toBeNull();
    }
    expect(redactCardNumbersAcrossTurns(GROUPS, MARKER, { agentLines: [['Do you want to pay by credit or debit?']] })).toBeNull();
  });

  it("takes a mention in the card's own turns, the caller's turn just before them, or the agent's lines right before and between them", () => {
    expect(redactCardNumbersAcrossTurns(['my card is 4111', '1111', '1111', '1111'])).toEqual([
      `my card is ${MARKER}`,
      MARKER,
      MARKER,
      MARKER,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111 is my Visa'])).toEqual([MARKER, MARKER, MARKER, `${MARKER} is my Visa`]);
    expect(redactCardNumbersAcrossTurns(['it goes on my Visa', ...GROUPS])).toEqual(['it goes on my Visa', ...Array(4).fill(MARKER)]);
    expect(
      redactCardNumbersAcrossTurns(GROUPS, MARKER, { agentLines: [["Sorry, I can't take card numbers."]] }),
    ).toEqual(Array(4).fill(MARKER));
    expect(
      redactCardNumbersAcrossTurns(GROUPS, MARKER, { agentLines: [[], [], ["Please don't read me your card."], []] }),
    ).toEqual(Array(4).fill(MARKER));
    // The turn before a window of five: a 19-digit card read group by group.
    expect(
      redactCardNumbersAcrossTurns(['4000', '0000', '0000', '0000', '006'], MARKER, { callerTurnBefore: 'my card number is' }),
    ).toEqual(Array(5).fill(MARKER));
  });

  // The agent's own approval-card copy (tts-copy: voice_approval_refusal,
  // inapp_incomplete_draft) names the proposal card on screen, not a payment
  // card; on an owner-line call it is said right before amounts and codes.
  it("takes the agent's approval-card copy as no mention of a payment card", () => {
    for (const line of [
      "Tap the card to approve — I don't take approvals by voice here yet.",
      'Toque la tarjeta para aprobar — aquí todavía no acepto aprobaciones por voz.',
      "I've drafted that, but it still needs a few details before it can be approved — open the card to fill them in. Is there anything else I can help you with?",
      'Lo dejé como borrador, pero le faltan algunos datos antes de poder aprobarlo — abra la tarjeta para completarlos. ¿Hay algo más en lo que pueda ayudarle?',
    ]) {
      expect(redactCardNumbersAcrossTurns(GROUPS, MARKER, { agentLines: [[line]] }), line).toBeNull();
      const pairs = 'forty-one eleven, eleven eleven, eleven eleven, eleven eleven';
      expect(redactCardNumbers(`${line} ${pairs}`)).toBe(`${line} ${pairs}`);
    }
    // A payment card named in the same line still counts.
    expect(
      redactCardNumbersAcrossTurns(GROUPS, MARKER, { agentLines: [["Tap the card to approve. And please don't read me your credit card."]] }),
    ).toEqual(Array(4).fill(MARKER));
  });

  it('takes no mention two turns or more before the card, or from an agent line further back', () => {
    expect(redactCardNumbersAcrossTurns(['can I use my card at the visit', 'the gate is on the left', '3287', '9106', '3649', '7'].slice(0, 5))).toBeNull();
    expect(redactCardNumbersAcrossTurns(['I paid by card last time', 'it is the blue house', ...GROUPS].slice(-5))).toBeNull();
    expect(
      redactCardNumbersAcrossTurns(['the blue house', ...GROUPS], MARKER, { agentLines: [['We take all major credit cards.'], [], [], [], []] }),
    ).toBeNull();
    expect(
      redactCardNumbersAcrossTurns(GROUPS, MARKER, { callerTurnBefore: 'I paid by card last time', agentLines: [['What is the gate code?']] }),
    ).toEqual(Array(4).fill(MARKER));
  });

  // The cross-turn search also finds what lies wholly inside one turn, and
  // reads every turn the live path appends: a mention inside a turn counts
  // only near the digits, as it does in one text (`redactCardNumbers`), so a
  // card named in passing at the start of a long turn makes no "card" of the
  // times read out at its end. The same holds for the turn's own digits in a
  // window over several turns, and for the caller's turn just before them.
  describe('a mention in a long turn', () => {
    // 4118 1215 1230 1545 passes the Luhn check: four times read in pairs.
    const TIMES = 'forty-one eighteen, twelve fifteen, twelve thirty, fifteen forty-five';
    const AFTER_THE_MENTION =
      'and the technician said the unit was old and the filter was dirty and the coil needed cleaning and he would come back next week to check the pressure again after the part arrives.';
    const FAR = `I will pay by card when he comes. ${AFTER_THE_MENTION}`;
    const turn = `${FAR} the times he gave me were ${TIMES}`;

    it('counts only within a few words of a window inside that turn, as in one text', () => {
      expect(redactCardNumbers(turn)).toBe(turn);
      expect(redactCardNumbersAcrossTurns(['okay', turn])).toBeNull();
      expect(redactCardNumbersAcrossTurns([turn])).toBeNull();
      expect(
        redactCardNumbersInCallTurns([
          { speaker: 'caller', text: 'hi', at: 1_000_000 },
          { speaker: 'agent', text: 'Go ahead.', at: 1_003_000 },
          { speaker: 'caller', text: turn, at: 1_006_000 },
        ]),
      ).toBeNull();
      // Near the digits it still counts, before them or after.
      const near = `${FAR} my card number is ${TIMES}`;
      expect(redactCardNumbersAcrossTurns(['okay', near])).toEqual(['okay', `${FAR} my card number is ${MARKER}`]);
      expect(redactCardNumbersAcrossTurns(['okay', `${TIMES}, that is my card`])).toEqual(['okay', `${MARKER}, that is my card`]);
    });

    it("counts in a turn of a window over several turns only near the digits that turn gives", () => {
      expect(redactCardNumbersAcrossTurns([`${FAR} the gate code is 4111`, '1111', '1111', '1111'])).toBeNull();
      expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', `1111. ${AFTER_THE_MENTION} I will pay by card`])).toBeNull();
      expect(redactCardNumbersAcrossTurns([`${FAR} my card is 4111`, '1111', '1111', '1111'])).toEqual([
        `${FAR} my card is ${MARKER}`,
        MARKER,
        MARKER,
        MARKER,
      ]);
      expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', `1111, that is the card. ${AFTER_THE_MENTION}`])).toEqual([
        MARKER,
        MARKER,
        MARKER,
        `${MARKER}, that is the card. ${AFTER_THE_MENTION}`,
      ]);
    });

    it("counts in the caller's turn just before only near its end", () => {
      expect(redactCardNumbersAcrossTurns([FAR, TIMES])).toBeNull();
      expect(redactCardNumbersAcrossTurns([FAR, '4111', '1111', '1111', '1111'])).toBeNull();
      expect(redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'], MARKER, { callerTurnBefore: FAR })).toBeNull();
      expect(redactCardNumbersAcrossTurns([`${AFTER_THE_MENTION} so I want to pay with my card`, TIMES])).toEqual([
        `${AFTER_THE_MENTION} so I want to pay with my card`,
        MARKER,
      ]);
      expect(
        redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'], MARKER, { callerTurnBefore: 'okay, my card number is' }),
      ).toEqual(Array(4).fill(MARKER));
    });
  });

  // A stitched or cut window takes only the lengths a card is issued at for
  // its first digits: an Amex is 15, a Mastercard 16, a Visa 13, 16 or 19, a
  // Diners Club 14 to 19, Discover, JCB and UnionPay 16 to 19, and a card
  // starting 2 is a Mastercard (2221–2720) or none.
  it('stitches only lengths a card is issued at for its first digits', () => {
    const cue = { agentLines: [["Sorry, I can't take card numbers."]] };
    // 2018 0000 0000 0006 passes the Luhn check, but no card starts 2018.
    expect(redactCardNumbersAcrossTurns(['2018', '0000', '0000', '0006'], MARKER, cue)).toBeNull();
    // A 2-series Mastercard does: 2221 0000 0000 0009.
    expect(redactCardNumbersAcrossTurns(['2221', '0000', '0000', '0009'], MARKER, cue)).toEqual(Array(4).fill(MARKER));
    // A Mastercard is never 19 digits (5100 0000 0000 0000 003 passes Luhn).
    expect(redactCardNumbersAcrossTurns(['5100', '0000', '0000', '0000', '003'], MARKER, cue)).toBeNull();
    // A 15-digit window is an Amex or nothing (4111 1111 1111 116 passes Luhn).
    expect(redactCardNumbersAcrossTurns(['4111 1111', '1111 116'], MARKER, cue)).toBeNull();
  });

  it('cuts only lengths a card is issued at for its first digits', () => {
    // 15 digit words with no pause before a CVV: an Amex cut is kept…
    expect(
      redactCardNumbers('amex three seven eight two eight two two four six three one oh oh oh five one two three four'),
    ).toBe(`amex ${MARKER} one two three four`);
    // …but 15 digits that are no Amex are no card (4111 1111 1111 116 + 123).
    const notAmex = 'card four one one one one one one one one one one one one one six one two three';
    expect(redactCardNumbers(notAmex)).toBe(notAmex);
  });

  // A 17- or 18-digit order, serial or confirmation number read as words and
  // starting 36 has its first fourteen digits pass the Luhn check one time in
  // ten, and its last three or four read as a CVV or an expiry: a Diners
  // Club's 14 is cut out of a run of words only with the card named near it.
  // 3612 412341 3045 passes the Luhn check; written, the whole number is no card.
  it('cuts a Diners Club 14 out of a run of words only with the card named near it', () => {
    const run = 'three six one two four one two three four one three zero four five';
    for (const text of [
      `order number ${run} one two three`,
      `serial number ${run} oh four two seven`,
      `the confirmation number is ${run} one two three`,
      'tres seis uno dos cuatro uno dos tres cuatro uno tres cero cuatro cinco uno dos tres',
      `my water heater is leaking. the order number is ${run} one two three. thanks`,
      'the order number is 36124123413045123',
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
    expect(redactCardNumbers(`my card is ${run} one two three`)).toBe(`my card is ${MARKER} one two three`);
    expect(redactCardNumbers(`diners card ${run} oh four two seven`)).toBe(`diners card ${MARKER} oh four two seven`);
    expect(redactCardNumbers(`mi tarjeta es tres seis uno dos cuatro uno dos tres cuatro uno tres cero cuatro cinco uno dos tres`)).toBe(
      `mi tarjeta es ${MARKER} uno dos tres`,
    );
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

  // The whole-group search goes group by group; a window from a later group
  // of the card (a Diners Club's 14 from "thirty-nine", or from "tres ocho")
  // can pass the Luhn check by chance and used to be taken before the card
  // cut out of the run from its first group, leaving those groups in clear.
  it('takes the card cut from its first group over a chance window from a later group of it', () => {
    // 4360 0096 3747 3976 433, then its CVV (888) and expiry (12/26).
    expect(
      redactCardNumbers(
        'the card is forty-three sixty dash oh zero ninety six\nthirty-seven forty seven dash thirty-nine seventy six\nfour three three eight eight eight one two two six',
      ),
    ).toBe('the card is [card number] eight eight eight one two two six');
    // Diners Club 3625 383146 1044, then its expiry (01/26).
    expect(
      redactCardNumbers('mi tarjeta es tres seis dos cinco y tres ocho tres uno cuatro seis, eh, uno cero cuatro cuatro cero uno dos seis'),
    ).toBe('mi tarjeta es [card number] cero uno dos seis');
  });

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

/**
 * A seeded simulation of numbers that are not cards read out as words in one
 * turn or one transcript: lists of years, times, prices and house numbers
 * read in pairs, phone numbers read in pairs, and long runs of digit words
 * said with no pause. Each "card" found in them flags the recording for an
 * audio purge that cannot be undone. Cards read the same ways are still
 * caught.
 */
describe('redactCardNumbers — seeded simulation of numbers read as words', () => {
  // Each test starts from the same seed, whichever of them run.
  let random = seededRandom(0x7a1c);
  beforeEach(() => {
    random = seededRandom(0x7a1c);
  });
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const OH = ['oh', ...EN.slice(1)];
  const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const ES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
  const ES_PAIRS = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho',
    'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
    'veintisiete', 'veintiocho', 'veintinueve'];
  const ES_TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  /** 0–99 as a caller reads it in a pair ("oh five", "forty-one", "eleven"). */
  const pairEn = (n: number): string =>
    n < 10 ? `oh ${EN[n]}` : n < 20 ? TEENS[n - 10] : n % 10 ? `${TENS[Math.floor(n / 10)]}${pick(['-', ' '])}${EN[n % 10]}` : TENS[n / 10];
  const pairEs = (n: number): string =>
    n < 10 ? `cero ${ES[n]}` : n < 30 ? ES_PAIRS[n - 10] : n % 10 ? `${ES_TENS[Math.floor(n / 10)]} y ${ES[n % 10]}` : ES_TENS[n / 10];
  /** A number 1–99 as said on its own ("nine", "forty-five"). */
  const numberEn = (n: number): string => (n < 10 ? EN[n] : pairEn(n));
  const words = (digits: string, es = false): string => [...digits].map((d) => (es ? ES : OH)[Number(d)]).join(' ');
  const digits = (n: number): string => String(int(1, 9)) + Array.from({ length: n - 1 }, () => String(int(0, 9))).join('');
  const list = (item: () => string, count: number, es = false): string =>
    Array.from({ length: count }, item).reduce((acc, x) =>
      `${acc}${pick(es ? [', ', ', ', ' y ', ', eh, ', ' '] : [', ', ', ', ' and ', ', uh, ', ' ', '... '])}${x}`,
    );

  const notCards: Record<string, () => string> = {
    'years in pairs': () => {
      const year = (): string => {
        const y = int(1990, 2026);
        return y >= 2000 && y < 2010 ? `twenty oh ${EN[y - 2000]}` : `${numberEn(Math.floor(y / 100))} ${numberEn(y % 100)}`;
      };
      return `the units were put in ${list(year, int(3, 5))}`;
    },
    'times in pairs': () => `I can do ${list(() => `${numberEn(int(1, 12))} ${pairEn(pick([15, 30, 45, 10, 20, 40, 50]))}`, int(3, 5))}`,
    'prices in pairs': () => `it was ${list(() => numberEn(int(11, 99)), int(5, 8))} dollars`,
    'house numbers in pairs': () => `we own ${list(() => `${numberEn(int(10, 99))} ${pairEn(int(10, 99))}`, int(3, 4))} Main`,
    'Spanish times in pairs': () =>
      `puedo a las ${list(() => `${pick(ES_PAIRS.slice(0, 3).concat(ES.slice(1)))} ${pairEs(pick([15, 30, 45, 20, 40]))}`, int(3, 5), true)}`,
    'Spanish prices in pairs': () => `cuesta ${list(() => pairEs(int(11, 99)), int(6, 9), true)} dólares`,
    'US phone in pairs, then a zip': () =>
      `mi teléfono es ${words(digits(3), true)}, ${ES[int(2, 9)]} ${pairEs(int(10, 99))}, ${pairEs(int(0, 99))}, ${pairEs(int(0, 99))}, ${words(String(int(10000, 99999)), true)}`,
    'two US phones in pairs': () =>
      Array.from({ length: 2 }, () => `${words(digits(3), true)}, ${ES[int(2, 9)]} ${pairEs(int(10, 99))}, ${pairEs(int(0, 99))}, ${pairEs(int(0, 99))}`).join(', '),
    'Mexican phone in pairs, then a zip': () =>
      `es el ${Array.from({ length: 5 }, () => pairEs(int(10, 99))).join(', ')}, ${words(String(int(10000, 99999)), true)}`,
    'two Mexican phones in pairs': () =>
      Array.from({ length: 2 }, () => Array.from({ length: 5 }, () => pairEs(int(10, 99))).join(', ')).join(pick([', ', ' y '])),
  };

  it('finds no card in lists and phone numbers read in pairs', () => {
    for (const [kind, say] of Object.entries(notCards)) {
      const found: string[] = [];
      for (let n = 0; n < 2000; n++) {
        const text = say();
        if (redactCardNumbers(text) !== text) found.push(text);
      }
      expect({ kind, found }).toEqual({ kind, found: [] });
    }
  });

  it('finds next to no card in long runs of digit words said with no pause', () => {
    const phone = (): string => `${int(201, 989)}${int(200, 999)}${String(int(0, 9999)).padStart(4, '0')}`;
    const zip = (): string => String(int(1001, 99950)).padStart(5, '0');
    const runs: Record<string, () => string> = {
      'a phone and zip': () => `call me at ${words(phone())} ${words(zip())}`,
      'a zip and phone': () => words(zip() + phone()),
      'a phone and house number': () => words(phone() + String(int(100, 9999))),
      'two phones': () => words(phone() + phone()),
      'a 15 to 19 digit reference': () => `the claim is ${words(digits(int(15, 19)))}`,
    };
    const found: Record<string, number> = {};
    for (const [kind, say] of Object.entries(runs)) {
      found[kind] = 0;
      for (let n = 0; n < 2000; n++) {
        const text = say();
        if (redactCardNumbers(text) !== text) found[kind]++;
      }
    }
    // Of 2,000 each. Before: about one in ten of a phone and zip or a house
    // number, one in three of two phones, one in four of references. What is
    // left reads exactly like a card: a phone with an Amex-like area code
    // (34x, 37x) or a zip starting 34 or 37 then a phone reads as an Amex, a
    // Diners-like one (36x) and a house number as a Diners Club; two phones
    // whose first sixteen digits pass the Luhn check, followed by a month and
    // year, read as a card and its expiry; and a reference of 16 or more digits
    // starting like a card, at a length one is issued at for that start, that
    // passes the Luhn check reads as a card, as it always did written (144
    // before the issued lengths, `issuedAtLength`, were asked of it).
    expect(found['a phone and zip']).toBeLessThanOrEqual(2);
    expect(found['a zip and phone']).toBeLessThanOrEqual(9);
    expect(found['a phone and house number']).toBeLessThanOrEqual(3);
    expect(found['two phones']).toBeLessThanOrEqual(14);
    expect(found['a 15 to 19 digit reference']).toBeLessThanOrEqual(88);
  });

  it('still catches cards read in pairs where the card is mentioned, and cards with their CVV or expiry run on', () => {
    const missed: string[] = [];
    let total = 0;
    for (let n = 0; n < 1500; n++) {
      // Issued prefixes (a JCB is 3528–3589).
      const prefix = pick(['4', '51', '55', '6011', '3566', '2221']);
      const card = withLuhnCheckDigit(prefix + Array.from({ length: 15 - prefix.length }, () => String(int(0, 9))).join(''));
      const fours = card.match(/.{4}/g)!;
      const es = random() < 0.4;
      const pairs = fours.map((g) => [Number(g.slice(0, 2)), Number(g.slice(2))].map(es ? pairEs : pairEn).join(' '));
      const lead = es ? pick(['mi tarjeta es ', 'la tarjeta, ', 'pago con la tarjeta ']) : pick(['my card is ', 'the Visa is ', 'card number ']);
      const read = pairs.join(pick(es ? [', ', ' y ', ', eh, '] : [', ', ' ', ', uh, ', ' and ']));
      const text = `${lead}${read}${pick(['', ', thanks', '.'])}`;
      total++;
      const out = redactCardNumbers(text);
      if (out !== `${lead}${MARKER}${text.slice(lead.length + read.length)}`) missed.push(text);
      // Read as digit words with no pause, the CVV, an expiry, or both after
      // it. The whole card is replaced; what is left is the end of what was
      // said after it (a longer window that also passes the Luhn check takes
      // the CVV in with the card).
      const after = pick([digits(3), `${String(int(1, 12)).padStart(2, '0')}${int(25, 35)}`, `${digits(3)}${String(int(1, 12)).padStart(2, '0')}${int(25, 35)}`]);
      const runOn = `${lead}${words(card, es)} ${words(after, es)}`;
      total++;
      const rest = redactCardNumbers(runOn);
      if (!rest.startsWith(`${lead}${MARKER}`) || !` ${words(after, es)}`.endsWith(rest.slice(lead.length + MARKER.length))) {
        missed.push(runOn);
      }
    }
    expect(total).toBe(3000);
    expect(missed).toEqual([]);
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
    // A turn of four digits or fewer needs the card mentioned (see "stitches a
    // window with any turn of four digits or fewer only where the card is
    // mentioned").
    expect(
      redactCardNumbersAcrossTurns([
        'my card is four oh one two, eight eight eight eight',
        'eight eight eight eight',
        'one eight eight one oh four two seven',
      ]),
    ).toEqual(['my card is [card number]', '[card number]', '[card number] oh four two seven']);
  });

  // A caller reading on after a pause often opens the next turn with a filler
  // or an acknowledgement of the agent's "go on".
  it('joins a continuation turn that opens with a filler', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'um, 1111 1111'])).toEqual([MARKER, `um, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'and 1111 1111'])).toEqual([MARKER, `and ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111', 'uh... 1111', 'y 1111'])).toEqual([
      `my card is ${MARKER}`,
      `uh... ${MARKER}`,
      `y ${MARKER}`,
    ]);
    // A filler the earlier turn trails off with joins too.
    expect(redactCardNumbersAcrossTurns(['4111 1111, um', '1111 1111'])).toEqual([`${MARKER}, um`, MARKER]);
  });

  it('joins a continuation turn that opens with a short acknowledgement, in English and Spanish', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'Okay, 1111 1111'])).toEqual([MARKER, `Okay, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111', 'ok 1111', 'so 1111'])).toEqual([
      `my card is ${MARKER}`,
      `ok ${MARKER}`,
      `so ${MARKER}`,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'vale, 1111 1111'])).toEqual([MARKER, `vale, ${MARKER}`]);
    expect(
      redactCardNumbersAcrossTurns(['mi tarjeta es cuatro uno uno uno, uno uno uno uno', 'bueno, uno uno uno uno', 'uno uno uno uno']),
    ).toEqual([`mi tarjeta es ${MARKER}`, `bueno, ${MARKER}`, MARKER]);
  });

  it('joins a continuation turn that opens with an apology or a back-channel', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'Sorry, 1111 1111'])).toEqual([MARKER, `Sorry, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'mm-hmm, 1111 1111'])).toEqual([MARKER, `mm-hmm, ${MARKER}`]);
    // STT often drops the accent of "sí".
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'si, 1111 1111'])).toEqual([MARKER, `si, ${MARKER}`]);
  });

  it('joins a continuation turn that opens with "sure" or "hmm", or with up to three such words', () => {
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'sure, 1111 1111'])).toEqual([MARKER, `sure, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'hmm, 1111 1111'])).toEqual([MARKER, `hmm, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'Okay, sorry, so 1111 1111'])).toEqual([
      MARKER,
      `Okay, sorry, so ${MARKER}`,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'sí, vale, entonces 1111 1111'])).toEqual([
      MARKER,
      `sí, vale, entonces ${MARKER}`,
    ]);
    // Four is a sentence of its own, a filler for the fourth too, and any
    // other word ends the run.
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'okay, sorry, so, yeah 1111 1111'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'okay, sorry, so, um, 1111 1111'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'okay, sorry, um, 1111 1111'])).toEqual([MARKER, `okay, sorry, um, ${MARKER}`]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'um um um um 1111 1111'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'well 1111 1111'])).toBeNull();
  });

  // Where the card is mentioned near it: callers say "okay" between bare
  // answers too, and two eight-digit answers with an "okay" between them
  // passed the Luhn check as often as any (in a seeded run of 20,000 bare
  // answers with acknowledgement turns, reading on past them without a
  // mention doubled the "cards" found, 73 to 144).
  it('reads on past a turn of nothing but an acknowledgement or a filler between the groups, where the card is mentioned', () => {
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111', 'okay', '1111 1111'])).toEqual([
      `my card is ${MARKER}`,
      'okay',
      MARKER,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'um', '1111', 'mm-hmm', '1111'], MARKER, AGENT_MENTIONS_CARD)).toEqual([
      MARKER,
      'um',
      MARKER,
      'mm-hmm',
      MARKER,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'okay', '1111 1111'])).toBeNull();
    // In the live window, as said.
    expect(
      redactCardNumbersInCallTurns([
        { speaker: 'caller', text: 'my card is 4111 1111', at: 0 },
        { speaker: 'agent', text: 'go on', at: 1000 },
        { speaker: 'caller', text: 'okay', at: 2000 },
        { speaker: 'caller', text: '1111 1111', at: 3000 },
      ]),
    ).toEqual([`my card is ${MARKER}`, 'go on', 'okay', MARKER]);
    // A turn that says anything else still ends the run, and so do three
    // such turns in a row (more fillers than a pause between groups holds).
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'okay what', '1111 1111'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4111 1111', 'okay', 'um', 'so', '1111 1111'])).toBeNull();
  });

  // A card read group by group with an "okay" after each group is seven
  // caller turns: only the turns that give digits count toward the window's
  // five (a turn of nothing but a pause holds none of the card).
  it("counts only the caller turns that give digits toward the window: an 'okay' after every group still reads on", () => {
    const groups = ['my card is 4111', '1111', '1111', '1111'];
    const withOkays = groups.flatMap((g, k) => (k === 0 ? [g] : ['okay', g]));
    const said = (texts: readonly string[]) => texts.map((text, k) => ({ speaker: 'caller' as const, text, at: k * 2000 }));
    expect(redactCardNumbersInCallTurns(said(withOkays))).toEqual([
      `my card is ${MARKER}`,
      'okay',
      MARKER,
      'okay',
      MARKER,
      'okay',
      MARKER,
    ]);
    // A 19-digit card read the same way, nine turns.
    const nineteen = ['my card is 4000', '0000', '0000', '0000', '006'].flatMap((g, k) => (k === 0 ? [g] : ['okay', g]));
    expect(redactCardNumbersInCallTurns(said(nineteen))).toEqual(nineteen.map((t) => (t === 'okay' ? t : t.replace(/\d+/, MARKER))));
    // Gate codes answered the same way, with no card named, are no card.
    const codes = ['the gate code is 4111', 'okay', '1111', 'okay', '1111', 'okay', '1111'];
    expect(redactCardNumbersInCallTurns(said(codes))).toBeNull();
    // Still five turns with digits at most: a card's leading digit six digit
    // turns back has left the window.
    const six = ['my card is 4', '1', '1', '1', '1111 1111', '1111'].flatMap((g, k) => (k === 0 ? [g] : ['okay', g]));
    expect(redactCardNumbersInCallTurns(said(six))).toBeNull();
  });

  it('joins a continuation turn that says which group comes next', () => {
    // "four" here counts the digits; it is not one of them.
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111', 'the next four are 1111'])).toEqual([
      MARKER,
      `the next four are ${MARKER}`,
    ]);
    // "The last four" says no card is being read (a caller answers for an
    // account or a phone the same way), so a last turn of four needs the card
    // mentioned; "the next four" reads on, which is a mention.
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111 1111', 'and the last four digits are 1111.'])).toEqual([
      `my card is ${MARKER}`,
      `and the last four digits are ${MARKER}.`,
    ]);
    expect(redactCardNumbersAcrossTurns(['mi tarjeta es 4111 1111 1111', 'los últimos cuatro son 1111'])).toEqual([
      `mi tarjeta es ${MARKER}`,
      `los últimos cuatro son ${MARKER}`,
    ]);
    expect(redactCardNumbersAcrossTurns(['4111 1111 1111', 'and the last four digits are 1111.'])).toBeNull();
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
    // Any turn of four digits or fewer needs the card mentioned (see "stitches
    // a window with any turn of four digits or fewer only where the card is
    // mentioned"); here the caller or the agent did.
    expect(redactCardNumbersAcrossTurns(['card 4111', '1111 1111 1111'])).toEqual([`card ${MARKER}`, MARKER]);
    // A 19-digit Visa read 4-4-4-4-3, the last two groups together or apart.
    expect(redactCardNumbersAcrossTurns(['4000', '0000', '0000', '0000', '006'], MARKER, AGENT_MENTIONS_CARD)).toEqual(
      Array(5).fill(MARKER),
    );
    expect(redactCardNumbersAcrossTurns(['4000 0000', '0000', '0000 006'], MARKER, AGENT_MENTIONS_CARD)).toEqual(Array(3).fill(MARKER));
    // Amex 3782 822463 10005 in its 4-6-5 groups.
    expect(redactCardNumbersAcrossTurns(['3782', '822463', '10005'], MARKER, AGENT_MENTIONS_CARD)).toEqual(Array(3).fill(MARKER));
    expect(redactCardNumbersAcrossTurns(['3782 822463', '10005'])).toEqual([MARKER, MARKER]);
    // A Diners Club International 3614 890064 7913 in its 4-6-4 groups, and an
    // Amex read in fours (3782 8224 6310 005).
    expect(redactCardNumbersAcrossTurns(['card 3614', '890064', '7913'])).toEqual([`card ${MARKER}`, MARKER, MARKER]);
    expect(redactCardNumbersAcrossTurns(['my card is 3614 890064', '7913'])).toEqual([`my card is ${MARKER}`, MARKER]);
    expect(redactCardNumbersAcrossTurns(['3782 8224', '6310 005'])).toEqual([MARKER, MARKER]);
    // A 13-digit Visa: three fours, then the last digit.
    expect(redactCardNumbersAcrossTurns(['my card is 4222', '2222', '2222', '2'])).toEqual([
      `my card is ${MARKER}`,
      MARKER,
      MARKER,
      MARKER,
    ]);
  });

  // A 13-digit Visa or a Diners Club read in fours over two turns ends its
  // last turn on the card's last four plus the final one or two digits.
  it('stitches a last turn that holds the last four and the final partial group (13-digit [8,5], Diners [8,6])', () => {
    // Visa 4222 2222 2222 2 and Diners Club 3614 8900 6479 13.
    expect(redactCardNumbersAcrossTurns(['my card is 4222 2222', '2222 2'])).toEqual([`my card is ${MARKER}`, MARKER]);
    expect(redactCardNumbersAcrossTurns(['my card is 3614 8900', '6479 13'])).toEqual([`my card is ${MARKER}`, MARKER]);
    // Only where the card is mentioned: an eight-digit answer and a zip read
    // the same way, and so does a group of four per turn.
    expect(redactCardNumbersAcrossTurns(['4222 2222', '2222 2'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4222', '2222', '2222 2'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4222', '2222', '2222 2'], MARKER, AGENT_MENTIONS_CARD)).toEqual(
      Array(3).fill(MARKER),
    );
    // Subject to the issued lengths: 13 digits are a Visa or nothing, 14 a
    // Diners Club or nothing (5100 0000 0000 3 and 4111 1111 1111 14 pass
    // the Luhn check).
    expect(redactCardNumbersAcrossTurns(['my card is 5100 0000', '0000 3'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['my card is 4111 1111', '1111 14'])).toBeNull();
  });

  // Diners Club International is issued at 14 from 300–305, 3095 and 38–39
  // as from 36 (the networks' 14-digit test numbers start 305 and 38).
  it('stitches a Diners Club 14 from 300–305, 3095 or 38–39 in its 4-6-4, 10-4, 4-10 and [8,6] turns, as one from 36', () => {
    for (const card of ['30569309025904', '38520000023237', '30951234567897', '39123456789010', '36227206271667']) {
      const [a, b, c] = [card.slice(0, 4), card.slice(4, 10), card.slice(10)];
      for (const turns of [
        [`my card number is ${a}`, b, c],
        [`my card number is ${a} ${b}`, c],
        [`my card number is ${a}`, `${b} ${c}`],
        [`my card is ${card.slice(0, 4)} ${card.slice(4, 8)}`, `${card.slice(8, 12)} ${card.slice(12)}`],
      ]) {
        expect(redactCardNumbersAcrossTurns(turns), turns.join(' | ')).toEqual(
          turns.map((t) => t.replace(/[\d ]+$/, (digits) => (digits.startsWith(' ') ? ` ${MARKER}` : MARKER))),
        );
      }
      // Read as words with the CVV run straight on in the last turn.
      expect(redactCardNumbersAcrossTurns([`my card is ${spell(a)}`, spell(b), `${spell(c)} one two three`])).toEqual([
        `my card is ${MARKER}`,
        MARKER,
        `${MARKER} one two three`,
      ]);
      // In the live window, the agent saying "go on" between the turns.
      expect(
        redactCardNumbersInCallTurns([
          { speaker: 'caller', text: `my card number is ${a}`, at: 0 },
          { speaker: 'agent', text: 'Go on.', at: 2000 },
          { speaker: 'caller', text: b, at: 4000 },
          { speaker: 'caller', text: c, at: 6000 },
        ]),
      ).toEqual([`my card number is ${MARKER}`, 'Go on.', MARKER, MARKER]);
    }
  });

  // Already read: a Diners Club 4-6-4 and an Amex [8,7] (see "still stitches
  // every way a card is read aloud in turns").

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
      redactCardNumbersAcrossTurns(['4111', '1111', '1111', '1111'], MARKER, { agentLines: [['What is the gate code?']] }),
    ).toBeNull();
    // The agent talking about paying is no mention of a card: it says so while
    // it takes gate codes and years.
    expect(
      redactCardNumbersAcrossTurns(['3287', '9106', '3649', '7'], MARKER, {
        agentLines: [["I'll text you a payment link. What is the gate code?"]],
      }),
    ).toBeNull();
  });

  // Bare intake answers in a row are not all four digits or fewer: a gate
  // code, a serial number read as two fours and a time (4420, 0198 7388,
  // 1100) pass the Luhn check joined, and so do the other shapes below. Any
  // turn of four digits or fewer in a window (a gate or lockbox code, a
  // last-four, a year, a time, a PIN) is a bare answer as often as a card's
  // group, so such a window needs the card mentioned near it, whatever the
  // other turns give.
  it('stitches a window with any turn of four digits or fewer only where the card is mentioned', () => {
    let at = 1_000_000;
    const line = (speaker: 'caller' | 'agent', text: string) => ({ speaker, text, at: (at += 5000) });
    const leg = [
      line('agent', 'How can I help?'),
      line('caller', 'I need someone to look at my AC'),
      line('agent', "What's the gate code?"),
      line('caller', '4420.'),
      line('agent', 'And the serial number?'),
      line('caller', '0198, 7388'),
      line('agent', 'What time works?'),
      line('caller', 'um, 1100.'),
      line('agent', 'And the lockbox code?'),
      line('caller', '9775'),
    ];
    expect(redactCardNumbersInCallTurns(leg)).toBeNull();
    expect(redactCardNumbersAcrossTurns(['4420.', '0198, 7388', 'um, 1100.'])).toBeNull();
    // The same digits in every grouping with a turn of four or fewer: 4-8-4,
    // 8-4-4, 4-4-8, 4-12 and 12-4.
    const shapes = [
      ['4420', '0198 7388', '1100'],
      ['4420 0198', '7388', '1100'],
      ['4420', '0198', '7388 1100'],
      ['4420', '0198 7388 1100'],
      ['4420 0198 7388', '1100'],
    ];
    for (const turns of shapes) {
      expect(redactCardNumbersAcrossTurns(turns), turns.join(' | ')).toBeNull();
      // Named near them, they are a card.
      const named = [`my card is ${turns[0]}`, ...turns.slice(1)];
      expect(redactCardNumbersAcrossTurns(named), named.join(' | ')).toEqual([`my card is ${MARKER}`, ...turns.slice(1).map(() => MARKER)]);
      expect(redactCardNumbersAcrossTurns(turns, MARKER, AGENT_MENTIONS_CARD)).toEqual(turns.map(() => MARKER));
    }
    // An Amex or a Diners Club read with a turn of four or fewer, too.
    expect(redactCardNumbersAcrossTurns(['3782', '822463', '10005'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['3614 890064', '7913'])).toBeNull();
    expect(redactCardNumbersAcrossTurns(['card 3782', '822463', '10005'])).toEqual([`card ${MARKER}`, MARKER, MARKER]);
    // Two halves of eight, or an Amex 8-7, have no such turn: stitched as before.
    expect(redactCardNumbersAcrossTurns(['4420 0198', '7388 1100'])).toEqual([MARKER, MARKER]);
    expect(redactCardNumbersAcrossTurns(['3782 8224', '6310 005'])).toEqual([MARKER, MARKER]);
  });

  // A caller often says "okay", "um" or "mm-hmm" between naming the card and
  // reading it ("my card number is", "okay", "3782", …), or answers the
  // agent's "go ahead with the card number" with one. That turn is a pause,
  // not another moment of the call: the mention is read past up to two such
  // turns, and the agent's lines before them count as well. Every shape
  // below has a turn of four digits or fewer (or ends on a 13-digit card's
  // last four and one), so none is stitched with no mention; before, a pause
  // turn after the mention hid it and none of them was caught.
  describe('the mention, past a pause turn said before the card', () => {
    const SHAPES: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['Visa 4-4-4-4', ['4111', '1111', '1111', '1111']],
      ['Amex 4-6-5', ['3782', '822463', '10005']],
      ['Diners Club 4-6-4', ['3614', '890064', '7913']],
      ['Visa 4-12', ['4111', '1111 1111 1111']],
      ['13-digit Visa [8,5]', ['4222 2222', '2222 2']],
    ];
    const PAUSES = ['okay', 'um', 'sure', 'mm-hmm', 'sí', 'Okay, um.'];
    const marked = (groups: readonly string[]) => groups.map(() => MARKER);

    it.each(SHAPES)('%s after the caller names the card, or the agent asks for it', (_name, groups) => {
      for (const pause of PAUSES) {
        expect(redactCardNumbersAcrossTurns(['my card number is', pause, ...groups]), pause).toEqual([
          'my card number is',
          pause,
          ...marked(groups),
        ]);
        // The mention in the caller's turn before the window.
        expect(redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { callerTurnBefore: 'my card number is' }), pause).toEqual([
          pause,
          ...marked(groups),
        ]);
        // The agent asked for it, the caller said "okay".
        expect(
          redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [['Go ahead with the card number.']] }),
          pause,
        ).toEqual([pause, ...marked(groups)]);
        expect(
          redactCardNumbersAcrossTurns(['it is the blue house', pause, ...groups], MARKER, {
            agentLines: [[], ['Go ahead with the card number.']],
          }),
          pause,
        ).toEqual(['it is the blue house', pause, ...marked(groups)]);
      }
      // Two such turns.
      expect(redactCardNumbersAcrossTurns(['mi tarjeta es', 'sí', 'este', ...groups])).toEqual(['mi tarjeta es', 'sí', 'este', ...marked(groups)]);
    });

    it.each(SHAPES)('%s after a pause with no card named before it is still no card', (_name, groups) => {
      for (const pause of PAUSES) {
        expect(redactCardNumbersAcrossTurns([pause, ...groups]), pause).toBeNull();
        expect(redactCardNumbersAcrossTurns(['the gate is on the left', pause, ...groups]), pause).toBeNull();
        // Talk of paying is no mention, past a pause or not.
        expect(redactCardNumbersAcrossTurns(['can I pay now', pause, ...groups]), pause).toBeNull();
        expect(redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [['What is the gate code?']] }), pause).toBeNull();
      }
      // Three pause turns are more than a breath between naming the card
      // and reading it, and the mention still counts only near the turn's end.
      expect(redactCardNumbersAcrossTurns(['my card number is', 'okay', 'um', 'so', ...groups])).toBeNull();
      expect(
        redactCardNumbersAcrossTurns([
          'I will pay by card when he comes, and the gate is on the left past the blue house with the dog',
          'okay',
          ...groups,
        ]),
      ).toBeNull();
    });

    it.each(SHAPES)('%s in a stored call leg, with the agent between the turns', (_name, groups) => {
      type Said = readonly ['caller' | 'agent', string];
      const leg = (lead: readonly Said[]) =>
        [['agent', 'How can I help?'] as Said, ...lead, ...groups.flatMap((g, k): Said[] => (k === 0 ? [['caller', g]] : [['agent', 'Go on.'], ['caller', g]]))].map(
          ([speaker, text], k) => ({ speaker, text, at: 1_000_000 + k * 3000 }),
        );
      for (const lead of [
        [['caller', 'my card number is'], ['caller', 'okay']],
        [['caller', 'my card number is'], ['agent', 'Sure, go ahead.'], ['caller', 'um']],
        [['agent', 'Go ahead with the card number.'], ['caller', 'okay']],
        [['agent', 'Go ahead with the card number.'], ['caller', 'mm-hmm'], ['agent', 'Go on.']],
      ] as const) {
        const lines = leg(lead);
        expect(redactCardNumbersInCallTurns(lines), lead.map(([, text]) => text).join(' | ')).toEqual(
          lines.map((l) => (l.speaker === 'caller' && /\d/.test(l.text) ? MARKER : l.text)),
        );
      }
      // The same leg with nothing naming the card is left alone.
      expect(redactCardNumbersInCallTurns(leg([['caller', 'the gate is on the left'], ['caller', 'okay']]))).toBeNull();
      expect(redactCardNumbersInCallTurns(leg([['agent', 'What is the gate code?'], ['caller', 'okay']]))).toBeNull();
    });

    // Card talk, a pause turn, then the agent asks for another number ("What's
    // the house number?", "And the lockbox code?"): the turns answer that
    // question, and the talk before the pause names no card of theirs. Read
    // past the pause, bare intake answers (codes, house numbers, a PIN, a
    // customer number, a callback number read straight on into more digits)
    // were stitched into a "card": the caller's words rewritten and the
    // recording's audio purged.
    it.each(SHAPES)("%s answering the agent's question for another number, after card talk and a pause, is no card", (_name, groups) => {
      for (const pause of PAUSES) {
        for (const question of ["What's the house number?", 'And the lockbox code?', '¿Cuál es el código del portón?', '¿Y la caja de llaves?']) {
          expect(
            redactCardNumbersAcrossTurns(['my card number is', pause, ...groups], MARKER, { agentLines: [[], [], [question]] }),
            `${pause} | ${question}`,
          ).toBeNull();
          expect(
            redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [['We take all major cards at the visit.'], [question]] }),
            `${pause} | ${question}`,
          ).toBeNull();
        }
      }
    });

    // The agent's ask for another number is as often said before the caller's
    // pause as after it ("What's the gate code?" "Yep." "4821"), between two
    // pauses, or in the same line as the card talk ("We take all major cards
    // at the visit. And the account PIN?"); as a request with no question
    // mark ("Go ahead with the gate code.", "Dígame el código postal."); or
    // for a phone number without naming one ("What number should the tech
    // call?"). Only the line right before the digits was read, and only for a
    // question: the card talk before the pause was read past it, and the
    // answers stitched into a "card" (the recording's audio purged).
    const ASKS_FOR_ANOTHER_NUMBER = [
      "What's the gate code?",
      'Go ahead with the gate code.',
      'Please give me the alarm code.',
      'Dígame el código postal.',
      'What number should the tech call?',
      'What is the best number for you?',
      "What's a good number to text you at?",
      '¿A qué número le podemos llamar?',
    ];
    // Pauses the mention is read past, and asides no turn reads on from.
    const PAUSES_AROUND_THE_ASK = [...PAUSES, 'yeah', 'Yep.', 'One sec.', 'Hold on.', 'Let me find it.', 'Un momento.', 'A ver.'];
    it.each(SHAPES)("%s answering the agent's ask for another number, wherever it sits around the pause, is no card", (_name, groups) => {
      for (const pause of PAUSES_AROUND_THE_ASK) {
        for (const ask of ASKS_FOR_ANOTHER_NUMBER) {
          const legs: ReadonlyArray<readonly [string, readonly string[], CardSplitContext]> = [
            // Card talk, a pause, the ask, the answers.
            ['card | pause | ask', ['my card number is', pause, ...groups], { agentLines: [[], [], [ask]] }],
            // Card talk, the ask, a pause, the answers.
            ['card | ask | pause', ["I'll pay with my Visa at the visit", pause, ...groups], { agentLines: [[], [ask]] }],
            ['agent card | ask | pause', [pause, ...groups], { agentLines: [['We take all major cards at the visit.', ask]] }],
            // Card talk, a pause, the ask, a pause, the answers.
            ['card | pause | ask | pause', ['can I pay by card when they come', pause, pause, ...groups], { agentLines: [[], ['Yes, we do.'], [ask]] }],
            // Card talk and the ask in one agent line, a pause, the answers.
            ['agent card + ask | pause', [pause, ...groups], { agentLines: [[`We take all major cards at the visit. ${ask}`]] }],
            ['card | agent ok + ask | pause', ['do you take credit cards', pause, ...groups], { agentLines: [[], [`Yes, we do. ${ask}`]] }],
          ];
          for (const [shape, turns, context] of legs) {
            expect(redactCardNumbersAcrossTurns(turns, MARKER, context), `${shape}: ${pause} | ${ask}`).toBeNull();
          }
        }
      }
    });

    // What counts as that ask is a sentence of the agent's that asks or
    // requests ("?", "please", "go ahead with", "dígame") a number the card
    // is not, and names no card. Card talk that only states something ("We'll
    // call you when the tech is on the way"), or asks for the card and
    // another number in one breath, leaves the mention before the pause.
    it.each(SHAPES)('%s after card talk and a pause still counts where no sentence asks for another number', (_name, groups) => {
      for (const pause of ['okay', 'um', 'sí']) {
        for (const [lead, ask] of [
          ['Sure, you can pay by card. We will call you when the tech is on the way.', 'Go ahead.'],
          ['Sure, you can pay by card. I can text you a receipt after.', 'Go ahead.'],
          ['Sure, you can pay by card.', 'Can I get the card number and the zip code?'],
          ['Sure, you can pay by card.', 'Please read me the card number and the expiration date.'],
          ['Claro, puede pagar con tarjeta.', 'Dígame el número de la tarjeta, por favor.'],
        ] as const) {
          expect(redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [[lead, ask]] }), `${lead} ${ask}`).toEqual([
            pause,
            ...marked(groups),
          ]);
        }
      }
    });

    // Pauses no turn reads on from ("yep", "got it", "hold on", "one sec",
    // "let me get it", "claro", "un momento"): said between naming the card
    // and reading it, they hid the mention, so a card with a turn of four
    // digits or fewer was missed. The mention is read past them as past
    // "okay"; a turn of one of them still ends a run, as any other word does.
    const MORE_PAUSES = [
      'uh huh',
      'Yep.',
      'Got it.',
      'All right.',
      'Hold on.',
      'One sec.',
      'One moment.',
      'Just a second.',
      'Let me get it.',
      'Hang on.',
      'Mmm.',
      'Okey.',
      'Ajá.',
      'Claro.',
      'Ya.',
      'Un momento.',
      'Déjame buscarla.',
      'A ver.',
    ];

    it.each(SHAPES)('%s after a pause no turn reads on from, the mention before it', (_name, groups) => {
      for (const pause of MORE_PAUSES) {
        expect(redactCardNumbersAcrossTurns(['my card number is', pause, ...groups]), pause).toEqual([
          'my card number is',
          pause,
          ...marked(groups),
        ]);
        expect(
          redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [['Go ahead with the card number.']] }),
          pause,
        ).toEqual([pause, ...marked(groups)]);
        // With an acknowledgement turn as well: two pause turns.
        expect(redactCardNumbersAcrossTurns(['mi tarjeta es', 'vale', pause, ...groups]), pause).toEqual([
          'mi tarjeta es',
          'vale',
          pause,
          ...marked(groups),
        ]);
        // Nothing names the card, or the agent asks for another number.
        expect(redactCardNumbersAcrossTurns([pause, ...groups]), pause).toBeNull();
        expect(redactCardNumbersAcrossTurns(['the gate is on the left', pause, ...groups]), pause).toBeNull();
        expect(
          redactCardNumbersAcrossTurns(['my card number is', pause, ...groups], MARKER, { agentLines: [[], [], ["What's the house number?"]] }),
          pause,
        ).toBeNull();
      }
      // "Let me get my card" names the card itself: it is no pause to read past.
      expect(redactCardNumbersAcrossTurns(['I can pay now', 'let me get my card', ...groups])).toEqual([
        'I can pay now',
        'let me get my card',
        ...marked(groups),
      ]);
    });

    // "One sec" and "one moment" hold a digit word. Said after digits, it read
    // as one more digit of them: twelve digits and the "one" passed the Luhn
    // check as a 13-digit Visa, and a card's sixteen and the "one" as a
    // 17-digit Discover. As a pause, it gives a card no digit.
    it("never takes the digit word of 'one sec' or 'one moment' into a card", () => {
      expect(redactCardNumbersAcrossTurns(['my card number is 4111 1111 1110', 'One sec.'])).toBeNull();
      expect(redactCardNumbersAcrossTurns(['my card number is 4111 1111 1110', 'Okay, one moment.'])).toBeNull();
      expect(redactCardNumbersAcrossTurns(['my card is', '6011', '0000', '0000', '0038', 'One sec.'])).toEqual([
        'my card is',
        MARKER,
        MARKER,
        MARKER,
        MARKER,
        'One sec.',
      ]);
      // "un" is no digit word, and "un momento" gives none either way.
      expect(redactCardNumbersAcrossTurns(['mi tarjeta es', '6011', '0000', '0000', '0038', 'Un momento.'])).toEqual([
        'mi tarjeta es',
        MARKER,
        MARKER,
        MARKER,
        MARKER,
        'Un momento.',
      ]);
    });

    // Nor is it a turn that gives digits toward the window's five: a 19-digit
    // card read in five turns after "my card number is", "one sec" still has
    // the mention in reach.
    it('counts no pause toward the five turns that give digits, so a 19-digit card after one keeps its mention', () => {
      for (const pause of ['One sec.', 'one moment', 'Un momento.', 'Hold on.']) {
        const said = ['my card number is', pause, '4000', '0000', '0000', '0000', '006'];
        const lines = said.map((text, k) => ({ speaker: 'caller' as const, text, at: 1_000_000 + k * 3000 }));
        expect(redactCardNumbersInCallTurns(lines), pause).toEqual(['my card number is', pause, ...Array(5).fill(MARKER)]);
      }
    });

    // The call legs that were stitched: each turn below was replaced, and the
    // recording flagged for audio purge.
    const at = (k: number) => 1_000_000 + k * 3000;
    const callLeg = (said: ReadonlyArray<readonly ['caller' | 'agent', string]>) =>
      said.map(([speaker, text], k) => ({ speaker, text, at: at(k) }));
    it.each([
      [
        'the agent on cards, "sure", then a customer number and two house numbers',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['agent', 'Do you want the card on file charged after the visit?'],
          ['caller', 'sure'],
          ['agent', 'Your customer number?'],
          ['caller', '67500046'],
          ['agent', "What's the house number?"],
          ['caller', '7179'],
          ['agent', "What's the house number?"],
          ['caller', '2407'],
        ],
      ],
      [
        'the caller asks about paying by card, "mm-hmm", then lockbox codes, a PIN and a last four',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I need someone to look at my AC'],
          ['caller', 'can I pay by card when they come'],
          ['agent', 'Yes, we do.'],
          ['caller', 'mm-hmm'],
          ['agent', 'And the lockbox code?'],
          ['caller', 'five three zero nine'],
          ['agent', 'And the account PIN?'],
          ['caller', 'nine five zero eight'],
          ['caller', 'sure'],
          ['agent', 'And the lockbox code?'],
          ['caller', '0518'],
          ['agent', 'Last four of your phone?'],
          ['caller', '6429'],
        ],
      ],
      [
        'en español: tarjeta, "sí", then a house number, a last four, a year and a gate code',
        [
          ['agent', '¿En qué le puedo ayudar?'],
          ['caller', 'necesito una cita para el aire'],
          ['caller', 'pago con tarjeta en la visita'],
          ['agent', 'Sí, claro.'],
          ['caller', 'sí'],
          ['agent', '¿Número de la casa?'],
          ['caller', 'cuatro dos cero dos'],
          ['agent', '¿Los últimos cuatro de su teléfono?'],
          ['caller', '2897'],
          ['agent', '¿De qué año es el equipo?'],
          ['caller', '2014'],
          ['agent', '¿Cuál es el código del portón?'],
          ['caller', 'seis seis cinco cero'],
        ],
      ],
      [
        // 3605550006 and 2247: fourteen digit words starting 36 that pass the
        // Luhn check, a Diners Club's 14 read with no pause.
        'card talk, "okay", then a callback number from 360 read straight on into four more digits',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['caller', 'okay'],
          ['agent', "What's a good callback number?"],
          ['caller', spell('36055500062247')],
        ],
      ],
      [
        // 3475550000 and 85006: fifteen, an Amex's length from 34 or 37.
        'card talk, "okay", then a callback number from 347 read straight on into a zip',
        [
          ['agent', 'How can I help?'],
          ['caller', 'I want to pay by card'],
          ['caller', 'okay'],
          ['agent', 'Can I get a phone number for the technician?'],
          ['caller', spell('347555000085006')],
        ],
      ],
    ] as const)('leaves alone %s', (_name, said) => {
      expect(redactCardNumbersInCallTurns(callLeg(said))).toBeNull();
    });

    // The agent asking for the card itself again ("Go ahead, what's the
    // number?") is no question for another number: the mention before the
    // pause still counts.
    it.each(SHAPES)('%s read after the agent asks again for the number, past a pause turn', (_name, groups) => {
      for (const [lead, reprompt] of [
        [[['agent', "What's the card number?"], ['caller', 'okay']], "Go ahead, what's the number?"],
        [[['caller', 'my card number is'], ['caller', 'um']], "Sorry, what's the number?"],
        [[['agent', '¿Cuál es el número de la tarjeta?'], ['caller', 'vale']], 'Adelante, ¿cuál es el número?'],
      ] as const) {
        const lines = callLeg([...lead, ['agent', reprompt], ...groups.map((g) => ['caller', g] as const)]);
        expect(redactCardNumbersInCallTurns(lines), reprompt).toEqual(
          lines.map((l) => (l.speaker === 'caller' && /\d/.test(l.text) ? MARKER : l.text)),
        );
      }
    });

    // Re-asks for the card that never say "card" but name its data (the
    // expiration date, the security code, the billing zip), say "take your
    // time", "four digits at a time" or "one more time", or open with an
    // aside naming an account, an address, a phone or an invoice before the
    // question. Read as a whole line, each named "another number", and the
    // card read straight after it was missed.
    it.each(SHAPES)('%s read after a re-ask that names card data, an idiom or an aside, past a pause turn', (_name, groups) => {
      const reasks = [
        'Sure, take your time. What is the number?',
        "What's the number? Take your time.",
        'Can you read it to me four digits at a time?',
        'Could you give me the number one group at a time?',
        'Could you read me the number and the expiration date?',
        "What's the number, and the security code on the back?",
        'Can I get the number and the billing zip code?',
        "One moment while I pull up your account. Okay, what's the number?",
        "Thanks, I have your address on file. What's the number?",
        "Got it, I'll text a receipt to your phone. Go ahead, what's the number?",
        "Sure, I can take payment on that invoice now. What's the number?",
        'Sorry, could you read me the number one more time?',
        "What's the three digit code on the back, and the number?",
        'Please read me the number on the front, then the code on the back.',
        'Please give me the number, and the date it expires.',
        "What's the number and the exp date?",
        'Read me the number, then the exp. date, please.',
        // Its data in the plural, as the singular.
        'Can I get the number and the expiration dates?',
        'Can I get the number and the security codes?',
      ];
      const reasksEs = [
        '¿Me puede dar el número y la fecha de vencimiento?',
        '¿Cuál es el número y el código de seguridad?',
        '¿Me da el número y los códigos de seguridad?',
        '¿Y el número y las fechas de vencimiento?',
        'Claro, tómese su tiempo. ¿Cuál es el número?',
        'Un momento, busco su cuenta. Listo, ¿cuál es el número?',
        'Gracias, ya tengo su dirección. ¿Cuál es el número?',
        '¿Me da el número y el código de atrás?',
        '¿Y el número y la fecha de caducidad?',
        '¿Me da el número y el código de tres dígitos?',
        '¿Me da el número y el código postal de facturación?',
      ];
      const leads = (es: boolean) =>
        es
          ? ([
              [['caller', 'el número de mi tarjeta es'], ['caller', 'sí']],
              [['agent', 'Claro, puede pagar con tarjeta.'], ['caller', 'este']],
            ] as const)
          : ([
              [['caller', 'my card number is'], ['caller', 'okay']],
              [['agent', 'Sure, you can pay by card.'], ['caller', 'um']],
            ] as const);
      for (const [es, list] of [[false, reasks], [true, reasksEs]] as const) {
        for (const reask of list) {
          for (const lead of leads(es)) {
            const lines = callLeg([...lead, ['agent', reask], ...groups.map((g) => ['caller', g] as const)]);
            expect(redactCardNumbersInCallTurns(lines), `${lead[0][1]} | ${reask}`).toEqual(
              lines.map((l) => (l.speaker === 'caller' && /\d/.test(l.text) ? MARKER : l.text)),
            );
          }
        }
      }
      // A documented miss: "the account number on it" names an account
      // number, which an intake flow asks for as often as the card.
      const lines = callLeg([
        ['caller', 'my card number is'],
        ['caller', 'okay'],
        ['agent', "What's the account number on it?"],
        ...groups.map((g) => ['caller', g] as const),
      ]);
      expect(redactCardNumbersInCallTurns(lines)).toBeNull();
    });

    // "Times" counting how often ("it cut out a few times", "read it two
    // times") and "series" ("the series of numbers on the front") name no
    // time and no serial number: read with the plural that "date" and "code"
    // take, they were "another number", and the card read straight after
    // them was missed. A time asked for in the plural ("What times work for
    // you?") is still one.
    it.each(SHAPES)('%s read after a re-ask that says "times" or "series", past a pause turn', (_name, groups) => {
      for (const reask of [
        'Sorry, it cut out a few times, could you read me the number again?',
        'Sorry, the line broke up a couple of times, can you repeat the number?',
        "It's been cutting out at times, could you repeat the digits?",
        'Could you read me the series of numbers on the front?',
        'Go ahead and read me the series of numbers.',
        'Please read the number a couple more times.',
        'Can you read the digits two times so I get them right?',
        "Please read me the number, I'll repeat it back a few times.",
        "Go ahead with the number; I'll read it back two times to confirm.",
      ]) {
        for (const lead of [
          [['caller', 'my card number is'], ['caller', 'okay']],
          [['agent', 'Sure, you can pay by card.'], ['caller', 'um']],
        ] as const) {
          const lines = callLeg([...lead, ['agent', reask], ...groups.map((g) => ['caller', g] as const)]);
          expect(redactCardNumbersInCallTurns(lines), `${lead[0][1]} | ${reask}`).toEqual(
            lines.map((l) => (l.speaker === 'caller' && /\d/.test(l.text) ? MARKER : l.text)),
          );
        }
      }
    });

    // The card data and idioms name no other number, and nothing more:
    // "the alarm's security code" still names the alarm, and a date or a
    // time asked for on its own is still another number.
    it.each(SHAPES)('%s answering an ask for an alarm security code, a date or a time, after card talk and a pause, is no card', (_name, groups) => {
      for (const ask of [
        'What is the alarm security code?',
        'What are the alarm security codes?',
        "What's the code on the back of the lockbox?",
        'What date works for you?',
        'What time is best for you?',
        '¿A qué hora le queda bien?',
      ]) {
        for (const pause of ['okay', 'um', 'sí']) {
          expect(
            redactCardNumbersAcrossTurns(['my card number is', pause, ...groups], MARKER, { agentLines: [[], [], [ask]] }),
            `${pause} | ${ask}`,
          ).toBeNull();
        }
      }
    });

    /** Card talk, the agent's `ask` before or after a pause or in the card talk's own line, then the answers: no card. */
    const expectNoCardAnswering = (ask: string, groups: readonly string[]) => {
      for (const pause of ['okay', 'um', 'sí']) {
        const legs: ReadonlyArray<readonly [string, readonly string[], CardSplitContext]> = [
          ['card | pause | ask', ['my card number is', pause, ...groups], { agentLines: [[], [], [ask]] }],
          ['card | ask | pause', ["I'll pay with my Visa at the visit", pause, ...groups], { agentLines: [[], [ask]] }],
          ['agent card | ask | pause', [pause, ...groups], { agentLines: [['We take all major cards at the visit.', ask]] }],
          ['card | pause | ask | pause', ['can I pay by card when they come', pause, pause, ...groups], { agentLines: [[], ['Yes, we do.'], [ask]] }],
          ['agent card + ask | pause', [pause, ...groups], { agentLines: [[`We take all major cards at the visit. ${ask}`]] }],
        ];
        for (const [shape, turns, context] of legs) {
          expect(redactCardNumbersAcrossTurns(turns, MARKER, context), `${shape}: ${pause} | ${ask}`).toBeNull();
        }
      }
    };

    // An ask with a period inside its sentence: an honorific ("Mr. Smith",
    // "Sra. García"), a clock time ("the 2 p.m. visit"), an abbreviated
    // street, unit or direction ("Elm St.", "the apt. number", "400 N.
    // Main"), "e.g." or an ellipsis ("the gate code... for the tech?"). Split
    // at every period, its number and its question mark fell in two
    // "sentences", neither of them an ask for another number, and the
    // answers after card talk and a pause were stitched into a "card".
    it.each(SHAPES)('%s answering an ask with an abbreviation, a clock time or an ellipsis in it, after card talk and a pause, is no card', (_name, groups) => {
      for (const ask of [
        "What's the gate code, Mr. Smith?",
        "What's the best callback number, Dr. Patel?",
        'Is the lockbox code still the same, Ms. Rivera?',
        "What's the best number to reach you before the 2 p.m. visit?",
        "What's the gate code for the 9 a.m. appointment?",
        "What's the gate code for the 9 A.M. visit?",
        'Is there a gate code at 12 Elm St. for the tech?',
        "What's the zip code for St. Petersburg?",
        "What's the apt. number?",
        "What's your unit number at 400 N. Main?",
        'What zip code, e.g. 85004?',
        'And the gate code... for the tech?',
        'Y su código postal, Sra. García?',
      ]) {
        expectNoCardAnswering(ask, groups);
      }
    });

    // Card talk whose sentence ends on an abbreviation ("We take Visa,
    // Mastercard, Amex, etc.", "We'll charge the card at 2 p.m.", "our office
    // on Main St.") and the ask in the next sentence of the same line. Read
    // with no sentence ending there, the two were one sentence that named
    // the card and asked for no other number.
    it.each(SHAPES)('%s answering an ask said after card talk that ends on an abbreviation, past a pause, is no card', (_name, groups) => {
      for (const talk of [
        'We take Visa, Mastercard, Amex, etc.',
        "We'll charge the card at 2 p.m.",
        'We take cards at our office on Main St.',
        "We don't take Amex, no.",
        'Aceptamos tarjetas, Visa, Amex, etc.',
      ]) {
        for (const ask of ["What's the gate code?", 'Go ahead with the gate code.', '¿Cuál es el código postal?']) {
          for (const pause of ['okay', 'um', 'sí']) {
            expect(redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [[`${talk} ${ask}`]] }), `${talk} ${ask} | ${pause}`).toBeNull();
          }
        }
      }
    });

    // Card talk and the ask in one line with an ellipsis between them ("…",
    // as a speech-to-text engine or the model writes it, or "..."), with or
    // without a space after it. "... " ended a sentence, and "…" and "..."
    // with no space never did, so the card talk and the ask were one
    // sentence that named the card. Read as "... " is (an end, and once no
    // end), an ask with an ellipsis inside it ("And the gate code… for the
    // tech?") is still an ask. So is a request with "..." run straight on
    // into its number, in a line whose card talk ends on an ellipsis or an
    // abbreviation ("Sure, you can pay by card... Go ahead with...the gate
    // code.", "We take Visa, Mastercard, Amex, etc. Go ahead with...the
    // gate code."): split at that "..." too, it was "Go ahead with" and "the
    // gate code.", and read with no end at all, one sentence with the card
    // talk, so the line asked for nothing.
    it.each(SHAPES)('%s answering an ask said after card talk and an ellipsis, past a pause, is no card', (_name, groups) => {
      for (const line of [
        "Sure, we take all major cards at the visit… what's the gate code?",
        "Sure, we take all major cards at the visit…what's the gate code?",
        "Sure, we take all major cards at the visit...what's the gate code?",
        'Claro, puede pagar con tarjeta en la visita...¿cuál es el código del portón?',
        "Sure, you can pay by card at the visit… and what's the zip code?",
        'Sure, you can pay by card at the visit… ¿y el código postal?',
        'Claro, puede pagar con tarjeta en la visita… ¿cuál es el código del portón?',
        'Claro, puede pagar con tarjeta en la visita…¿cuál es el código del portón?',
        'We take all major cards at the visit... Go ahead with...the gate code.',
        'Sure, you can pay by card... Go ahead with...the gate code.',
        'Sure, you can pay by card… Can I get...your gate code.',
        'Claro, puede pagar con tarjeta…Dígame...el código del portón.',
        'We take Visa, Mastercard, Amex, etc. Go ahead with...the gate code.',
        "We'll charge the card at 2 p.m. Please read me...the account number.",
      ]) {
        for (const pause of ['okay', 'um', 'sí']) {
          expect(redactCardNumbersAcrossTurns([pause, ...groups], MARKER, { agentLines: [[line]] }), `${line} | ${pause}`).toBeNull();
          expect(
            redactCardNumbersAcrossTurns(['can I pay by card when they come', pause, ...groups], MARKER, { agentLines: [[], [line]] }),
            `${line} | ${pause}`,
          ).toBeNull();
        }
      }
      for (const ask of ['And the gate code… for the tech?', 'And the gate code…for the tech?', 'And the gate code...for the tech?', '¿Y el código del portón… para el técnico?']) {
        expectNoCardAnswering(ask, groups);
      }
    });

    // The number asked for in the plural ("What times work for you?",
    // "¿Cuáles son los códigos de acceso?") is another number as the singular
    // is, and so are a claim, tracking, permit, license, member or ID number
    // (a "member no." too), a VIN, the last four of a social, a birthday,
    // the number the caller is calling from or which number the tech should
    // use.
    it.each(SHAPES)('%s answering an ask for numbers in the plural, or for another kind of number, after card talk and a pause, is no card', (_name, groups) => {
      for (const ask of [
        'What times work for you?',
        'Which times work best for you?',
        'Which of the two addresses?',
        '¿Cuáles son los códigos de acceso?',
        '¿Qué fechas le quedan bien?',
        'What number are you calling from?',
        'Which number should the tech use?',
        "What's your birthday?",
        'What is the claim number?',
        "What's the tracking number?",
        "What's the permit number?",
        "What's your license number?",
        'What are the last four of your social?',
        'Can you read me the VIN?',
        'What is your member ID?',
        "What's your member number?",
        "What's your member no.?",
        "What's your ID number?",
        '¿Cuál es el número de reclamo?',
        '¿Cuál es el número de serie?',
      ]) {
        expectNoCardAnswering(ask, groups);
      }
    });

    // "Please hold", "one moment, please" or "un momento, por favor" is a
    // pause the agent takes, no request: the account, the invoice or the
    // time of payment named with it ("Please hold while I pull up your
    // account.", "Please note there's a fee at the time of payment.") is no
    // number asked for. Nor is "call out the number" a number to call. Read
    // as asks for another number, the card read after them was missed.
    type Said = readonly ['caller' | 'agent', string];
    /** Card talk, a pause, each re-ask (`true` for Spanish; its own caller turn is the pause), then the groups: still the card. */
    const expectCardReadAfter = (reasks: ReadonlyArray<readonly [boolean, ReadonlyArray<Said>]>, groups: readonly string[]) => {
      const leads = (es: boolean): ReadonlyArray<ReadonlyArray<Said>> =>
        es
          ? [
              [['caller', 'el número de mi tarjeta es'], ['caller', 'sí']],
              [['agent', 'Claro, puede pagar con tarjeta.'], ['caller', 'este']],
            ]
          : [
              [['caller', 'my card number is'], ['caller', 'okay']],
              [['agent', 'Sure, you can pay by card.'], ['caller', 'um']],
            ];
      for (const [es, reask] of reasks) {
        // A re-ask the caller answers ("okay") is the pause: the card is named right before it.
        const answered = reask.some(([speaker]) => speaker === 'caller');
        for (const lead of leads(es).map((said) => (answered ? said.slice(0, 1) : said))) {
          const lines = callLeg([...lead, ...reask, ...groups.map((g) => ['caller', g] as const)]);
          expect(redactCardNumbersInCallTurns(lines), [...lead, ...reask].map(([, text]) => text).join(' | ')).toEqual(
            lines.map((l) => (l.speaker === 'caller' && /\d/.test(l.text) ? MARKER : l.text)),
          );
        }
      }
    };
    it.each(SHAPES)('%s read after the agent puts the caller on hold, or asks to have the number called out, past a pause turn', (_name, groups) => {
      const reasks: ReadonlyArray<readonly [boolean, ReadonlyArray<Said>]> = [
        [false, [['agent', "One moment please while I pull up your account. Okay, what's the number?"]]],
        [false, [['agent', "Please bear with me, I'm pulling up your account. What's the number?"]]],
        [false, [['agent', "Thanks, please wait while I open the invoice. Ready, what's the number?"]]],
        [false, [['agent', 'Just a moment, please, while I find your account. Go ahead.']]],
        [false, [['agent', 'Please hold while I pull up your account.'], ['caller', 'okay'], ['agent', 'Go ahead with the number.']]],
        [false, [['agent', 'One moment please while I pull up your account.'], ['caller', 'okay'], ['agent', "What's the number?"]]],
        [false, [['agent', 'Thanks, please hold, I am pulling up the invoice.'], ['caller', 'okay'], ['agent', 'Ready, go ahead.']]],
        [false, [['agent', "Please note there's a three percent fee at the time of payment."], ['caller', 'okay'], ['agent', 'Go ahead with the number.']]],
        [false, [['agent', 'Can you call out the number for me?']]],
        [false, [['agent', 'Could you call out the digits one more time?']]],
        [true, [['agent', 'Un momento, por favor, mientras abro su cuenta. ¿Cuál es el número?']]],
        [true, [['agent', 'Un momento, por favor, abro su cuenta.'], ['caller', 'sí'], ['agent', 'Listo, dígame el número.']]],
        [true, [['agent', 'Espere, por favor, abro su factura.'], ['caller', 'sí'], ['agent', 'Listo, dígame el número.']]],
        // "Hang on", "be patient", "give me" or "allow me" a moment or a
        // second, "deme un momento": holds as well.
        [false, [['agent', 'Please hang on while I pull up your account.'], ['caller', 'okay'], ['agent', 'Go ahead with the number.']]],
        [false, [['agent', 'Please give me a moment while I pull up your account.'], ['caller', 'okay'], ['agent', 'Go ahead with the number.']]],
        [false, [['agent', 'Please allow me a moment to pull up your account.'], ['caller', 'okay'], ['agent', 'Go ahead with the number.']]],
        [false, [['agent', 'Please be patient while I pull up your account.'], ['caller', 'okay'], ['agent', 'Go ahead with the number.']]],
        [false, [['agent', 'Please give me a second to open your account.'], ['caller', 'okay'], ['agent', 'Okay, go ahead.']]],
        [false, [['agent', "Give me a moment while I pull up your account. Okay, what's the number?"]]],
        [true, [['agent', 'Por favor, deme un momento mientras abro su cuenta.'], ['caller', 'sí'], ['agent', 'Listo, dígame el número.']]],
        [true, [['agent', 'Deme un segundo, busco su cuenta. Listo, ¿cuál es el número?']]],
      ];
      expectCardReadAfter(reasks, groups);
      // A hold, then an ask for another number, still asks for it.
      for (const ask of ["Please hold. What's the gate code?", 'One moment please, and the gate code?', 'Un momento, por favor. ¿Cuál es el código postal?']) {
        expectNoCardAnswering(ask, groups);
      }
    });

    // A hold that asks the caller to fetch another number, or have it ready
    // ("Please hold on while you grab your account number.", "Please hold
    // and have your account number ready.", "Please note we'll need your
    // gate code.", "Espere, por favor, y tenga a mano el código del
    // portón."): with the hold's "please" set aside, the sentence held no
    // request, and the number the caller then read out after card talk and
    // a pause was stitched into a "card" (the caller's words rewritten, the
    // recording's audio purged). The fetch is the request, and it wins over
    // a hold said with it ("Please give me a moment while you find your gate
    // code."); so does a second number asked for ("Please give me a second
    // phone number.", "Give me a second gate code.", "Give me a second,
    // alternate phone number.", "Please give me a second way to reach
    // you.", "Deme un segundo código."), which read as a hold and asked for
    // nothing.
    it.each(SHAPES)('%s answering a hold that asks the caller to fetch another number, after card talk and a pause, is no card', (_name, groups) => {
      for (const ask of [
        'Please hold on while you grab your account number.',
        'Please hold and have your account number ready.',
        'One moment, please, while you find the account number.',
        'Please wait while you look up the gate code.',
        'Please stay on the line and have your gate code handy.',
        "Please note we'll need your gate code.",
        'Un momento, por favor, mientras busca el número de cuenta.',
        'Espere, por favor, y tenga a mano el código del portón.',
        'Please give me a moment while you find your gate code.',
        'Por favor, deme un momento mientras busca el código del portón.',
        'Please give me a second phone number.',
        'Deme un segundo número de teléfono.',
        'Give me a second gate code.',
        'Give me a second, alternate phone number.',
        'Please give me a second way to reach you.',
        'Deme un segundo código.',
      ]) {
        expectNoCardAnswering(ask, groups);
      }
    });

    // A re-ask that has the caller fetch the card while the agent pulls up
    // the account, the invoice or the order itself ("While you grab that,
    // I'll pull up your invoice.", "okay", "Okay, go ahead."; "Have your
    // number ready while I pull up the invoice."; "Mientras busca, abro su
    // factura."). Read as a request for every number its sentence named,
    // the fetch made the agent's own invoice or account "another number",
    // and the card read straight after it was missed. A fetch asks only for
    // what it fetches, in its own clause (to a comma, a dash or a bracket,
    // or to where the agent says what it does itself, "I'll pull up"; what
    // is needed, to the "to" of what it is for); a fetch of another number
    // still asks for it, whatever the agent pulls up.
    it.each(SHAPES)('%s read after a re-ask that has the caller fetch the card while the agent pulls up an account, invoice or order, past a pause turn', (_name, groups) => {
      expectCardReadAfter(
        [
          [false, [['agent', "I'll pull up your account while you grab the number."]]],
          [false, [['agent', 'While you grab the number, I will pull up the invoice.']]],
          [false, [['agent', "While you grab that, I'll pull up your invoice."], ['caller', 'okay'], ['agent', 'Okay, go ahead.']]],
          [false, [['agent', 'While you get it, let me open your account.'], ['caller', 'okay'], ['agent', "Go ahead whenever you're ready."]]],
          [false, [['agent', "I'll pull up the invoice while you get that."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', "While you're finding it, I'll bring up your order."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', "We'll need that to pay off the invoice."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', 'I will need the number to close out the invoice.']]],
          [false, [['agent', 'We will need the long number to settle the invoice.']]],
          [true, [['agent', 'Mientras busca, abro su factura.'], ['caller', 'sí'], ['agent', 'Dígame.']]],
          [true, [['agent', 'Tenga a mano el número, abro su cuenta.'], ['caller', 'sí'], ['agent', 'Dígame.']]],
          [false, [['agent', 'Have your number ready while I pull up the invoice.'], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', 'Let me pull up your account while you get the number ready.']]],
          [false, [['agent', "We'll need the number on the front, and I'll pull up your account."]]],
          // With no comma before what the agent does itself.
          [false, [['agent', "While you grab the number I'll pull up the invoice."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', 'While you grab the number and I pull up your account, go ahead.']]],
          [false, [['agent', 'While you get that I will open your account.'], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', "We'll need the number to pay the invoice and the account."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          // With a dash or a bracket before it, as the model writes them.
          [false, [['agent', "While you grab that—I'll pull up your invoice."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', "While you grab that–I'll pull up your invoice."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', "While you grab the number (I'll pull up the invoice)."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [false, [['agent', "We'll need that—then the invoice is paid."], ['caller', 'okay'], ['agent', 'Go ahead.']]],
          [true, [['agent', 'Mientras busca el número—abro su factura.'], ['caller', 'sí'], ['agent', 'Dígame.']]],
        ],
        groups,
      );
      for (const ask of [
        "While you grab your gate code, I'll pull up your account.",
        "I'll pull up the invoice while you find the account number.",
        "While you grab the gate code I'll wait.",
        'Have your gate code ready while I pull up the invoice.',
        "We'll need your gate code to let the tech in.",
        "We'll need your number to call you back.",
        'We will need to get your gate code.',
        "We'll need you to grab the gate code.",
        'Mientras busca el código del portón, abro su factura.',
        'While you grab your gate code—I will pull up your account.',
        'Mientras busca el código del portón—abro su factura.',
      ]) {
        expectNoCardAnswering(ask, groups);
      }
    });

    // A fetch is read to where it ends a character at a time, and every
    // sentence of an agent line is read: a long run of spaces after "we
    // will need" or "while you", or of ellipses, costs in proportion to its
    // length, never its square (a lookahead over the whole run at every
    // space took 50 ms for 2,000 spaces and seconds for 20,000).
    it('reads a long agent line for an ask in time proportional to its length', () => {
      const best = (run: () => unknown): number => {
        let fastest = Infinity;
        for (let k = 0; k < 3; k++) {
          const started = performance.now();
          run();
          fastest = Math.min(fastest, performance.now() - started);
        }
        return fastest;
      };
      const legAfter = (line: string) =>
        callLeg([['caller', 'my card number is'], ['agent', line], ['caller', 'okay'], ...['4111', '1111', '1111', '1111'].map((g) => ['caller', g] as const)]);
      for (const make of [
        (n: number) => `we will need you${' '.repeat(n)}`,
        (n: number) => `while you${' '.repeat(n)}`,
        (n: number) => '...a'.repeat(n / 4),
      ]) {
        const small = legAfter(make(2_000));
        const large = legAfter(make(16_000));
        const smallMs = best(() => redactCardNumbersInCallTurns(small));
        const largeMs = best(() => redactCardNumbersInCallTurns(large));
        expect(largeMs, make(8).trim()).toBeLessThan(2.5 * 8 * smallMs + 20);
      }
    });

    // "id" and "vin" name another number only as words of their own, and
    // "member" only as a member number or ID: "Did you find it?", "Are you
    // driving?", "Do you remember it?", "Members get ten percent off" and "a
    // family member's name" ask for none, and the card read after them is
    // still the card. Nor is "which number" another number unless it asks
    // which one to use ("Which number should the tech use?"): "Sorry, which
    // number was that?" asks for the card again.
    it.each(SHAPES)('%s read after a re-ask that holds "id", "vin" or "member" inside a word, or asks which number was said, past a pause turn', (_name, groups) => {
      for (const reask of [
        'Did you find it? Go ahead with the number.',
        "Are you driving? Go ahead when you're ready.",
        "Do you remember it? What's the number?",
        'Members get ten percent off, so please read me the number.',
        "Is that in a family member's name? Go ahead with the number.",
        'Sorry, which number was that?',
        'Which number is on the front?',
      ]) {
        const lines = callLeg([
          ['caller', 'my card number is'],
          ['caller', 'okay'],
          ['agent', reask],
          ...groups.map((g) => ['caller', g] as const),
        ]);
        expect(redactCardNumbersInCallTurns(lines), reask).toEqual(lines.map((l) => (l.speaker === 'caller' && /\d/.test(l.text) ? MARKER : l.text)));
      }
    });
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
      { length: 16, prefix: String(2221 + Math.floor(random() * 500)), turns: [12, 4] }, // a 2-series Mastercard
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
        // A window with a turn of four digits or fewer needs the card
        // mentioned near it; the agent does where the caller does not.
        const mentioned = turns.every((size) => size > 4) || spoken[0].startsWith('my card is');
        const agentLines = mentioned
          ? []
          : [
              [
                pick([
                  "Sorry, I can't take card numbers over the phone.",
                  "For your security, please don't read your card number to me.",
                  'Is that a credit card?',
                ]),
              ],
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
 * like a card read group by group: before the year and mention rules 35, 133,
 * 323 and 366 of these 5,000-sequence sets were stitched (years said as words
 * only once tens and teens were read as digits).
 */
describe('redactCardNumbersAcrossTurns — seeded simulation of four-digit answers', () => {
  const random = seededRandom(2026);
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const pair = (n: number): string =>
    n < 10 ? EN[n] : n < 20 ? TEENS[n - 10] : n % 10 ? `${TENS[Math.floor(n / 10)]}-${EN[n % 10]}` : TENS[n / 10];
  const four = (): string => String(int(0, 9999)).padStart(4, '0');
  const year = (): number => int(2000, 2026);
  const yearWords = (y: number): string =>
    y < 2010 ? pick([`twenty oh ${EN[y - 2000]}`, `two thousand ${EN[y - 2000]}`]) : `${pair(Math.floor(y / 100))} ${pair(y % 100)}`;
  const sequences: Record<string, () => string[]> = {
    'equipment years': () => Array.from({ length: int(3, 5) }, () => pick(['', '', 'around ', 'in ', 'it was '])  + `${year()}${pick(['', '.'])}`),
    'three codes and a quantity': () => [four(), four(), pick(['', 'the code is ']) + four(), String(int(1, 12))],
    'four-digit answers': () =>
      Array.from({ length: int(3, 5) }, () => pick([String(year()), four(), `last four ${four()}`, String(int(1000, 9999))])),
    'equipment years as words': () => Array.from({ length: int(3, 5) }, () => yearWords(year())),
  };

  it('stitches none of 20,000 such sequences', () => {
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

/**
 * Eight-digit answers (account and order numbers, dates written 10222026),
 * zips, years, phones and house numbers, with a caller's "okay", "um" or
 * "sure" said as a turn of its own between some of them. Two eight-digit
 * answers read as two halves of a card; a card read on past an
 * acknowledgement turn, or a 13-digit one whose last turn holds its last
 * four and one ([8,5]), is taken only where the card is mentioned. Of these
 * 20,000 sequences, 73 were "cards" before (all two halves of eight); reading
 * on past the acknowledgement turns with no mention made it 144.
 */
describe('redactCardNumbersAcrossTurns — seeded simulation of answers with acknowledgement turns', () => {
  it('finds no more "cards" than two eight-digit halves already were', () => {
    const random = seededRandom(3535);
    const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
    const digits = (n: number): string => String(int(1, 9)) + Array.from({ length: n - 1 }, () => String(int(0, 9))).join('');
    const answers: ReadonlyArray<() => string> = [
      () => digits(int(1, 5)),
      () => String(int(1000, 99999)).padStart(5, '0'),
      () => String(int(1950, 2025)),
      () => digits(8),
      () => `${digits(4)} ${digits(4)}`,
      () => `${int(1, 12)}${String(int(1, 28)).padStart(2, '0')}${int(2024, 2027)}`,
      () => `${int(201, 989)} ${int(200, 999)} ${digits(4)}`,
      () => digits(int(6, 7)),
      () => digits(9),
    ];
    const acks = ['okay', 'mm-hmm', 'um', 'yes', 'sure', 'hmm'];
    let found = 0;
    for (let n = 0; n < 20_000; n++) {
      const turns: string[] = [];
      const count = int(2, 4);
      for (let k = 0; k < count; k++) {
        turns.push(pick(answers)());
        if (k < count - 1 && random() < 0.5) turns.push(pick(acks));
      }
      if (redactCardNumbersAcrossTurns(turns.slice(-5))) found++;
    }
    expect(found).toBeLessThanOrEqual(66);
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

  // The agent's confirm readback renders what the classifier took from the
  // turn ("…the card on file is 4111 1111 1111. Is that right?"): once a later
  // turn shows those digits were part of a card, the readback holds them too.
  it("rewrites the agent's lines that repeat a part of the card the caller had already said", () => {
    expect(
      redactCardNumbersInCallTurns([
        agent('How can I help?', 0),
        caller('add a note for Dana Reyes, the card on file is four one one one, one one one one, one one one one', 2),
        agent("Just to confirm: a note for Dana Reyes, the card on file is 4111-1111-1111. Is that right?", 4),
        caller("1111. Yes, that's right.", 8),
        agent('Done. Your note 4111 1111 1111 is saved.', 10),
      ]),
    ).toEqual([
      'How can I help?',
      `add a note for Dana Reyes, the card on file is ${MARKER}`,
      `Just to confirm: a note for Dana Reyes, the card on file is ${MARKER}. Is that right?`,
      `${MARKER}. Yes, that's right.`,
      // Said after the card was complete: built from the rewritten turn, and
      // no line of the card's own.
      'Done. Your note 4111 1111 1111 is saved.',
    ]);
    // Only what the caller said before the agent's line: a group the agent
    // said first is its own.
    expect(
      redactCardNumbersInCallTurns([
        caller('my card is 4111', 0),
        agent('Your unit number is 1111, go on.', 1),
        caller('1111', 2),
        agent('And then? You said 4111 and 1111.', 3),
        caller('1111 1111', 4),
      ]),
    ).toEqual([
      `my card is ${MARKER}`,
      'Your unit number is 1111, go on.',
      MARKER,
      `And then? You said ${MARKER} and ${MARKER}.`,
      MARKER,
    ]);
  });

  it('returns null when nothing changes, and leaves a clean (already rewritten) call alone', () => {
    expect(redactCardNumbersInCallTurns([])).toBeNull();
    expect(
      redactCardNumbersInCallTurns([caller(`my card is ${MARKER}`, 0), caller(MARKER, 3), caller(`${MARKER} thanks`, 6)]),
    ).toBeNull();
  });
});

describe('redactCardFragments', () => {
  it('replaces every run of digits that reads a fragment, written or as words, and nothing else', () => {
    const said = ['4111 1111 1111'];
    for (const run of [
      '4111 1111 1111',
      '4111-1111-1111',
      '411111111111',
      'four one one one, one one one one, one one one one',
      'forty-one eleven eleven eleven eleven eleven',
    ]) {
      expect(redactCardFragments(`the card on file is ${run}. Is that right?`, said)).toBe(
        `the card on file is ${MARKER}. Is that right?`,
      );
    }
    // Only whole groups: a ZIP or a longer number that merely holds the
    // fragment's digits is another number, and so is a phone number ending in
    // them.
    for (const text of ['zip 84111', 'unit 41111', 'call 602 555 4111', 'call (602) 555-4111', 'call 6025554111']) {
      expect(redactCardFragments(text, ['4111', '1111 1111'])).toBe(text);
    }
    // A number word said next to the digits is a group of its own.
    expect(redactCardFragments('and the last four, 1111 1111?', ['4111', '1111 1111'])).toBe(
      `and the last four, ${MARKER}?`,
    );
    // Fragments said one after the other may be repeated together.
    expect(redactCardFragments('so 4111 1111 1111 1111?', ['4111 1111', '1111 1111'])).toBe(`so ${MARKER}?`);
    expect(redactCardFragments('no digits here', said)).toBe('no digits here');
    expect(redactCardFragments('4111 1111 1111', [])).toBe('4111 1111 1111');
  });
});

describe('agentLinesBefore', () => {
  it("takes, for each caller turn of a window, the agent's lines since the caller's previous line", () => {
    const lines = [
      { speaker: 'agent' as const, text: 'hi' },
      { speaker: 'caller' as const, text: 'I need a plumber' },
      { speaker: 'agent' as const, text: 'what is the address?' },
      { speaker: 'caller' as const, text: '12 Main' },
      { speaker: 'caller' as const, text: '4111' },
      { speaker: 'agent' as const, text: 'go on' },
      { speaker: 'agent' as const, text: 'and the rest?' },
      { speaker: 'caller' as const, text: '1111' },
      { speaker: 'agent' as const, text: 'said after the last turn' },
    ];
    // Window: the caller turns at 3, 4 and 7.
    expect(agentLinesBefore(lines, [3, 4, 7])).toEqual([['what is the address?'], [], ['go on', 'and the rest?']]);
    // A turn not stored yet comes after every line.
    expect(agentLinesBefore(lines, [7, 9])).toEqual([['go on', 'and the rest?'], ['said after the last turn']]);
    expect(agentLinesBefore(lines.slice(1), [0])).toEqual([[]]);
  });
});

describe('containsCardNumber', () => {
  it('is true for text that carries the marker and false otherwise', () => {
    expect(CARD_NUMBER_PLACEHOLDER).toBe('[card number]');
    expect(containsCardNumber('caller: my card is [card number]')).toBe(true);
    expect(containsCardNumber('caller: what is my card number on file')).toBe(false);
  });
});
