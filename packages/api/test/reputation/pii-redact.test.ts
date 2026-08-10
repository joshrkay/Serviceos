import { describe, it, expect } from 'vitest';
import { redactPii } from '../../src/reputation/pii-redact';

describe('P7-026 redactPii — emails', () => {
  it('redacts a simple email', () => {
    expect(redactPii('Contact me at foo@example.com please')).toBe(
      'Contact me at [email] please',
    );
  });

  it('redacts multiple emails in one string', () => {
    expect(redactPii('foo@a.com or bar.baz+tag@sub.example.co')).toBe(
      '[email] or [email]',
    );
  });

  it('respects redactEmails=false', () => {
    expect(redactPii('foo@example.com', { redactEmails: false })).toBe(
      'foo@example.com',
    );
  });
});

describe('P7-026 redactPii — phones', () => {
  it('redacts a US phone in (xxx) xxx-xxxx format', () => {
    expect(redactPii('Call me at (415) 555-1234 anytime')).toBe(
      'Call me at [phone] anytime',
    );
  });

  it('redacts a US phone in xxx-xxx-xxxx format', () => {
    expect(redactPii('My number is 415-555-1234.')).toBe('My number is [phone].');
  });

  it('redacts a US phone with country code', () => {
    expect(redactPii('+1 415 555 1234 works')).toBe('[phone] works');
  });

  it('redacts an international phone', () => {
    expect(redactPii('Call +442071234567 from London')).toBe(
      'Call [phone] from London',
    );
  });

  it('respects redactPhones=false', () => {
    expect(redactPii('(415) 555-1234', { redactPhones: false })).toBe(
      '(415) 555-1234',
    );
  });
});

describe('P7-026 redactPii — addresses', () => {
  it('redacts a US street address (Street)', () => {
    expect(redactPii('I live at 123 Main Street')).toBe('I live at [address]');
  });

  it('redacts a US street address (Ave with multi-word name)', () => {
    expect(redactPii('Located at 456 North Park Ave today')).toBe(
      'Located at [address] today',
    );
  });

  it('redacts a US street address (Boulevard)', () => {
    expect(redactPii('Drove down 789 Sunset Boulevard')).toBe(
      'Drove down [address]',
    );
  });

  it('respects redactAddresses=false', () => {
    expect(redactPii('123 Main Street', { redactAddresses: false })).toBe(
      '123 Main Street',
    );
  });

  it('does not redact a numbered list item', () => {
    // "1." is not a street address — has no street-type suffix.
    expect(redactPii('1. Buy milk')).toBe('1. Buy milk');
  });
});

describe('P7-026 redactPii — last names', () => {
  it('redacts last name after a salutation (Mr.)', () => {
    expect(redactPii('I spoke to Mr. Smith yesterday')).toBe(
      'I spoke to Mr. [name] yesterday',
    );
  });

  it('redacts last name after a salutation without period (Ms)', () => {
    expect(redactPii('Ms Johnson was helpful')).toBe('Ms [name] was helpful');
  });

  it('redacts last name when preceded by a known first name', () => {
    expect(redactPii('Bob Smith was my tech')).toBe(
      'Bob [name] was my tech',
    );
  });

  it('preserves an unknown first name + last name (no overreach)', () => {
    // "Xyzzy" is not a known first name → don't guess.
    expect(redactPii('Xyzzy Plover was here')).toBe('Xyzzy Plover was here');
  });

  it('redacts last name when caller provides extra first-name allowlist', () => {
    expect(
      redactPii('Xyzzy Smith was here', {
        preserveKnownFirstNames: ['Xyzzy'],
      }),
    ).toBe('Xyzzy [name] was here');
  });

  it('respects redactLastNames=false', () => {
    expect(redactPii('Bob Smith', { redactLastNames: false })).toBe(
      'Bob Smith',
    );
  });
});

describe('P7-026 redactPii — idempotency', () => {
  it('is a no-op on already-redacted text (emails)', () => {
    const once = redactPii('Email me at foo@bar.com today');
    const twice = redactPii(once);
    expect(twice).toBe(once);
  });

  it('is a no-op on already-redacted text (phones)', () => {
    const once = redactPii('Call (415) 555-1234');
    const twice = redactPii(once);
    expect(twice).toBe(once);
  });

  it('is a no-op on already-redacted text (mixed PII)', () => {
    const input =
      'Mr. Smith at 123 Main Street, call (415) 555-1234 or foo@bar.com';
    const once = redactPii(input);
    const twice = redactPii(once);
    const thrice = redactPii(twice);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });
});

describe('P7-026 redactPii — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(redactPii('')).toBe('');
  });

  it('passes through text with no PII unchanged', () => {
    expect(redactPii('Great service overall')).toBe('Great service overall');
  });
});

/**
 * Review K1/J2 (followup-review-remnants) — two behaviours this module gained
 * when `redactedExecutionErrorCause` (proposals/proposal.ts) stopped carrying
 * its own drifted copy of these regexes and started calling in here.
 */
describe('P7-026 redactPii — email boundary and phone strictness', () => {
  it('redacts an email immediately followed by a word character', () => {
    // The rule used to end in `\b`, so an email abutting a digit run never
    // matched AT ALL — the shape a Postgres `DETAIL: Key (contact)=(…)` over
    // a concatenated column produces.
    expect(redactPii('Key (contact)=(jane.doe@example.com4155552671)')).toBe(
      'Key (contact)=([email][phone])',
    );
    expect(redactPii('sent to jane.doe@example.com2026-08-09T12:00:00Z')).toContain('[email]');
    expect(redactPii('sent to jane.doe@example.com2026-08-09T12:00:00Z')).not.toContain(
      'jane.doe@example.com',
    );
  });

  it('still redacts a bare digit-run phone by default', () => {
    expect(redactPii('call 4155552671')).toBe('call [phone]');
  });

  it('requireSeparatedPhones leaves a bare digit run alone', () => {
    expect(
      redactPii('amount 1234567890 exceeds int4 range 2147483647', {
        requireSeparatedPhones: true,
        redactAddresses: false,
        redactLastNames: false,
      }),
    ).toBe('amount 1234567890 exceeds int4 range 2147483647');
  });

  it('requireSeparatedPhones still redacts a separated or parenthesised number', () => {
    const opts = { requireSeparatedPhones: true } as const;
    expect(redactPii('call 415-555-2671', opts)).toBe('call [phone]');
    expect(redactPii('call (415) 555-2671', opts)).toBe('call [phone]');
    expect(redactPii('call +1 415.555.2671', opts)).toBe('call [phone]');
    expect(redactPii('call +442071234567', opts)).toBe('call [phone]');
  });

  it('requireSeparatedPhones is still idempotent', () => {
    const opts = { requireSeparatedPhones: true } as const;
    const once = redactPii('call 415-555-2671 about 1234567890', opts);
    expect(redactPii(once, opts)).toBe(once);
  });
});

/**
 * The email pass is no longer a single `String.replace(regex, …)` — it is a
 * hand-written linear scanner (`replaceEmails`), because the regex it replaces
 * backtracked quadratically (see the ReDoS block below).
 *
 * A hand-written scanner under a PII control is only acceptable if it provably
 * matches what it replaced, so the ORIGINAL regex is restated here and the two
 * are compared over a generated corpus. This is the test that actually earns
 * the rewrite; the examples above only cover shapes someone thought of.
 *
 * Two earlier attempts at this fix passed every hand-written test in this file
 * and were caught only here:
 *   1. `(?<![A-Za-z0-9._%+-])` in place of `\b` — dropped the second of two
 *      abutting emails (`jane.doe@example.comcoma_b+c@sub.domain.co.uk`),
 *      because after the first match the residual run is still preceded by a
 *      local-part character in the original string. ~2300 leaks per 500k.
 *   2. The same, plus a sticky retry at the resume point — still dropped 208
 *      spans per 300k, because the extra start positions let an earlier weak
 *      match (`..@jane.doe`) preempt the real email behind it.
 * Both were LESS redaction, which is the direction that must never ship.
 */
describe('P7-026 redactPii — email scanner matches the regex it replaced', () => {
  /** The exact pattern `replaceEmails` reimplements. Do not "tidy" this. */
  const ORIGINAL_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  /** Deterministic PRNG (mulberry32) so a failure is reproducible by seed. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const ALPHABETS: Record<string, readonly string[]> = {
    // Abutting PII fragments — the shape a Postgres `DETAIL: Key (contact)=(…)`
    // over a concatenated column produces, and the one both failed attempts
    // leaked on.
    abutting: [
      'jane.doe@example.com', 'a_b+c@sub.domain.co.uk', 'x@y.io', 'foo@bar.com',
      '.', '..', '...', '-', '+', '%', '_', '@', ' ', '', '(', ')', '[', ']',
      ':', '/', '<', '>', '=', '&', ',', ';', '"', '\n', '\t',
      'abc', 'Z9', 'com', 'co', 'attached', 'mailto', 'DETAIL', '4155552671',
      '[email]', '[phone]', '[name]', '[address]', '[redacted]',
      'a.b', 'b.c.d', 'x-y', 'p%q', 'n+m',
    ],
    // Dense local-class punctuation — maximises the number of positions at
    // which `\b` can fire inside a single token.
    soup: ['a', '.', '@', '-', '+', '%', '_', '0', 'Z', 'co', 'com', ' '],
    // Email-shaped pieces assembled from parts, so near-misses are common.
    parts: ['user', '.', 'name', '@', 'host', '.', 'com', 'io', 'co', 'uk',
      ' ', '-', '+', '%', '1', '_'],
  };

  it.each(Object.keys(ALPHABETS))(
    'produces byte-identical output to the original regex (%s corpus)',
    (name) => {
      const alphabet = ALPHABETS[name]!;
      let withMatches = 0;
      for (let seed = 0; seed < 20_000; seed++) {
        const rand = rng(seed);
        const n = 1 + Math.floor(rand() * 12);
        let input = '';
        for (let i = 0; i < n; i++) {
          input += alphabet[Math.floor(rand() * alphabet.length)]!;
        }
        ORIGINAL_EMAIL_RE.lastIndex = 0;
        const expected = input.replace(ORIGINAL_EMAIL_RE, '[email]');
        if (expected !== input) withMatches++;
        // Email pass only — the other passes would rewrite the same spans.
        const actual = redactPii(input, {
          redactPhones: false,
          redactAddresses: false,
          redactLastNames: false,
        });
        expect(actual, `seed ${seed}: ${JSON.stringify(input)}`).toBe(expected);
      }
      // Guard against a corpus that generates nothing interesting.
      expect(withMatches).toBeGreaterThan(0);
    },
  );

  it('handles the shapes the two failed attempts leaked on', () => {
    const cases = [
      'jane.doe@example.comcoma_b+c@sub.domain.co.uk',
      '/[[name];..@jane.doe@example.com',
      'jane.doe@example.comcoco>+@jane.doe@example.com&',
      'x@y.io4155552671x@y.iofoo@bar.comx-yco',
      '> .@jane.doe@example.com_  +',
      '=[address]%+@jane.doe@example.com@jane.doe@example.com[]',
    ];
    for (const input of cases) {
      ORIGINAL_EMAIL_RE.lastIndex = 0;
      expect(
        redactPii(input, {
          redactPhones: false,
          redactAddresses: false,
          redactLastNames: false,
        }),
        input,
      ).toBe(input.replace(ORIGINAL_EMAIL_RE, '[email]'));
    }
  });
});

/**
 * ReDoS. `redactPii` runs on the reputation path over text this service does
 * NOT length-bound: `review.commentText` (authored by whoever left the Google
 * review) and the LLM's completion, at draft-public-response.ts:98/121 and
 * draft-private-followup.ts:104/131. Those run in-process with Express
 * (app.ts), so a quadratic pattern there stalls the whole API, not one
 * request.
 *
 * `redactedExecutionErrorCause` (proposals/proposal.ts) is the one caller that
 * is already safe — it slices to MAX_CAUSE_SCAN_LENGTH before calling in. It
 * has its own copy of this budget test; the bound below matches it.
 *
 * The budget is deliberately loose. Every shape here is sub-millisecond once
 * the patterns are linear, and the defect being guarded produced seconds, so
 * 250ms separates them by three orders of magnitude in both directions and
 * cannot be tripped by CI scheduling noise.
 */
describe('P7-026 redactPii — pathological input is not quadratic', () => {
  const BUDGET_MS = 250;

  /** Time one `redactPii` call, in ms. */
  const timed = (text: string, options?: Parameters<typeof redactPii>[1]) => {
    const started = Date.now();
    const out = redactPii(text, options);
    return { out, elapsedMs: Date.now() - started };
  };

  /**
   * The reported shape. The local-part class `[A-Za-z0-9._%+-]` contains `.`,
   * so an `a.a.a.…` run offers a viable match start at EVERY character; the
   * domain run then gets rescanned from each one. 64KB of it took ~2.5s before
   * the start-anchor fix, and the cost is a clean 4x per doubling.
   */
  it('redacts a 64KB local-part/domain backtracking bomb within budget', () => {
    const n = 32_000;
    const input = `${'a.'.repeat(n / 2)}@${'b'.repeat(n)}`;
    const { elapsedMs } = timed(input);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('is within budget on the same bomb with requireSeparatedPhones', () => {
    // proposals/proposal.ts's option set — a different phone pattern runs.
    const n = 32_000;
    const input = `${'a.'.repeat(n / 2)}@${'b'.repeat(n)}`;
    const { elapsedMs } = timed(input, {
      redactAddresses: false,
      redactLastNames: false,
      requireSeparatedPhones: true,
    });
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  /**
   * Speed is worthless if it were bought by matching less. A real email buried
   * in the bomb must still be redacted, and the result must still be a fixed
   * point.
   */
  it('still redacts a real email embedded in the bomb, and stays idempotent', () => {
    const n = 16_000;
    const input = `${'a.'.repeat(n / 2)} jane.doe@example.com @${'b'.repeat(n)}`;
    const { out, elapsedMs } = timed(input);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).toContain('[email]');
    expect(redactPii(out)).toBe(out);
  });

  /**
   * The email rule is the one that was quadratic, but it is not the only
   * pattern in the module with adjacent or nested quantifiers. Each shape
   * below targets one of them: the `\s+`/`[a-z]+` seam in ADDRESS_RE's nested
   * `(?:\s+[A-Z][a-z]+)*`, the optional-separator runs in both phone rules,
   * the bounded repeat in INTL_PHONE_RE, and the two capitalized-word rules.
   * All were measured linear before this commit and are pinned here so a
   * future edit to any of them cannot quietly reintroduce the class.
   */
  const ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
    ['email: C-run + @ + D-run', `${'a.'.repeat(16_000)}@${'b'.repeat(32_000)}`],
    ['email: alternating a@ then D-run', `${'a@'.repeat(16_000)}${'b'.repeat(32_000)}`],
    ['email: C-run with no @ at all', 'a.'.repeat(32_000)],
    ['email: @ then all-dot domain run', `a@${'.'.repeat(64_000)}`],
    ['email: @ then dotted domain run', `a@${'b.'.repeat(32_000)}`],
    ['email: %/+ in the local-part run', `${'a+%'.repeat(16_000)}@${'b'.repeat(32_000)}`],
    ['phone: bare digit run', '1'.repeat(64_000)],
    ['phone: near-miss 999-999-99 run', '999-999-99 '.repeat(6_000)],
    ['phone: separator-heavy near miss', '111-111-111 '.repeat(5_000)],
    ['phone: + then digit run', `+${'1'.repeat(64_000)}`],
    ['phone: run of + signs', '+'.repeat(64_000)],
    ['address: digits then capitalized words', `1 ${'Aa '.repeat(21_000)}`],
    ['address: digits then whitespace run', `1${' '.repeat(64_000)}`],
    ['address: many digit starts', '1 Aa '.repeat(13_000)],
    ['address: capitalized words then street-type near miss', `1 ${'Aa '.repeat(21_000)}Sx`],
    ['address: multi-space gaps between words', `1${'  Aa'.repeat(16_000)}`],
    ['name: salutation then whitespace run', `Dr${' '.repeat(64_000)}`],
    ['name: capitalized-word run', 'Aa '.repeat(21_000)],
    ['name: capitalized word then whitespace run', `Aa${' '.repeat(64_000)}`],
  ];

  it.each(ADVERSARIAL)('stays within budget: %s', (_label, input) => {
    expect(timed(input).elapsedMs).toBeLessThan(BUDGET_MS);
    // The same shapes under the diagnostics option set, which swaps in
    // US_PHONE_SEPARATED_RE and skips the address/name passes.
    expect(
      timed(input, {
        redactAddresses: false,
        redactLastNames: false,
        requireSeparatedPhones: true,
      }).elapsedMs,
    ).toBeLessThan(BUDGET_MS);
  });
});
