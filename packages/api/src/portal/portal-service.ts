/**
 * P10-001 — Portal session service: create / resolve / revoke.
 *
 * Token contract:
 *   - Plaintext token = `crypto.randomBytes(32).toString('hex')` (64 chars).
 *   - Storage column  = `sha256(plaintextToken)` hex.
 *   - Returned to caller ONCE at create time. Lookup is hash-only.
 *
 * Resolution is system-level: at lookup time we don't yet know which
 * tenant to scope to — that's literally what `resolvePortalToken`
 * returns. The Pg repository uses `withClient()` for the hash lookup;
 * downstream public routes then pin their queries to the resolved
 * tenant id (NEVER user-supplied).
 */
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PortalSession, PortalSessionRepository } from './portal-session';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface CreatePortalSessionResult {
  id: string;
  /** Plaintext token. Returned ONCE — never persisted. */
  token: string;
  expiresAt: Date;
  /** Convenience portal URL composed by the route layer. */
  url?: string;
}

export interface ResolvedPortalSession {
  tenantId: string;
  customerId: string;
  sessionId: string;
}

export const DEFAULT_PORTAL_TTL_DAYS = 30;

export function hashPortalToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function generatePortalTokenPair(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashPortalToken(token) };
}

/**
 * Constant-time hash compare. Both inputs are sha256 hex (same length),
 * but we still defend with a length check before `timingSafeEqual` so
 * a malformed input can't crash the route.
 */
export function tokenHashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export interface CreatePortalSessionAuditContext {
  /** Clerk role of the operator who minted the token (e.g. 'owner'). */
  actorRole?: string;
  /** Best-effort IP + UA from the request, for non-repudiation. */
  ipAddress?: string;
  userAgent?: string;
}

export async function createPortalSession(
  tenantId: string,
  customerId: string,
  createdBy: string,
  repo: PortalSessionRepository,
  ttlDays: number = DEFAULT_PORTAL_TTL_DAYS,
  auditRepo?: AuditRepository,
  auditContext?: CreatePortalSessionAuditContext,
): Promise<CreatePortalSessionResult> {
  if (!tenantId) throw new Error('tenantId is required');
  if (!customerId) throw new Error('customerId is required');
  if (!createdBy) throw new Error('createdBy is required');
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error('ttlDays must be a positive number');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const { token, tokenHash } = generatePortalTokenPair();

  const session: PortalSession = {
    id: uuidv4(),
    tenantId,
    customerId,
    tokenHash,
    expiresAt,
    revokedAt: undefined,
    lastAccessedAt: undefined,
    createdBy,
    createdAt: now,
  };

  const created = await repo.create(session);

  if (auditRepo) {
    // D2-1d: portal tokens are bearer credentials — minting must be
    // auditable. Actor is the authenticated operator who issued the
    // token; raw token is intentionally NEVER written to the audit row.
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: createdBy,
        actorRole: auditContext?.actorRole ?? 'unknown',
        eventType: 'portal_session.created',
        entityType: 'portal_session',
        entityId: created.id,
        metadata: {
          customerId,
          expiresAt: created.expiresAt.toISOString(),
          ttlDays,
          ipAddress: auditContext?.ipAddress,
          userAgent: auditContext?.userAgent,
        },
      }),
    );
  }

  return {
    id: created.id,
    token,
    expiresAt: created.expiresAt,
  };
}

/**
 * Resolves a plaintext token into the underlying tenant + customer.
 * Returns `null` for any failure (unknown / expired / revoked).
 *
 * Side effect: bumps `last_accessed_at` on success. Failures here
 * are swallowed so a transient write error doesn't 500 the read.
 */
export async function resolvePortalToken(
  token: string,
  repo: PortalSessionRepository,
  now: Date = new Date(),
): Promise<ResolvedPortalSession | null> {
  if (!token || typeof token !== 'string') return null;
  // Token shape: 64 hex chars from crypto.randomBytes(32).toString('hex').
  // Reject anything else fast — keeps the hash compare path predictable.
  if (token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) return null;

  const candidateHash = hashPortalToken(token);
  const session = await repo.findByTokenHash(candidateHash);
  if (!session) return null;

  // Defense in depth: the lookup is by exact hash, but compare again with
  // constant-time semantics so a malicious DB row injection can't poke the
  // string-equality path.
  if (!tokenHashesEqual(session.tokenHash, candidateHash)) return null;

  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  // Best-effort touch — never fail the resolve over a transient write.
  try {
    await repo.touchLastAccessed(session.id, now);
  } catch {
    // intentional: read path stays available even when the touch fails.
  }

  return {
    tenantId: session.tenantId,
    customerId: session.customerId,
    sessionId: session.id,
  };
}

export interface RevokePortalSessionAuditContext {
  /** Clerk subject id of the operator performing the revoke. */
  actorId?: string;
  actorRole?: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function revokePortalSession(
  tenantId: string,
  sessionId: string,
  repo: PortalSessionRepository,
  auditRepo?: AuditRepository,
  auditContext?: RevokePortalSessionAuditContext,
): Promise<PortalSession | null> {
  if (!tenantId) throw new Error('tenantId is required');
  if (!sessionId) throw new Error('sessionId is required');
  const revoked = await repo.revoke(tenantId, sessionId, new Date());

  if (revoked && auditRepo) {
    // D2-1d: revoke is a credential-invalidation event — always audited.
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: auditContext?.actorId ?? 'system',
        actorRole: auditContext?.actorRole ?? 'unknown',
        eventType: 'portal_session.revoked',
        entityType: 'portal_session',
        entityId: revoked.id,
        metadata: {
          customerId: revoked.customerId,
          revokedAt: revoked.revokedAt?.toISOString(),
          ipAddress: auditContext?.ipAddress,
          userAgent: auditContext?.userAgent,
        },
      }),
    );
  }

  return revoked;
}
