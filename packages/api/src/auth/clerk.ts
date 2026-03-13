import { clerkMiddleware, getAuth } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    sessionId: string;
    tenantId: string;
    role: string;
  };
}

export interface Tenant {
  id: string;
  ownerId: string;
  ownerEmail: string;
  name: string;
  createdAt: Date;
}

export interface TenantRepository {
  findByOwner(ownerId: string): Promise<Tenant | null>;
  findById(id: string): Promise<Tenant | null>;
  create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant>;
}

export interface TenantBootstrapResult {
  tenantId: string;
  ownerId: string;
  created: boolean;
}

// ── Clerk middleware ──────────────────────────────────────────────────────────
//
// clerkMiddleware() reads CLERK_SECRET_KEY from env and automatically:
//   1. Fetches the JWKS from https://romantic-lark-48.clerk.accounts.dev/.well-known/jwks.json
//   2. Verifies the RS256 JWT signature on every request
//   3. Caches the public keys — no per-request JWKS fetches
//
// Mount this before all routes in the Express app.

export const clerkAuthMiddleware = clerkMiddleware();

// ── Auth context extractor ────────────────────────────────────────────────────
//
// Run after clerkMiddleware(). Reads the verified claims and attaches
// a typed auth context to req.auth.
//
// Custom JWT template claims (tenant_id, role) come from sessionClaims.
// These are set in the Clerk dashboard → JWT Templates → serviceos.

export function extractAuthContext(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const auth = getAuth(req);

  if (auth?.userId) {
    const claims = (auth.sessionClaims ?? {}) as Record<string, unknown>;

    req.auth = {
      userId: auth.userId,
      sessionId: auth.sessionId ?? '',
      tenantId: (claims['tenant_id'] as string) ?? '',
      role: (claims['role'] as string) ?? 'technician',
    };
  }

  next();
}

// ── Tenant bootstrap ──────────────────────────────────────────────────────────
//
// Called from the Clerk webhook handler on user.created events.
// Idempotent — safe to call multiple times for the same user.

export async function bootstrapTenant(
  userId: string,
  email: string,
  tenantRepository: TenantRepository
): Promise<TenantBootstrapResult> {
  if (!userId || !email) {
    throw new Error('userId and email are required for tenant bootstrap');
  }

  const existing = await tenantRepository.findByOwner(userId);
  if (existing) {
    return { tenantId: existing.id, ownerId: userId, created: false };
  }

  const tenant = await tenantRepository.create({
    ownerId: userId,
    ownerEmail: email,
    name: email.split('@')[0] + "'s Organization",
  });

  return { tenantId: tenant.id, ownerId: userId, created: true };
}
