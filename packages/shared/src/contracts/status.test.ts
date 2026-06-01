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
import { resolveDbCheckSet } from './db-check.js';

/**
 * Parity guard: the canonical Zod status sets, the legacy TS enums, and the
 * database CHECK constraints must all agree. This is the test that makes the
 * `created` vs `new` class of drift impossible to ship again.
 *
 * Each status set is matched against the *authoritative* (last) CHECK for its
 * table — not any historical migration — so a schema that drops a value a later
 * migration added (e.g. proposals' `executing`) fails instead of matching a
 * stale constraint.
 */

const here = dirname(fileURLToPath(import.meta.url));
const schemaSource = readFileSync(
  resolve(here, '../../../api/src/db/schema.ts'),
  'utf8',
);

/** Maps each canonical status schema to the table whose `status` column it mirrors. */
const STATUS_TABLES = {
  job: 'jobs',
  appointment: 'appointments',
  estimate: 'estimates',
  invoice: 'invoices',
  proposal: 'proposals',
} as const;

const legacyEnums = {
  job: JobStatus,
  appointment: AppointmentStatus,
  estimate: EstimateStatus,
  invoice: InvoiceStatus,
  proposal: ProposalStatus,
} as const;

describe('status contracts ↔ DB CHECK constraints (schema.ts parity)', () => {
  for (const [name, schema] of Object.entries(STATUS_SCHEMAS)) {
    const key = name as keyof typeof STATUS_TABLES;
    const table = STATUS_TABLES[key];

    it(`${name}: Zod enum set equals the authoritative ${table}.status CHECK`, () => {
      const dbSet = resolveDbCheckSet(schemaSource, table, 'status');
      expect([...schema.options].sort()).toEqual([...dbSet].sort());
    });

    it(`${name}: legacy TS enum values equal the Zod enum set`, () => {
      const enumValues = new Set<string>(Object.values(legacyEnums[key]));
      const schemaValues = new Set<string>(schema.options);
      expect([...enumValues].sort()).toEqual([...schemaValues].sort());
    });
  }
});
