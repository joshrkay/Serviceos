/**
 * Dispatch-board revision tokens (per tenant + board date).
 *
 * Clients treat the token as an opaque change marker: the SSE/WS stream
 * delivers `board_updated { boardRevision }` and the client refetches when it
 * differs from the one it holds (useDispatchBoardStream.ts).
 *
 * Multi-replica (UC-4): `bumpDispatchBoardRevision` is called synchronously
 * from proposal-execution handlers (board-notify.ts), so the revision cannot
 * be an awaited Redis INCR without changing every call site's semantics.
 * Instead the revision is GENERATED ON EMIT and MIRRORED: when fan-out is
 * enabled the token embeds a total order `<tsMs>.<seq>.<replicaId>`, rides the
 * board_updated event over the Redis mirror, and receiving replicas merge it
 * with max-wins (`applyRemoteDispatchBoardRevision`). Because the winner is
 * determined by token CONTENT (not arrival order), concurrent bumps on two
 * replicas converge to the same token everywhere — no refetch flapping — and
 * per-key monotonicity holds: a local bump always orders strictly above every
 * token this replica has generated OR merged for that key.
 *
 * When fan-out is not enabled the token stays a bare randomUUID — byte-
 * identical to the single-replica behavior shipped before UC-4.
 */
import { randomUUID } from 'crypto';

interface RevisionOrd {
  ts: number;
  seq: number;
  replicaId: string;
}

interface RevisionRecord {
  token: string;
  /** null for legacy/random tokens — they lose to any ordered token. */
  ord: RevisionOrd | null;
}

const revisions = new Map<string, RevisionRecord>();

let orderedMode = false;
let localReplicaId = 'local';

/**
 * Flip revision generation to ordered tokens. Called once at boot by
 * `initDispatchBoardFanout` when the cross-replica mirror is enabled; the flag
 * is deployment-level so all replicas agree on the token format.
 */
export function enableOrderedDispatchBoardRevisions(replicaId: string): void {
  orderedMode = true;
  localReplicaId = replicaId;
}

/** Test hook — restore the module to its boot state. */
export function resetDispatchBoardRevisionsForTests(): void {
  revisions.clear();
  orderedMode = false;
  localReplicaId = 'local';
}

function revisionKey(tenantId: string, date: string): string {
  return `${tenantId}:${date}`;
}

function formatToken(ord: RevisionOrd): string {
  return `${ord.ts}.${ord.seq}.${ord.replicaId}`;
}

function parseToken(token: string): RevisionOrd | null {
  const match = /^(\d+)\.(\d+)\.(.+)$/.exec(token);
  if (!match) return null;
  return { ts: Number(match[1]), seq: Number(match[2]), replicaId: match[3] };
}

/** Total order: (ts, seq, replicaId). replicaId breaks same-ms/same-seq ties
 *  deterministically so all replicas pick the same winner. */
function compareOrd(a: RevisionOrd, b: RevisionOrd): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.replicaId < b.replicaId ? -1 : a.replicaId > b.replicaId ? 1 : 0;
}

export function bumpDispatchBoardRevision(tenantId: string, date: string): string {
  const key = revisionKey(tenantId, date);
  if (!orderedMode) {
    const rev = randomUUID();
    revisions.set(key, { token: rev, ord: null });
    return rev;
  }
  // Order strictly above everything seen for this key (local bumps AND merged
  // remote tokens) even under host clock skew between replicas.
  const last = revisions.get(key)?.ord;
  const now = Date.now();
  const ord: RevisionOrd =
    last && now <= last.ts
      ? { ts: last.ts, seq: last.seq + 1, replicaId: localReplicaId }
      : { ts: now, seq: 0, replicaId: localReplicaId };
  const token = formatToken(ord);
  revisions.set(key, { token, ord });
  return token;
}

export function getDispatchBoardRevision(tenantId: string, date: string): string {
  const key = revisionKey(tenantId, date);
  const existing = revisions.get(key);
  if (existing) return existing.token;
  // Lazy initial token. Random in both modes: with ord=null it loses to any
  // ordered remote token, so a fresh replica converges on first mirror.
  const initial = randomUUID();
  revisions.set(key, { token: initial, ord: null });
  return initial;
}

/**
 * Merge a revision received from another replica's board_updated mirror.
 * Max-wins on the token's embedded order; unordered (legacy/random) incoming
 * tokens win only over an unordered local one (last-write-wins), never over an
 * ordered token.
 */
export function applyRemoteDispatchBoardRevision(
  tenantId: string,
  date: string,
  token: string,
): void {
  const key = revisionKey(tenantId, date);
  const incoming = parseToken(token);
  const current = revisions.get(key);
  if (!current) {
    revisions.set(key, { token, ord: incoming });
    return;
  }
  if (!incoming) {
    if (!current.ord) revisions.set(key, { token, ord: null });
    return;
  }
  if (!current.ord || compareOrd(incoming, current.ord) > 0) {
    revisions.set(key, { token, ord: incoming });
  }
}

/** Board calendar date from an appointment instant (UTC day). */
export function boardDateFromAppointment(scheduledStart: Date): string {
  return scheduledStart.toISOString().slice(0, 10);
}
