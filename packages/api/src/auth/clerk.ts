import { Request, Response, NextFunction } from 'express';

export interface ClerkUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  publicMetadata?: Record<string, unknown>;
}

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    sessionId: string;
    tenantId: string;
    role: string;
  };
  clerkUser?: ClerkUser;
}

export function verifyClerkSession(clerkSecretKey: string) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }

    const token = authHeader.substring(7);
    if (!token) {
      next();
      return;
    }

    try {
      const payload = decodeClerkToken(token, clerkSecretKey);
      req.auth = {
        userId: payload.sub,
        sessionId: payload.sid,
        tenantId: payload.tenant_id,
        role: payload.role || 'technician',
      };
      next();
    } catch {
      next();
    }
  };
}

export interface ClerkTokenPayload {
  sub: string;
  sid: string;
  tenant_id: string;
  role?: string;
  exp: number;
}

export function decodeClerkToken(token: string, _secretKey: string): ClerkTokenPayload {
  // In production, this would verify the JWT signature using Clerk's JWKS
  // For now, this validates the token structure
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.sub || !payload.sid) {
      throw new Error('Missing required token claims');
    }
    if (payload.exp && payload.exp < Date.now() / 1000) {
      throw new Error('Token expired');
    }
    return payload;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Invalid token payload');
    }
    throw err;
  }
}

export interface TenantBootstrapResult {
  tenantId: string;
  ownerId: string;
  created: boolean;
}

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
