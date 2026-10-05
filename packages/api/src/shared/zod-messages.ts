/**
 * #1561 — zod 4 kept the zod 3 issue wording for every message a client sees.
 *
 * zod 4 rewrote its default issue messages ("Required" became "Invalid input:
 * expected string, received undefined", "Invalid uuid" became "Invalid GUID",
 * …). Those strings are not internal: they reach the operator verbatim through
 * the API 400 body (`details.fields`, rendered by web `formatApiErrorMessage`),
 * `validate()`'s `details.issues`, and the `"<path>: <message>"` errors that
 * `validateProposalPayload` hands the review card and the voice gate.
 *
 * This error map reproduces the zod 3 English wording for the issue kinds the
 * contracts actually raise, installed once as zod's global `customError`. A
 * schema- or check-level message (`.min(1, 'Required')`, `.refine(fn, msg)`)
 * still wins — zod consults the global map only when none was given — and any
 * issue kind not listed here falls through to zod 4's own default.
 *
 * zod 4 keeps its global config on `globalThis`, so installing it here also
 * covers schemas built by `@ai-service-os/shared`'s copy of zod.
 */
import { z } from 'zod';

type RawIssue = Parameters<z.core.$ZodErrorMap>[0];

/** zod 3's `getParsedType` vocabulary for the `received` half of a type issue. */
function v3ParsedType(input: unknown): string {
  if (input === undefined) return 'undefined';
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  if (input instanceof Date) return 'date';
  if (input instanceof Map) return 'map';
  if (input instanceof Set) return 'set';
  if (typeof input === 'number') return Number.isNaN(input) ? 'nan' : 'number';
  if (typeof input === 'object') {
    return typeof (input as { then?: unknown }).then === 'function' ? 'promise' : 'object';
  }
  return typeof input; // string | boolean | bigint | symbol | function
}

function quoteOption(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

function schemaType(issue: RawIssue): string | undefined {
  const schema = issue.inst ?? issue.schema;
  return (schema as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
}

const STRING_FORMAT_NAMES: Record<string, string> = {
  // Contracts validate ids with `z.guid()` (zod 3's `.uuid()` accept set);
  // both spell the zod 3 message.
  guid: 'uuid',
  uuid: 'uuid',
};

function bound(
  kind: 'small' | 'big',
  origin: string,
  limit: number | bigint,
  inclusive: boolean | undefined,
  exact: boolean | undefined,
): string | undefined {
  if (origin === 'string') {
    const q = exact ? 'exactly' : kind === 'small' ? (inclusive ? 'at least' : 'over') : inclusive ? 'at most' : 'under';
    return `String must contain ${q} ${limit} character(s)`;
  }
  if (origin === 'array' || origin === 'set') {
    const q = exact ? 'exactly' : kind === 'small' ? (inclusive ? 'at least' : 'more than') : inclusive ? 'at most' : 'less than';
    return `${origin === 'array' ? 'Array' : 'Set'} must contain ${q} ${limit} element(s)`;
  }
  if (origin === 'number' || origin === 'int' || origin === 'bigint') {
    const q = exact
      ? 'exactly equal to '
      : kind === 'small'
        ? inclusive ? 'greater than or equal to ' : 'greater than '
        : inclusive ? 'less than or equal to ' : 'less than ';
    return `${origin === 'bigint' ? 'BigInt' : 'Number'} must be ${q}${limit}`;
  }
  if (origin === 'date') {
    const q = exact
      ? 'exactly equal to '
      : kind === 'small'
        ? inclusive ? 'greater than or equal to ' : 'greater than '
        : inclusive ? 'smaller than or equal to ' : 'smaller than ';
    return `Date must be ${q}${new Date(Number(limit))}`;
  }
  return undefined;
}

/** The zod 3 wording for `issue`, or `undefined` to defer to zod 4's default. */
export function zod3CompatibleMessage(issue: RawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      const { expected, input } = issue;
      if (input === undefined) return 'Required';
      if (expected === 'int') {
        return typeof input === 'number' && !Number.isNaN(input)
          ? 'Expected integer, received float'
          : `Expected number, received ${v3ParsedType(input)}`;
      }
      if (expected === 'date' && input instanceof Date) return 'Invalid date';
      return `Expected ${expected}, received ${v3ParsedType(input)}`;
    }
    case 'invalid_value': {
      if (schemaType(issue) === 'literal' && issue.values.length === 1) {
        return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      }
      return `Invalid enum value. Expected ${issue.values.map(quoteOption).join(' | ')}, received ${quoteOption(issue.input)}`;
    }
    case 'too_small':
      return bound('small', issue.origin, issue.minimum, issue.inclusive, issue.exact);
    case 'too_big':
      return bound('big', issue.origin, issue.maximum, issue.inclusive, issue.exact);
    case 'invalid_format': {
      const fmt = issue as RawIssue & { format: string; prefix?: string; suffix?: string; includes?: string };
      if (fmt.format === 'regex') return 'Invalid';
      if (fmt.format === 'starts_with') return `Invalid input: must start with "${fmt.prefix}"`;
      if (fmt.format === 'ends_with') return `Invalid input: must end with "${fmt.suffix}"`;
      if (fmt.format === 'includes') return `Invalid input: must include "${fmt.includes}"`;
      return `Invalid ${STRING_FORMAT_NAMES[fmt.format] ?? fmt.format}`;
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${issue.keys.map((k) => `'${k}'`).join(', ')}`;
    default:
      return undefined;
  }
}

z.config({ customError: zod3CompatibleMessage });
