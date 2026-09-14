import { AsyncLocalStorage } from 'async_hooks';
import type { PoolClient } from 'pg';
import { AppError } from '../shared/errors';

/**
 * #1125 — fencing for work protected by a SESSION advisory lock.
 *
 * A session advisory lock lives exactly as long as the backend that took it.
 * When Postgres terminates that backend (an admin terminate, a failover, a
 * server-side session timeout, a network reset), the lock is released at
 * once and another holder can take it — but the process that held it is
 * not told through any promise: its lock connection is idle for the whole
 * critical section, so the termination only surfaces as an `'error'` /
 * `'end'` EVENT on that client (pg/lib/client.js `_handleErrorMessage` with
 * no active query → `_handleErrorEvent`). #1112's `guardClientErrors`
 * (db/pool.ts) keeps that event off `uncaughtException`; this module turns it
 * into a signal the protected work actually obeys.
 *
 * - `watchSessionLease(client)` marks the lease lost on the lock client's
 *   first `'error'` or `'end'`.
 * - `lease.assertHeld()` is the explicit fence at a critical point (before
 *   an external call, before a commit).
 * - `runWithSessionLease(lease, fn)` makes the lease AMBIENT for everything
 *   `fn` awaits, and `PgBaseRepository` calls `assertAmbientSessionLeaseHeld()`
 *   before it touches the database — so once the lease is lost, the protected
 *   work's next repository call refuses instead of committing, without every
 *   sweep and handler having to thread the lease through by hand.
 */

export class SessionLeaseLostError extends AppError {
  constructor(label: string, cause: Error | undefined) {
    super(
      'SESSION_LEASE_LOST',
      `${label}: the connection holding the session advisory lock was lost` +
        (cause ? ` (${cause.message})` : '') +
        ' — refusing to continue work that lock no longer protects',
      503,
    );
    this.name = 'SessionLeaseLostError';
  }
}

export interface SessionLease {
  /** What the lock protects — carried into the error message. */
  readonly label: string;
  /** True once the lock-holding connection has errored or ended. */
  readonly lost: boolean;
  /** Throws `SessionLeaseLostError` when the lease is lost. */
  assertHeld(): void;
}

/**
 * Start watching a client that has just acquired a session advisory lock.
 * Call `stopWatching()` before the owner unlocks/releases the client, so the
 * owner's own teardown is never mistaken for a loss.
 */
export function watchSessionLease(
  client: PoolClient,
  label: string,
): { lease: SessionLease; stopWatching: () => void } {
  let lost = false;
  let cause: Error | undefined;

  const onError = (err: Error): void => {
    if (!lost) cause = err;
    lost = true;
  };
  const onEnd = (): void => {
    lost = true;
  };
  client.on('error', onError);
  client.on('end', onEnd);

  const lease: SessionLease = {
    label,
    get lost() {
      return lost;
    },
    assertHeld() {
      if (lost) throw new SessionLeaseLostError(label, cause);
    },
  };

  return {
    lease,
    stopWatching: () => {
      client.removeListener('error', onError);
      client.removeListener('end', onEnd);
    },
  };
}

interface LeaseScope {
  lease: SessionLease;
  parent: LeaseScope | undefined;
}

const leaseScopes = new AsyncLocalStorage<LeaseScope>();

/** Run `fn` with `lease` ambient (nested scopes keep enforcing their parents). */
export function runWithSessionLease<T>(lease: SessionLease, fn: () => Promise<T>): Promise<T> {
  return leaseScopes.run({ lease, parent: leaseScopes.getStore() }, fn);
}

/** Throws `SessionLeaseLostError` if any enclosing ambient lease is lost; no-op outside one. */
export function assertAmbientSessionLeaseHeld(): void {
  for (let scope = leaseScopes.getStore(); scope; scope = scope.parent) {
    scope.lease.assertHeld();
  }
}
