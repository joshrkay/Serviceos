/**
 * `ai/orchestration/lookup-reference.ts` — the free-text → verified-id helper
 * every lookup surface shares (chat, in-app voice, live phone).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * With two customers named Smith on file, the "which one?" question was
 * `More than one match for "Smith": Smith; Smith. Which one did you mean?` —
 * a question with no answerable difference in it, spoken to an operator who
 * then has to abandon the turn. `EntityCandidate.hint` already carried what
 * tells them apart (the customer's phone/address, a job's assigned tech, an
 * invoice's status) and every resolver populates it; the line just never
 * rendered it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ambiguousReferenceLine,
  resolveLookupReference,
} from '../../../src/ai/orchestration/lookup-reference';
import type { EntityCandidate, EntityResolver } from '../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-lookup-reference';

function customer(id: string, label: string, hint?: string): EntityCandidate {
  return { id, kind: 'customer', label, score: 0.85, ...(hint ? { hint } : {}) };
}

describe('ambiguousReferenceLine — the question has to be answerable', () => {
  it('renders each candidate as "label (hint)" so same-named records differ', () => {
    const line = ambiguousReferenceLine('Smith', [
      customer('c-1', 'Smith', '104 QA Cedar Avenue'),
      customer('c-2', 'Smith', '77 Mill Road'),
    ]);

    expect(line).toBe(
      'More than one match for "Smith": Smith (104 QA Cedar Avenue); Smith (77 Mill Road). ' +
        'Which one did you mean?',
    );
  });

  it('falls back to the bare label when a candidate has no hint', () => {
    const line = ambiguousReferenceLine('Smith', [
      customer('c-1', 'Alice Smith'),
      customer('c-2', 'Bob Smith', '555-0100'),
    ]);

    expect(line).toContain('Alice Smith; Bob Smith (555-0100)');
  });

  it('collapses candidates that render identically — repeating them helps nobody', () => {
    const line = ambiguousReferenceLine('Smith', [
      customer('c-1', 'Smith'),
      customer('c-2', 'Smith'),
    ]);

    expect(line).toBe('More than one match for "Smith": Smith. Which one did you mean?');
  });

  it('keeps same-label candidates that a hint DOES tell apart', () => {
    const line = ambiguousReferenceLine('Smith', [
      customer('c-1', 'Smith', '555-0100'),
      customer('c-2', 'Smith', '555-0200'),
    ]);

    expect(line).toContain('Smith (555-0100); Smith (555-0200)');
  });

  it('lists at most five DISTINCT options — a duplicate no longer eats a slot', () => {
    const line = ambiguousReferenceLine('Smith', [
      customer('c-0', 'Smith'),
      customer('c-1', 'Smith'),
      ...Array.from({ length: 6 }, (_, i) => customer(`c-${i + 2}`, `Smith ${i + 1}`)),
    ]);

    // Five DISTINCT options: the duplicate "Smith" collapses instead of
    // spending one of the five slots on a repeat.
    const listed = line
      .slice(line.indexOf(': ') + 2, line.indexOf('. Which one'))
      .split('; ');
    expect(listed).toHaveLength(5);
    expect(listed[0]).toBe('Smith');
    expect(listed[1]).toBe('Smith 1');
    expect(listed[4]).toBe('Smith 4');
  });

  it('treats a blank hint as no hint (never speaks empty parentheses)', () => {
    const line = ambiguousReferenceLine('Smith', [customer('c-1', 'Smith', '   ')]);
    expect(line).toContain(': Smith.');
    expect(line).not.toContain('()');
  });
});

describe('resolveLookupReference — carries the matched record label', () => {
  function resolverReturning(result: unknown): EntityResolver {
    return { resolve: vi.fn(async () => result) } as unknown as EntityResolver;
  }

  it('threads the candidate label alongside the id (a spoken surface has to name the record)', async () => {
    const resolved = await resolveLookupReference(
      resolverReturning({ kind: 'resolved', candidate: customer('c-1', 'Khan Household') }),
      TENANT,
      'Khan',
      'customer',
    );

    expect(resolved).toEqual({ kind: 'resolved', id: 'c-1', label: 'Khan Household' });
  });

  it('accepts the low_confidence band for read-only lookups, label included', async () => {
    const resolved = await resolveLookupReference(
      resolverReturning({ kind: 'low_confidence', candidate: customer('c-2', 'Khanna Enterprises') }),
      TENANT,
      'Khan',
      'customer',
    );

    expect(resolved).toEqual({ kind: 'resolved', id: 'c-2', label: 'Khanna Enterprises' });
  });

  it('with no resolver wired, resolution is skipped rather than guessed', async () => {
    expect(await resolveLookupReference(undefined, TENANT, 'Khan', 'customer')).toEqual({
      kind: 'unresolved',
    });
  });
});
