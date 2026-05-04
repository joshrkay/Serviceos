/**
 * VQ-001 — Rubric loader.
 *
 * Reads the versioned rubric JSON shipped alongside this file, validates it
 * with `RubricSchema`, and returns a typed `Rubric` object. Throws if the
 * file is missing or fails schema validation — graders rely on the rubric
 * being well-formed; failing fast is correct.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RubricSchema, type Rubric, type RubricVersion } from '../schema';

/**
 * Load and validate a rubric for the given version. Currently only `v1`
 * exists; new versions add a new JSON file and extend `RubricVersionSchema`.
 */
export function loadRubric(version: RubricVersion): Rubric {
  const file = join(__dirname, `rubric.${version}.json`);
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return RubricSchema.parse(parsed);
}
