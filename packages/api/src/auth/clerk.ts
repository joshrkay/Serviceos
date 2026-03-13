import * as crypto from 'crypto';
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
  authError?: string;
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
        role: payload.role,
      };
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      req.authError = message;
      next();
    }
  };
}

export interface ClerkTokenPayload {
  sub: string;
  sid: string;
  tenant_id: string;
  role: string;
  exp: number;
}

const VALID_ROLES = ['owner', 'dispatcher', 'technician'];

export function decodeClerkToken(token: string, secretKey: string): ClerkTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  // Verify HMAC-SHA256 signature
  const signatureInput = `${parts[0]}.${parts[1]}`;
  const expectedSig = crypto
    .createHmac('sha256', secretKey)
    .update(signatureInput)
    .digest('base64url');

  const providedSig = parts[2];
  if (expectedSig.length !== providedSig.length) {
    throw new Error('Invalid token signature');
  }
  const sigValid = crypto.timingSafeEqual(
    Buffer.from(expectedSig),
    Buffer.from(providedSig)
  );
  if (!sigValid) {
    throw new Error('Invalid token signature');
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.sub || !payload.sid) {
      throw new Error('Missing required token claims');
    }
    if (!payload.exp) {
      throw new Error('Token missing expiration claim');
    }
    if (payload.exp < Date.now() / 1000) {
      throw new Error('Token expired');
    }
    if (!payload.role || !VALID_ROLES.includes(payload.role)) {
      throw new Error('Token missing or invalid role claim');
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
