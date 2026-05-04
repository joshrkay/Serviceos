/**
 * Phase 4d-1 review carryover (Issue #2): shared atom + tokenizer for the
 * urgency-classifier condition expressions. Lives in its own file so the
 * Zod schema (`triage-rules.schema.ts`) can validate atoms at boot time
 * without duplicating the evaluator's atom catalogue, AND the classifier
 * (`classify-urgency-tier.ts`) can evaluate them at runtime. One source
 * of truth for "what atoms are valid and what do they mean."
 *
 * The motivating bug class: a JSON author writes `elderly_present`
 * instead of `elderly`, the atom silently evaluates to `false` because
 * no pattern matches, the conditional rule never fires, and the only
 * way we discover the typo is the dispatcher edit-rate metric weeks
 * later. Cheap to prevent at boot — expensive to debug in production.
 *
 * The grammar is intentionally narrow:
 *   - Static atoms: a fixed set of household / season tokens
 *   - Parametric atoms: temperature predicates with an integer threshold
 *   - The sentinel `any` is treated as a degenerate "always-true" condition
 *     by the classifier and is allowed at the schema level too
 *
 * Operators (AND, OR, parens) are NOT atoms — they're grammar tokens
 * that the evaluator handles directly. We only validate atoms here.
 */

/** Static atoms with no parameters. */
export const STATIC_ATOMS = [
  'elderly',
  'infant',
  'medical_equipment_in_home',
  'single_family_home',
  'winter',
  'summer',
] as const;

export type StaticAtom = (typeof STATIC_ATOMS)[number];

/**
 * Parametric atom families. Each pattern matches a family name + a
 * threshold integer (Fahrenheit). The classifier reads the integer
 * out of the atom string at evaluation time.
 */
export const PARAMETRIC_ATOM_PATTERNS: ReadonlyArray<{
  /** The pattern shape, for documentation / error messages. */
  shape: string;
  /** Anchored regex matching the lower-cased atom string. */
  regex: RegExp;
}> = [
  { shape: 'outdoor_temp_below_<N>f', regex: /^outdoor_temp_below_(\d+)f$/ },
  { shape: 'outdoor_temp_above_<N>f', regex: /^outdoor_temp_above_(\d+)f$/ },
  { shape: 'indoor_temp_below_<N>f', regex: /^indoor_temp_below_(\d+)f$/ },
];

/**
 * `any` is treated as a degenerate single-atom condition that always
 * resolves true. Permitted at the schema level so existing rules like
 * `{ "phrase": "pipes frozen", "condition": "any" }` validate cleanly.
 */
export const SENTINEL_ATOMS = ['any'] as const;

/**
 * Tokenize a condition expression into the atoms it contains. Strips
 * operators (AND, OR), parentheses, and whitespace; returns each atom
 * lower-cased. Used by both the validator (to check each atom is in
 * the allow-list) and the evaluator (to walk atoms in order).
 */
export function tokenizeAtoms(expression: string): string[] {
  const lowered = expression.toLowerCase();
  // Remove parens, then split on whitespace + boolean operators.
  const stripped = lowered.replace(/[()]/g, ' ');
  return stripped
    .split(/\s+/)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0 && tok !== 'and' && tok !== 'or');
}

/**
 * Returns true when `atom` is a recognised static, parametric, or
 * sentinel atom. Lower-case the input before calling.
 */
export function isAtomValid(atom: string): boolean {
  if ((STATIC_ATOMS as readonly string[]).includes(atom)) return true;
  if ((SENTINEL_ATOMS as readonly string[]).includes(atom)) return true;
  return PARAMETRIC_ATOM_PATTERNS.some((p) => p.regex.test(atom));
}

/**
 * Validate every atom in a condition expression. Returns the list of
 * unknown atoms (empty when the expression is valid). Callers can use
 * the empty-list result for early-return + the list for error messages
 * that name every typo in one shot rather than failing on the first.
 */
export function findUnknownAtoms(expression: string): string[] {
  const atoms = tokenizeAtoms(expression);
  return atoms.filter((a) => !isAtomValid(a));
}

/** A short human-readable description of the grammar for error messages. */
export function describeAtomGrammar(): string {
  const staticList = STATIC_ATOMS.join(', ');
  const parametricList = PARAMETRIC_ATOM_PATTERNS.map((p) => p.shape).join(', ');
  const sentinelList = SENTINEL_ATOMS.join(', ');
  return (
    `Allowed atoms: ${staticList}. ` +
    `Parametric: ${parametricList}. ` +
    `Sentinel: ${sentinelList}. ` +
    `Operators: AND, OR, parentheses.`
  );
}
