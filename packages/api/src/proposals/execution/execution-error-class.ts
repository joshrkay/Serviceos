/**
 * #1490 — is a thrown execution error DETERMINISTIC (retrying reproduces it)?
 *
 * The execution sweep retries a failed proposal through stale recovery. That
 * is right for a dropped connection, a deadlock, a serialization failure or a
 * shutdown — and pointless for a constraint violation or bad data, which fail
 * identically every time and leave the proposal visibly stuck in 'executing'.
 *
 * Conservative by design: only errors KNOWN to be deterministic are; anything
 * unrecognised keeps the bounded retry.
 */

/** SQLSTATE classes whose errors reproduce on retry. */
const DETERMINISTIC_SQLSTATE_CLASSES = new Set([
  '22', // data exception (bad input value, overflow, …)
  '23', // integrity constraint violation (unique, foreign key, check, not null)
  '42', // syntax error or access rule violation (incl. RLS policy refusals)
]);

/** Individual SQLSTATEs outside those classes that also reproduce. */
const DETERMINISTIC_SQLSTATES = new Set([
  '25P02', // in_failed_sql_transaction — a statement in the unit already failed
]);

/** Application error codes the executor throws that no retry can change. */
const DETERMINISTIC_APP_CODES = new Set(['HANDLER_NOT_FOUND']);

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

function classifyOne(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  if (DETERMINISTIC_APP_CODES.has(code)) return true;
  if (!SQLSTATE_RE.test(code)) return false;
  return DETERMINISTIC_SQLSTATES.has(code) || DETERMINISTIC_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

export function isDeterministicExecutionError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (classifyOne(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
