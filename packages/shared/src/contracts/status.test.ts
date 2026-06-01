import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  AppointmentStatus,
  EstimateStatus,
  InvoiceStatus,
  JobStatus,
  ProposalStatus,
} from '../enums.js';
import { STATUS_SCHEMAS } from './status.js';

/**
 * Parity guard: the canonical Zod status sets, the legacy TS enums, and the
 * database CHECK constraints must all agree. This is the test that makes the
 * `created` vs `new` class of drift impossible to ship again.
 */

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../../../api/src/db/schema.ts');
const schemaSource = readFileSync(schemaPath, 'utf8');

/** Every `CHECK (status IN ('a', 'b', ...))` value-set declared in schema.ts. */
function dbCheckStatusSets(source: string): Set<string>[] {
  const sets: Set<string>[] = [];
  const re = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (values.length > 0) sets.push(new Set(values));
  }
  return sets;
}

const dbSets = dbCheckStatusSets(schemaSource);

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** True if `values` exactly equals at least one DB CHECK set (the latest ALTER wins, but presence is sufficient). */
function hasMatchingDbSet(values: readonly string[]): boolean {
  const target = new Set(values);
  return dbSets.some((s) => setsEqual(s, target));
}

const legacyEnums = {
  job: JobStatus,
  appointment: AppointmentStatus,
  estimate: EstimateStatus,
  invoice: InvoiceStatus,
  proposal: ProposalStatus,
} as const;

describe('status contracts ↔ DB CHECK constraints (schema.ts parity)', () => {
  it('extracts status CHECK sets from schema.ts', () => {
    expect(dbSets.length).toBeGreaterThan(0);
  });

  for (const [name, schema] of Object.entries(STATUS_SCHEMAS)) {
    it(`${name}: Zod enum set exactly matches a DB CHECK (status IN ...) set`, () => {
      expect(hasMatchingDbSet(schema.options)).toBe(true);
    });

    it(`${name}: legacy TS enum values equal the Zod enum set`, () => {
      const key = name as keyof typeof legacyEnums;
      const enumValues = new Set<string>(Object.values(legacyEnums[key]));
      const schemaValues = new Set<string>(schema.options);
      expect([...enumValues].sort()).toEqual([...schemaValues].sort());
    });
  }
});
