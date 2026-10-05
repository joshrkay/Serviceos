/**
 * #1561 — parity: with the global error map installed, zod 4 issue messages
 * match what real zod 3 (the `zod/v3` build zod 4 still ships) says for the
 * same schema and input. zod 3 is the independent source of truth here — the
 * expected messages are never written out by hand or recomputed like the map.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import '../../src/shared/zod-messages';

type Case = {
  name: string;
  v3: () => z3.ZodTypeAny;
  v4: () => z.ZodType;
  input: unknown;
};

const both = (name: string, build: (zz: typeof z) => unknown, input: unknown): Case => ({
  name,
  v3: () => build(z3 as unknown as typeof z) as z3.ZodTypeAny,
  v4: () => build(z) as z.ZodType,
  input,
});

const cases: Case[] = [
  both('missing required string', (zz) => zz.object({ a: zz.string() }), {}),
  both('wrong primitive type', (zz) => zz.object({ a: zz.boolean() }), { a: 'yes' }),
  both('null where object expected', (zz) => zz.object({ a: zz.object({}) }), { a: null }),
  both('array where string expected', (zz) => zz.string(), ['x']),
  both('NaN where number expected', (zz) => zz.number(), Number.NaN),
  both('float where integer expected', (zz) => zz.number().int(), 1.5),
  both('string where integer expected', (zz) => zz.number().int(), '1'),
  both('string too short', (zz) => zz.string().min(3), 'ab'),
  both('string too long', (zz) => zz.string().max(2), 'abc'),
  both('string exact length', (zz) => zz.string().length(2), 'abc'),
  both('empty array', (zz) => zz.array(zz.string()).min(1), []),
  both('array too long', (zz) => zz.array(zz.string()).max(1), ['a', 'b']),
  both('number not positive', (zz) => zz.number().positive(), 0),
  both('number negative', (zz) => zz.number().nonnegative(), -1),
  both('number too big', (zz) => zz.number().max(10), 11),
  both('number not below', (zz) => zz.number().lt(10), 10),
  both('enum miss', (zz) => zz.enum(['a', 'b']), 'c'),
  both('literal miss', (zz) => zz.literal('on'), 'off'),
  both('email', (zz) => zz.string().email(), 'nope'),
  both('url', (zz) => zz.string().url(), 'not a url'),
  both('datetime', (zz) => zz.string().datetime(), '2026-13-01'),
  both('regex', (zz) => zz.string().regex(/^\d+$/), 'abc'),
  both('startsWith', (zz) => zz.string().startsWith('+1'), '44'),
  both('multipleOf', (zz) => zz.number().multipleOf(5), 7),
  both('strict unknown keys', (zz) => zz.object({ a: zz.string() }).strict(), { a: 'x', b: 1, c: 2 }),
  both('explicit message wins', (zz) => zz.string().min(1, 'Name is required'), ''),
  {
    name: 'uuid (zod 3 .uuid() ≡ zod 4 z.guid())',
    v3: () => z3.string().uuid(),
    v4: () => z.guid(),
    input: 'job-1',
  },
];

describe('#1561 — zod 4 messages keep the zod 3 wording', () => {
  it.each(cases)('$name', ({ v3, v4, input }) => {
    const r3 = v3().safeParse(input);
    const r4 = v4().safeParse(input);
    expect(r3.success).toBe(false);
    expect(r4.success).toBe(false);
    const m3 = r3.success ? [] : r3.error.issues.map((i) => i.message);
    const m4 = r4.success ? [] : r4.error.issues.map((i) => i.message);
    expect(m4).toEqual(m3);
  });
});
