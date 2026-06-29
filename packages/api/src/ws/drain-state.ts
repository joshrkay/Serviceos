/**
 * Process-wide drain flag for graceful shutdown (scale-to-1000 P4 / U-P4a).
 *
 * When a replica receives SIGTERM we flip this on FIRST, before tearing anything
 * down. While draining:
 *   - `/ready` reports `down` → 503, so the load balancer / Railway stop routing
 *     new HTTP traffic to this instance (`/health` stays 200 for liveness).
 *   - the WS upgrade handlers (client gateway + Twilio media streams) reject new
 *     upgrades with 503 + Retry-After, so new dashboards/calls land on another
 *     replica instead of attaching to one that's about to exit.
 * Already-open connections (live voice calls, streaming dashboards) keep running
 * until they finish or the bounded drain window elapses — see the shutdown
 * handler in app.ts.
 *
 * Module-level so the upgrade handlers (separate modules) and the health check
 * can all observe the same flag without threading a parameter through every
 * attach call.
 */
let draining = false;

/** Flip the drain flag. Called once from the SIGTERM handler. */
export function setDraining(value: boolean): void {
  draining = value;
}

/** True once the process has begun draining for shutdown. */
export function isDraining(): boolean {
  return draining;
}
