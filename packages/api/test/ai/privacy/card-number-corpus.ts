/**
 * PRIV-3 — a seeded corpus of what callers say on a home-services call, for
 * measuring the card-number scrubber's false positives and its recall.
 *
 * A false positive is not free: every "card" found rewrites the caller's
 * words in the stored transcript and the call's rows and has the recording's
 * audio purged early, which cannot be undone. So the corpus holds the numbers
 * a caller does say (gate and lockbox codes, last-four answers, equipment
 * years, prices, times, dates, house numbers, ZIPs, phone numbers read in
 * groups, in pairs and the Mexican way, long account, order and serial
 * numbers), written as STT writes them or read as English or Spanish words,
 * with and without talk of paying near them, bare answers given one per turn
 * (`qaLeg`), and the cards a caller reads with the card mentioned near them.
 *
 * Deterministic: every generator draws from its own mulberry32 stream.
 */

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
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
export function withLuhnCheckDigit(body: string): string {
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

/**
 * The digit-only scrubber as it shipped before digit words were read
 * (packages/api/src/ai/privacy/pan-redact.ts at da456f812), kept verbatim in
 * behaviour as the oracle for written digits: reading words must not change
 * a single redaction of text that holds none.
 */
export function digitOnlyScrubber(text: string, onRedact: (matched: string, offset: number) => void = () => {}): string {
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

type Lang = 'en' | 'es';
/** How a number is said: written digits, one word per digit, or in pairs ("forty-one eleven"). */
type Style = 'written' | 'words' | 'pairs';

const EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const ES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const EN_TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ES_TEENS = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const ES_TWENTIES = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const ES_TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];

/** One caller line, or one call leg as stored (both speakers, epoch ms). */
export interface CallLine {
  speaker: 'caller' | 'agent';
  text: string;
  at: number;
}

export class CardNumberCorpus {
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = seededRandom(seed);
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.random() * xs.length)];
  }

  chance(p: number): boolean {
    return this.random() < p;
  }

  /** `n` random digits, the first never 0 unless `leadingZero`. */
  digits(n: number, leadingZero = false): string {
    let out = leadingZero ? String(this.int(0, 9)) : String(this.int(1, 9));
    while (out.length < n) out += String(this.int(0, 9));
    return out;
  }

  // ── Saying a number ────────────────────────────────────────────────────

  private digitWord(d: string, lang: Lang): string {
    if (lang === 'en' && d === '0') return this.pick(['zero', 'oh', 'oh']);
    return (lang === 'en' ? EN : ES)[Number(d)];
  }

  /** Two digits as a ten or a teen ("forty-one", "cuarenta y uno"); "oh five" for 05. */
  private pairWords(two: string, lang: Lang): string {
    const n = Number(two);
    if (two[0] === '0') return `${this.digitWord('0', lang)} ${this.digitWord(two[1], lang)}`;
    if (lang === 'en') {
      if (n < 20) return EN_TEENS[n - 10];
      const unit = n % 10;
      return unit ? `${EN_TENS[Math.floor(n / 10)]}${this.pick(['-', ' '])}${EN[unit]}` : EN_TENS[n / 10];
    }
    if (n < 20) return ES_TEENS[n - 10];
    if (n < 30) return ES_TWENTIES[n - 20];
    const unit = n % 10;
    return unit ? `${ES_TENS[Math.floor(n / 10)]} y ${ES[unit]}` : ES_TENS[n / 10];
  }

  /** A group of digits said in `style`. */
  sayGroup(group: string, style: Style, lang: Lang): string {
    if (style === 'written') return group;
    if (style === 'words') return [...group].map((d) => this.digitWord(d, lang)).join(' ');
    const words: string[] = [];
    let i = 0;
    // An odd group reads its first digit alone ("six, fifty-five").
    if (group.length % 2 === 1) words.push(this.digitWord(group[i++], lang));
    for (; i < group.length; i += 2) words.push(this.pairWords(group.slice(i, i + 2), lang));
    return words.join(' ');
  }

  /** Groups said with the pause between them STT writes. */
  sayGroups(groups: readonly string[], style: Style, lang: Lang): string {
    const said = groups.map((g) => this.sayGroup(g, style, lang));
    if (style === 'written') {
      const sep = this.pick([' ', ' ', '-', ', ']);
      return said.join(sep);
    }
    return said.reduce((out, g, k) => (k === 0 ? g : `${out}${this.pick([', ', ', ', ' ', lang === 'es' ? ', y ' : ', and '])}${g}`), '');
  }

  style(): Style {
    return this.pick(['written', 'written', 'words', 'pairs']);
  }

  // ── Numbers that are not cards ─────────────────────────────────────────

  /** One number a caller gives on an intake call, with the words around it. */
  answer(lang: Lang): string {
    const style = this.style();
    const en = lang === 'en';
    switch (
      this.pick([
        'gate',
        'lockbox',
        'lastFour',
        'year',
        'price',
        'time',
        'date',
        'house',
        'zip',
        'phone',
        'phonePairs',
        'mexicanPhone',
        'account',
        'quantity',
      ] as const)
    ) {
      case 'gate': {
        const code = this.digits(this.pick([4, 4, 5, 6]), true);
        return `${this.pick(en ? ['the gate code is ', 'gate code ', "it's ", ''] : ['el código del portón es ', 'el código es ', ''])}${this.sayGroup(code, style, lang)}`;
      }
      case 'lockbox': {
        const code = this.digits(4, true);
        return `${this.pick(en ? ['the lockbox is ', 'lockbox code ', 'the key box is '] : ['la caja de llaves es ', 'el candado es '])}${this.sayGroup(code, style, lang)}`;
      }
      case 'lastFour': {
        const four = this.digits(4, true);
        return `${this.pick(en ? ['the last four are ', 'last four ', 'it ends in ', 'ending in '] : ['los últimos cuatro son ', 'termina en '])}${this.sayGroup(four, style, lang)}`;
      }
      case 'year': {
        const year = String(this.int(1965, 2026));
        const said =
          style === 'written'
            ? year
            : style === 'pairs' || this.chance(0.5)
              ? `${this.pairWords(year.slice(0, 2), lang)} ${this.pairWords(year.slice(2), lang)}`
              : this.sayGroup(year, 'words', lang);
        return `${this.pick(en ? ['it was installed in ', 'around ', 'in ', "it's from ", ''] : ['se instaló en ', 'en el ', 'del año ', ''])}${said}`;
      }
      case 'price': {
        const dollars = this.int(20, 9500);
        if (style === 'written') {
          const grouped = dollars >= 1000 ? `${Math.floor(dollars / 1000)},${String(dollars % 1000).padStart(3, '0')}` : String(dollars);
          return this.pick([`$${grouped}`, `${dollars} dollars`, `$${dollars}.${String(this.int(0, 99)).padStart(2, '0')}`, `${dollars} dólares`]);
        }
        const s = String(dollars);
        // "twelve fifty", "doce cincuenta": a price is read in pairs.
        return `${this.sayGroup(s, 'pairs', lang)} ${en ? 'dollars' : 'dólares'}`;
      }
      case 'time': {
        const h = this.int(1, 12);
        const m = this.pick([0, 15, 30, 45, this.int(0, 59)]);
        if (style === 'written') return `${this.pick(en ? ['at ', 'around ', ''] : ['a las ', ''])}${h}:${String(m).padStart(2, '0')}`;
        const hour = this.sayGroup(String(h), h >= 10 ? 'pairs' : 'words', lang);
        return `${this.pick(en ? ['at ', 'around ', ''] : ['a las ', ''])}${hour}${m ? ` ${this.sayGroup(String(m).padStart(2, '0'), 'pairs', lang)}` : ''}`;
      }
      case 'date': {
        const mo = this.int(1, 12);
        const d = this.int(1, 28);
        const y = this.int(2024, 2027);
        if (style === 'written') return this.pick([`${mo}/${d}`, `${mo}/${d}/${y}`, `${mo}-${d}-${y}`, `${d} ${mo} ${y}`]);
        return `${this.sayGroup(String(mo), mo >= 10 ? 'pairs' : 'words', lang)} ${this.sayGroup(String(d), d >= 10 ? 'pairs' : 'words', lang)}`;
      }
      case 'house': {
        const n = this.digits(this.pick([1, 2, 3, 3, 4, 4, 4, 5, 5]));
        return `${this.sayGroup(n, style === 'words' && n.length > 2 ? 'pairs' : style, lang)} ${this.pick(en ? ['Main Street', 'Oak Avenue', 'North 7th', ''] : ['calle Juárez', 'avenida Central', ''])}`.trim();
      }
      case 'zip': {
        const zip = this.digits(5, true);
        const plus4 = this.chance(0.2) ? this.digits(4, true) : '';
        const said = plus4 ? this.sayGroups([zip, plus4], style, lang) : this.sayGroup(zip, style, lang);
        return `${this.pick(en ? ['zip is ', 'the zip code is ', "it's ", ''] : ['el código postal es ', ''])}${said}`;
      }
      case 'phone': {
        const groups = [String(this.int(201, 989)), String(this.int(200, 999)), this.digits(4, true)];
        const lead = this.pick(en ? ['call me at ', 'my number is ', "it's ", 'you can reach me at ', ''] : ['mi número es ', 'llámame al ', '']);
        if (style === 'written' && this.chance(0.4)) {
          return `${lead}${this.pick([`(${groups[0]}) ${groups[1]}-${groups[2]}`, groups.join(''), `+1 ${groups.join(' ')}`])}`;
        }
        return `${lead}${this.sayGroups(groups, style, lang)}`;
      }
      case 'phonePairs': {
        // 3-3-2-2: "six oh two, five five five, zero one, ninety-nine".
        const digits = String(this.int(201, 989)) + String(this.int(200, 999)) + this.digits(4, true);
        const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8)];
        return `${this.pick(en ? ['my number is ', 'call me at ', ''] : ['mi número es ', ''])}${groups
          .map((g, k) => this.sayGroup(g, k < 2 ? (style === 'pairs' ? 'words' : style) : style === 'written' ? 'written' : 'pairs', lang))
          .join(', ')}`;
      }
      case 'mexicanPhone': {
        // Five pairs, or 2-4-4 written.
        const digits = this.pick(['55', '33', '81']) + this.digits(8, true);
        if (style === 'written') return `${this.pick(['mi número es ', 'llámame al ', ''])}${this.pick([`${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`, digits])}`;
        const groups = [0, 2, 4, 6, 8].map((i) => digits.slice(i, i + 2));
        return `${this.pick(['mi número es ', 'llámame al ', ''])}${groups.map((g) => this.sayGroup(g, 'pairs', 'es')).join(this.pick([', ', ' ']))}`;
      }
      case 'account': {
        // A long account, order, policy or serial number.
        const n = this.int(8, 20);
        const digits = this.digits(n, true);
        const lead = this.pick(
          en
            ? ['my account number is ', 'the order number is ', 'serial number ', 'the model number is ', 'policy number ', 'confirmation number ', 'the tracking number is ']
            : ['mi número de cuenta es ', 'el número de orden es ', 'el número de serie es '],
        );
        const groups = this.chance(0.5) ? [digits] : (digits.match(new RegExp(`.{1,${this.pick([3, 4, 4])}}`, 'g')) ?? [digits]);
        return `${lead}${this.sayGroups(groups, style, lang)}`;
      }
      case 'quantity': {
        const q = this.int(1, 24);
        return `${this.pick(en ? ['just ', 'about ', ''] : ['como ', ''])}${this.sayGroup(String(q), q >= 10 && style !== 'written' ? 'pairs' : style, lang)}`;
      }
    }
  }

  /** Talk of paying with no card in it: "debit", "credit" and "discover" alone, and paying itself, are no card. */
  paymentTalk(lang: Lang): string {
    return this.pick(
      lang === 'en'
        ? [
            "I'll pay when the tech comes out",
            'can I pay later',
            'is there a payment plan',
            'I already paid the deposit',
            'the payment link did not work',
            'I have a store credit from last time',
            'do you take debit or just cash',
            'I want to discover what is wrong first',
            'will I get a credit for the visit',
            'my payment is due on the first',
            'paying cash is fine',
          ]
        : [
            'quiero pagar en efectivo',
            'el pago lo hago después',
            '¿puedo pagar cuando venga el técnico?',
            'ya hice el pago',
            'tengo un crédito de la última vez',
          ],
    );
  }

  /** A mention of a card. */
  cardTalk(lang: Lang): string {
    return this.pick(
      lang === 'en'
        ? [
            'can I pay with my card',
            "I'll put it on my Visa",
            'do you take American Express',
            'my credit card',
            "I'd like to pay by debit card",
            'the card on file',
            'do you take Mastercard',
          ]
        : ['puedo pagar con tarjeta', 'mi tarjeta de crédito', 'con la tarjeta de débito', '¿aceptan Visa?'],
    );
  }

  /** Something said on a call with no number in it. */
  smallTalk(lang: Lang): string {
    return this.pick(
      lang === 'en'
        ? [
            'my water heater is leaking',
            'the AC stopped blowing cold air yesterday',
            'there is water all over the garage floor',
            'can somebody come out this week',
            'the dog will be in the backyard',
            'please call before you come',
            'it makes a loud banging noise',
            'I think the thermostat is broken',
            'mornings are better for me',
            'thank you so much',
          ]
        : [
            'mi calentador de agua tiene una fuga',
            'el aire acondicionado no enfría',
            '¿pueden venir esta semana?',
            'por favor llamen antes de venir',
            'muchas gracias',
          ],
    );
  }

  /** How an answer and the next are joined in one utterance. */
  private joiner(lang: Lang): string {
    return this.pick(lang === 'en' ? [', ', ', and ', ' and ', '. ', ', uh, '] : [', ', ' y ', '. ', ', este, ']);
  }

  /**
   * One caller utterance with one to four numbers in it, joined as speech
   * joins them, and, with `talk`, talk of paying ('payment', no card in it)
   * or a mention of the card ('card') right next to them.
   */
  utterance(talk: 'none' | 'payment' | 'card'): string {
    const lang: Lang = this.chance(0.3) ? 'es' : 'en';
    const n = this.pick([1, 2, 2, 3, 3, 4]);
    let out = '';
    for (let k = 0; k < n; k++) out += (k === 0 ? '' : this.joiner(lang)) + this.answer(lang);
    if (talk === 'none') return out;
    const said = talk === 'payment' ? this.paymentTalk(lang) : this.cardTalk(lang);
    return this.chance(0.5) ? `${said}, ${out}` : `${out}, ${said}`;
  }

  /**
   * A whole call as the transcription worker sees it (one text): sentences of
   * small talk and numbers, and, with `talk`, the caller mentioning the card or
   * paying once, many sentences away from the numbers.
   */
  recording(talk: 'none' | 'payment' | 'card'): string {
    const lang: Lang = this.chance(0.3) ? 'es' : 'en';
    const sentences: string[] = [];
    const count = this.int(8, 16);
    for (let k = 0; k < count; k++) {
      sentences.push(this.chance(0.5) ? this.smallTalk(lang) : this.answer(lang));
    }
    if (talk !== 'none') {
      const said = talk === 'payment' ? this.paymentTalk(lang) : this.cardTalk(lang);
      // Far from the numbers: first, with small talk after it.
      sentences.unshift(said, this.smallTalk(lang), this.smallTalk(lang), this.smallTalk(lang), this.smallTalk(lang));
    }
    return sentences.join('. ');
  }

  /**
   * A call leg as stored (agent and caller lines, epoch ms, seconds apart):
   * the agent asks, the caller answers with one number a turn. With `talk`,
   * the caller mentions paying or the card 'adjacent' (the turn right before
   * the numbers) or 'early' (a few turns before them, inside the minute), or
   * the agent mentions the card ('agent', right before the numbers).
   */
  callLeg(talk: 'none' | 'payment' | 'card-adjacent' | 'card-early' | 'agent-card'): CallLine[] {
    const lang: Lang = this.chance(0.3) ? 'es' : 'en';
    const lines: CallLine[] = [];
    let at = 1_000_000;
    const say = (speaker: 'caller' | 'agent', text: string): void => {
      lines.push({ speaker, text, at });
      at += this.int(2, 6) * 1000;
    };
    const ask = (): string =>
      this.pick(
        lang === 'en'
          ? ['What is the gate code?', 'And the zip?', 'What year was it installed?', 'What is a good callback number?', 'Anything else?', 'Go on.', 'Okay.']
          : ['¿Cuál es el código?', '¿Y el código postal?', '¿De qué año es?', '¿A qué número le llamo?', 'Adelante.'],
      );
    say('agent', lang === 'en' ? 'Thanks for calling, how can I help?' : 'Gracias por llamar, ¿en qué le ayudo?');
    if (talk === 'card-early' || talk === 'payment') {
      say('caller', talk === 'payment' ? this.paymentTalk(lang) : this.cardTalk(lang));
      say('agent', ask());
      say('caller', this.smallTalk(lang));
      say('agent', ask());
    }
    if (talk === 'card-adjacent') {
      say('caller', this.cardTalk(lang));
      say('agent', ask());
    }
    if (talk === 'agent-card') {
      say('caller', this.smallTalk(lang));
      say('agent', this.pick(["Sorry, I can't take card numbers over the phone.", 'We take all major credit cards at the visit.']));
    }
    const answers = this.int(2, 5);
    for (let k = 0; k < answers; k++) {
      say('caller', this.answer(lang));
      if (this.chance(0.6)) say('agent', ask());
    }
    return lines;
  }

  /**
   * One question an intake flow asks and the caller's bare answer to it: the
   * number alone, as groups (a serial number read in two fours).
   */
  private bareAnswer(lang: Lang): { ask: string; groups: string[] } {
    const en = lang === 'en';
    switch (
      this.pick(['gate', 'lockbox', 'lastFour', 'pin', 'year', 'time', 'serial', 'house', 'zip', 'price', 'model', 'invoice'] as const)
    ) {
      case 'gate':
        return { ask: en ? "What's the gate code?" : '¿Cuál es el código del portón?', groups: [this.digits(this.pick([4, 4, 4, 5, 6]), true)] };
      case 'lockbox':
        return { ask: en ? 'And the lockbox code?' : '¿Y el código de la caja de llaves?', groups: [this.digits(4, true)] };
      case 'lastFour':
        return {
          ask: en ? this.pick(['And the last four of your phone?', 'What are the last four of the account?']) : '¿Y los últimos cuatro de su teléfono?',
          groups: [this.digits(4, true)],
        };
      case 'pin':
        return { ask: en ? 'And the account PIN?' : '¿Y el PIN de la cuenta?', groups: [this.digits(4, true)] };
      case 'year':
        return { ask: en ? 'What year was the unit installed?' : '¿De qué año es el equipo?', groups: [String(this.int(1985, 2026))] };
      case 'time':
        return {
          ask: en ? 'What time works?' : '¿A qué hora le queda bien?',
          groups: [`${this.int(1, 12)}${String(this.pick([0, 15, 30, 45])).padStart(2, '0')}`],
        };
      case 'serial':
        return { ask: en ? 'And the serial number?' : '¿Y el número de serie?', groups: [this.digits(4, true), this.digits(4, true)] };
      case 'house':
        return { ask: en ? "What's the street number?" : '¿Cuál es el número de la casa?', groups: [this.digits(this.pick([3, 4, 4, 5]))] };
      case 'zip':
        return { ask: en ? 'And the zip code?' : '¿Y el código postal?', groups: [this.digits(5, true)] };
      case 'price':
        return { ask: en ? 'What did they quote you?' : '¿Cuánto le cotizaron?', groups: [String(this.int(100, 9999))] };
      case 'model':
        return { ask: en ? "What's the model number on the unit?" : '¿Cuál es el número de modelo?', groups: [this.digits(this.int(4, 8), true)] };
      case 'invoice':
        return { ask: en ? "What's the invoice number?" : '¿Cuál es el número de factura?', groups: [this.digits(this.int(6, 8), true)] };
    }
  }

  /**
   * A call leg of bare answers (the stored rows): the agent asks for a gate
   * or lockbox code, a last-four, a PIN, a year, a time, a serial number read
   * in fours, a house number, a zip, a price, a model or invoice number, and
   * the caller answers three to six of them with the number alone, each in a
   * turn of its own, seconds apart. No talk of cards or paying ('none'), or
   * the agent saying it takes cards at the visit right before the first
   * answer ('agent-card').
   */
  qaLeg(talk: 'none' | 'agent-card'): CallLine[] {
    const lang: Lang = this.chance(0.3) ? 'es' : 'en';
    const style = this.pick(['written', 'written', 'written', 'words', 'pairs'] as const);
    const lines: CallLine[] = [];
    let at = 5_000_000;
    const say = (speaker: 'caller' | 'agent', text: string): void => {
      lines.push({ speaker, text, at });
      at += this.int(2, 6) * 1000;
    };
    say('agent', lang === 'en' ? 'How can I help?' : '¿En qué le ayudo?');
    say('caller', this.smallTalk(lang));
    const answers = this.int(3, 6);
    for (let k = 0; k < answers; k++) {
      const { ask, groups } = this.bareAnswer(lang);
      const card =
        talk === 'agent-card' && k === 0
          ? lang === 'en'
            ? 'We take all major credit cards at the visit. '
            : 'Aceptamos tarjetas de crédito en la visita. '
          : '';
      say('agent', `${card}${ask}`);
      const lead = this.pick(lang === 'en' ? ['', '', '', 'okay, ', 'um, ', "it's ", 'yes, ', 'sure, '] : ['', '', 'sí, ', 'este, ', 'es el ']);
      const end = this.pick(lang === 'en' ? ['', '', '.', ' thanks'] : ['', '.', ' gracias']);
      say('caller', `${lead}${this.sayGroups(groups, style, lang)}${end}`);
    }
    return lines;
  }

  // ── Cards, with the card mentioned near them ───────────────────────────

  /** A Luhn-valid card number as a network issues it, and its natural groups. */
  card(): { number: string; groups: number[] } {
    const kind = this.pick(['visa', 'visa', 'mastercard', 'mastercard2', 'amex', 'discover', 'diners', 'diners30', 'jcb', 'visa19'] as const);
    const make = (prefix: string, length: number): string =>
      withLuhnCheckDigit(prefix + this.digits(length - prefix.length - 1, true));
    switch (kind) {
      case 'visa':
        return { number: make('4', 16), groups: [4, 4, 4, 4] };
      case 'mastercard':
        return { number: make(`5${this.int(1, 5)}`, 16), groups: [4, 4, 4, 4] };
      case 'mastercard2':
        return { number: make(String(this.int(2221, 2720)), 16), groups: [4, 4, 4, 4] };
      case 'amex':
        return { number: make(this.pick(['34', '37']), 15), groups: [4, 6, 5] };
      case 'discover':
        return { number: make('6011', 16), groups: [4, 4, 4, 4] };
      case 'diners':
        return { number: make('36', 14), groups: [4, 6, 4] };
      case 'diners30':
        // Diners Club International's other ranges, issued at 14 too.
        return { number: make(this.pick(['300', '301', '302', '303', '304', '305', '3095', '38', '39']), 14), groups: [4, 6, 4] };
      case 'jcb':
        return { number: make(String(this.int(3528, 3589)), 16), groups: [4, 4, 4, 4] };
      case 'visa19':
        return { number: make('4', 19), groups: [4, 4, 4, 4, 3] };
    }
  }

  /** `number` cut into `groups`. */
  static split(number: string, groups: readonly number[]): string[] {
    const out: string[] = [];
    groups.reduce((at, size) => (out.push(number.slice(at, at + size)), at + size), 0);
    return out;
  }

  /**
   * A card's groups as a caller reads them: written with the space or dash
   * STT writes, or said with a pause between groups (a comma, "and"); read
   * digit by digit, a caller may also not pause at all.
   */
  sayCard(groups: readonly string[], style: Style, lang: Lang, mayRunOn = true): string {
    const said = groups.map((g) => this.sayGroup(g, style, lang));
    if (style === 'written') return said.join(this.pick([' ', ' ', '-']));
    if (style === 'words' && mayRunOn && this.chance(0.25)) return said.join(' ');
    return said.reduce((out, g, k) => (k === 0 ? g : `${out}${this.pick([', ', ', ', lang === 'es' ? ', y ' : ', and '])}${g}`), '');
  }

  /**
   * One utterance reading a card with the card mentioned near it ("my card
   * is …", "… that's my Visa"), written, as words or in pairs, sometimes with
   * the CVV or the expiry run straight on. Returns the text and the card.
   */
  cardUtterance(): { text: string; card: string; tail: number; unbroken: boolean } {
    const lang: Lang = this.chance(0.3) ? 'es' : 'en';
    const { number, groups } = this.card();
    const style = this.style();
    let said = this.sayCard(CardNumberCorpus.split(number, groups), style, lang);
    // Read digit by digit with no pause between its groups (`sayCard` puts a
    // comma at every pause).
    const unbroken = style === 'words' && !said.includes(',');
    let tail = '';
    if (style === 'words' && this.chance(0.4)) {
      // Read digit by digit, the CVV or the expiry said straight after it,
      // no pause (read in pairs, a ten then a unit word is ambiguous: "sixty
      // one" is 61 or 60 and 1).
      tail = this.chance(0.5) ? this.digits(number.length === 15 ? 4 : 3, true) : `${String(this.int(1, 12)).padStart(2, '0')}${this.int(26, 31)}`;
      said += ` ${this.sayGroup(tail, 'words', lang)}`;
    }
    const before = this.pick(
      lang === 'en'
        ? ['my card number is ', "it's my Visa, ", 'the credit card is ', 'card number ', 'my card is uh let me find it okay it is ']
        : ['mi tarjeta es ', 'el número de tarjeta es ', 'mi tarjeta de crédito es '],
    );
    const after = this.pick(lang === 'en' ? ['', '', ' thanks', " that's the card"] : ['', ' gracias']);
    return { text: `${before}${said}${after}`, card: number, tail: tail.length, unbroken };
  }

  /**
   * A card read over several caller turns in the groups a caller reads it in,
   * the card mentioned in one of its turns, the caller's turn before it, or by
   * the agent right before it; with the agent's "go on" between turns.
   */
  cardOverTurns(): { lines: CallLine[]; card: string } {
    const lang: Lang = this.chance(0.3) ? 'es' : 'en';
    const { number, groups } = this.card();
    const splits: ReadonlyArray<readonly number[]> =
      number.length === 15
        ? [[4, 6, 5], [10, 5], [4, 11]]
        : number.length === 14
          ? [[4, 6, 4], [10, 4], [4, 10]]
          : number.length === 19
            ? [[4, 4, 4, 4, 3], [8, 8, 3], [8, 4, 7]]
            : [[4, 4, 4, 4], [8, 8], [4, 4, 8], [12, 4], [4, 12]];
    const split = this.pick(splits);
    const style = this.pick(['written', 'written', 'words'] as const);
    // The card's own groups, cut where the caller pauses for a turn.
    const bounds = new Set<number>();
    for (const sizes of [groups, split]) sizes.reduce((at, size) => (bounds.add(at + size), at + size), 0);
    const pieces = CardNumberCorpus.split(
      number,
      [...bounds].sort((a, b) => a - b).map((end, k, all) => end - (k === 0 ? 0 : all[k - 1])),
    );
    const turnEnds = new Set<number>();
    split.reduce((at, size) => (turnEnds.add(at + size), at + size), 0);
    const turns: string[][] = [[]];
    let at0 = 0;
    for (const piece of pieces) {
      turns[turns.length - 1].push(piece);
      at0 += piece.length;
      if (turnEnds.has(at0) && at0 < number.length) turns.push([]);
    }
    const lines: CallLine[] = [];
    let at = 2_000_000;
    const say = (speaker: 'caller' | 'agent', text: string): void => {
      lines.push({ speaker, text, at });
      at += this.int(2, 5) * 1000;
    };
    const where = this.pick(['first-turn', 'turn-before', 'agent-before', 'turn-before-pause', 'agent-before-pause'] as const);
    say('agent', 'How would you like to pay?');
    if (where === 'turn-before' || where === 'turn-before-pause') say('caller', this.cardTalk(lang));
    if (where === 'agent-before' || where === 'agent-before-pause') say('agent', "Sorry, I can't take card numbers over the phone.");
    // A turn of nothing but a pause between the mention and the card ("okay").
    if (where.endsWith('-pause')) say('caller', this.pick(lang === 'en' ? ['okay', 'um', 'sure', 'mm-hmm', 'okay, so'] : ['sí', 'vale', 'este', 'bueno']));
    turns.forEach((inner, k) => {
      const lead = k === 0 && where === 'first-turn' ? (lang === 'en' ? 'my card is ' : 'mi tarjeta es ') : k > 0 ? this.pick(['', '', 'okay, ', 'um, ']) : '';
      // A turn of ten digit words with no pause (eleven starting 1) is a
      // phone number, which the cross-turn search never takes in: an Amex's
      // or a Diners Club's 4-6 and 6-5 are read with their pause.
      const length = inner.join('').length;
      say('caller', `${lead}${this.sayCard(inner, style, lang, length !== 10 && length !== 11)}`);
      if (k < turns.length - 1 && this.chance(0.5)) say('agent', this.pick(['Go on.', 'Okay.', 'Mm-hmm.']));
    });
    return { lines, card: number };
  }
}
