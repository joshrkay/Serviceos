import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../logging/logger';

const authLogger = createLogger({
  service: 'auth',
  environment: process.env.NODE_ENV || 'dev',
});

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

// ─────────────────────────────────────────────────────────────────────────────
// P0-033 — RS256 + JWKS verification
//
// Real Clerk session tokens are signed RS256 with a per-instance keypair
// published at https://{frontend_api_host}/.well-known/jwks.json. The legacy
// HMAC-SHA256 path can no longer verify a real production token; it remains
// available behind the explicit CLERK_DEV_HMAC_TOKENS=true flag (refused in
// production by validateEnvSchema in shared/config.ts) so existing
// synthetic dev tokens keep working during the transition.
//
// IMPORTANT — return shape contract: every middleware downstream depends on
// `{ userId, tenantId, role }` (with the additional `sessionId` we set on
// req.auth). Do NOT rename or add fields without auditing every consumer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A JWKS key the resolver returns. We accept Node's `KeyObject` (created via
 * `crypto.createPublicKey`) for in-process tests and a `{ kid, publicKey }`
 * shape for fetched JWKS entries.
 */
export interface JwksKey {
  kid?: string;
  /** A Node `KeyObject` for an RSA public key. */
  publicKey: crypto.KeyObject;
  alg?: string;
}

/**
 * Resolves a JWKS for a given issuer host. The default resolver fetches
 * `https://{host}/.well-known/jwks.json` over HTTPS and caches the result for
 * `JWKS_TTL_MS`. Tests inject a synthetic resolver to avoid network I/O.
 *
 * `forceRefresh = true` instructs the resolver to bypass any cached entry and
 * re-fetch — used once on a `kid` miss.
 */
export interface JwksResolver {
  getKeys(host: string, forceRefresh?: boolean): Promise<JwksKey[]>;
}

const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes per the story spec

interface JwksCacheEntry {
  keys: JwksKey[];
  expiresAt: number;
}

/**
 * The default resolver fetches and caches JWKS over HTTPS. Cache entries are
 * keyed by host so multiple Clerk instances (multi-tenant) can co-exist.
 */
class HttpsJwksResolver implements JwksResolver {
  private readonly cache = new Map<string, JwksCacheEntry>();

  async getKeys(host: string, forceRefresh = false): Promise<JwksKey[]> {
    const now = Date.now();
    if (!forceRefresh) {
      const cached = this.cache.get(host);
      if (cached && cached.expiresAt > now) return cached.keys;
    }
    const keys = await this.fetchJwks(host);
    this.cache.set(host, { keys, expiresAt: now + JWKS_TTL_MS });
    return keys;
  }

  /**
   * Fetch the JWKS JSON document from `https://{host}/.well-known/jwks.json`
   * and convert each entry into a Node `KeyObject`. Uses the global `fetch`
   * available since Node 18.
   */
  private async fetchJwks(host: string): Promise<JwksKey[]> {
    const url = `https://${host}/.well-known/jwks.json`;
    // `fetch` is global in Node 18+. We don't use a wrapped client because we
    // want zero new transitive deps in this auth path.
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.keys)) {
      throw new Error('JWKS response missing "keys" array');
    }
    return body.keys.map((jwk) => jwkToJwksKey(jwk));
  }
}

function jwkToJwksKey(jwk: Record<string, unknown>): JwksKey {
  if (typeof jwk.kty !== 'string') {
    throw new Error('JWK missing kty');
  }
  // Node's createPublicKey accepts the JWK directly when format: 'jwk'.
  const publicKey = crypto.createPublicKey({
    key: jwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  return {
    kid: typeof jwk.kid === 'string' ? jwk.kid : undefined,
    alg: typeof jwk.alg === 'string' ? jwk.alg : undefined,
    publicKey,
  };
}

// Singleton resolver used by the default verifier. Tests can construct their
// own verifier with an injected resolver instead.
const defaultResolver: JwksResolver = new HttpsJwksResolver();

/**
 * Decodes a Clerk publishable key (`pk_live_...` or `pk_test_...`) to the
 * frontend API host (e.g. `clerk.example.com`). Clerk encodes the host as a
 * base64-encoded string with a trailing `$` sentinel.
 */
export function clerkFrontendApiFromPubKey(pubKey: string): string {
  const stripped = pubKey.replace(/^pk_(live|test)_/, '');
  if (stripped === pubKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY is not a Clerk publishable key (missing pk_live_/pk_test_ prefix)');
  }
  const decoded = Buffer.from(stripped, 'base64').toString('utf-8');
  // Clerk includes a trailing '$' sentinel in the base64-encoded host.
  return decoded.replace(/\$+$/, '').trim();
}

export interface ClerkTokenPayload {
  sub: string;
  sid: string;
  tenant_id: string;
  role: string;
  exp: number;
}

const VALID_ROLES = ['owner', 'dispatcher', 'technician'];

/**
 * Internal helper. Decodes a JWT into header/payload/signature fragments.
 * Does NOT verify the signature.
 */
interface JwtParts {
  header: Record<string, unknown>;
  payloadJson: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function parseJwt(token: string): JwtParts {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  let header: Record<string, unknown>;
  let payloadJson: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
  } catch {
    throw new Error('Invalid token header');
  }
  try {
    payloadJson = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    throw new Error('Invalid token payload');
  }
  return {
    header,
    payloadJson,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

/**
 * Validates Clerk-specific claim shape and returns the typed payload. Shared
 * by both the RS256 and HMAC paths so both produce the same return contract.
 */
function validateClerkClaims(
  payload: Record<string, unknown>,
  options: { issuer?: string; clockToleranceSeconds?: number } = {}
): ClerkTokenPayload {
  const tolerance = options.clockToleranceSeconds ?? 0;
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Missing required token claims');
  }
  if (typeof payload.sid !== 'string' || !payload.sid) {
    throw new Error('Missing required token claims');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('Token missing expiration claim');
  }
  if (payload.exp < now - tolerance) {
    throw new Error('Token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now + tolerance) {
    throw new Error('Token not yet valid');
  }
  if (options.issuer && payload.iss !== options.issuer) {
    throw new Error('Wrong issuer');
  }
  if (typeof payload.role !== 'string' || !VALID_ROLES.includes(payload.role)) {
    throw new Error('Token missing or invalid role claim');
  }
  return {
    sub: payload.sub,
    sid: payload.sid,
    tenant_id: typeof payload.tenant_id === 'string' ? payload.tenant_id : '',
    role: payload.role,
    exp: payload.exp,
  };
}

/**
 * Verifies an RS256-signed Clerk session token against the JWKS for the
 * configured frontend API host.
 *
 * Behaviour:
 *  - Looks up the signing key by `kid`.
 *  - On `kid` miss, refreshes the JWKS once and tries again.
 *  - Validates `iss`, `exp`, `nbf`, `role`.
 *  - Authorized-party (`azp`) is intentionally NOT enforced here — Clerk's
 *    audience model uses a list of permitted `azp` values that is per-app and
 *    out of scope for this story. Add when we know the canonical list.
 *
 * @throws Error with one of the canonical messages used in the dev path so
 *   callers don't have to special-case which path produced the rejection.
 */
export async function verifyRs256Token(
  token: string,
  options: {
    pubKey: string;
    resolver?: JwksResolver;
    /** Override the resolver-derived issuer host. Used by tests. */
    host?: string;
    clockToleranceSeconds?: number;
  }
): Promise<ClerkTokenPayload> {
  const resolver = options.resolver ?? defaultResolver;
  const host = options.host ?? clerkFrontendApiFromPubKey(options.pubKey);
  const issuer = `https://${host}`;

  const parts = parseJwt(token);
  const alg = parts.header.alg;
  if (alg !== 'RS256') {
    throw new Error(`Unsupported token algorithm: ${typeof alg === 'string' ? alg : 'unknown'}`);
  }
  const kid = typeof parts.header.kid === 'string' ? parts.header.kid : undefined;
  if (!kid) {
    throw new Error('Token header missing kid');
  }

  // Find signing key — refresh JWKS once on miss.
  let keys = await resolver.getKeys(host, false);
  let signingKey = keys.find((k) => k.kid === kid);
  if (!signingKey) {
    keys = await resolver.getKeys(host, true);
    signingKey = keys.find((k) => k.kid === kid);
    if (!signingKey) {
      throw new Error('No matching signing key for token kid');
    }
  }

  // Verify the RS256 signature.
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parts.signingInput);
  verifier.end();
  const ok = verifier.verify(signingKey.publicKey, parts.signature);
  if (!ok) {
    throw new Error('Invalid token signature');
  }

  return validateClerkClaims(parts.payloadJson, {
    issuer,
    clockToleranceSeconds: options.clockToleranceSeconds,
  });
}

export interface VerifyClerkSessionDeps {
  /** Custom JWKS resolver (used by tests). */
  jwksResolver?: JwksResolver;
  /**
   * Override the publishable key used to derive the JWKS host. Defaults to
   * `process.env.CLERK_PUBLISHABLE_KEY`.
   */
  publishableKey?: string;
  /**
   * Override the env snapshot used to read CLERK_DEV_HMAC_TOKENS / NODE_ENV.
   * Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

function isHmacDevModeEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.CLERK_DEV_HMAC_TOKENS !== 'true') return false;
  // Defense in depth: even if validateEnvSchema misses (e.g. someone
  // bypasses it on boot), we refuse the HMAC path in production at runtime.
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === 'production' || nodeEnv === 'prod') return false;
  return true;
}

export function verifyClerkSession(
  clerkSecretKey: string,
  deps: VerifyClerkSessionDeps = {}
) {
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

    const env = deps.env ?? process.env;

    try {
      let payload: ClerkTokenPayload;
      if (isHmacDevModeEnabled(env)) {
        // Legacy dev path — only active with explicit CLERK_DEV_HMAC_TOKENS=true
        // and never in production.
        payload = decodeClerkToken(token, clerkSecretKey);
      } else {
        const pubKey = deps.publishableKey ?? env.CLERK_PUBLISHABLE_KEY;
        if (!pubKey) {
          throw new Error('CLERK_PUBLISHABLE_KEY is required for RS256 verification');
        }
        payload = await verifyRs256Token(token, {
          pubKey,
          resolver: deps.jwksResolver,
        });
      }
      req.auth = {
        userId: payload.sub,
        sessionId: payload.sid,
        tenantId: payload.tenant_id,
        role: payload.role,
      };
      next();
    } catch (err) {
      // Do NOT set req.auth. Do NOT short-circuit here — the global
      // requireAuth middleware downstream will return 401 because
      // req.auth is unset. Log the reason so bad tokens aren't
      // silently indistinguishable from missing tokens.
      const message = err instanceof Error ? err.message : 'Authentication failed';
      req.authError = message;
      authLogger.warn('Clerk token rejected', {
        reason: message,
        ip: req.ip,
        path: req.path,
      });
      next();
    }
  };
}

/**
 * Legacy HMAC-SHA256 token decoder. Retained for the dev path and the existing
 * unit-test suite (P0-002). New code should rely on `verifyRs256Token`.
 */
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

export interface TenantBootstrapDeps {
  /**
   * Optional. If provided, bootstrapTenant will also seed a default
   * TenantSettings row for the new tenant via ensureTenantSettings.
   * This closes the onboarding hole where a brand-new operator would
   * see a 500 the first time they tried to create an estimate or
   * invoice because no settings row existed yet.
   */
  settingsRepository?: import('../settings/settings').SettingsRepository;
}

export async function bootstrapTenant(
  userId: string,
  email: string,
  tenantRepository: TenantRepository,
  deps: TenantBootstrapDeps = {}
): Promise<TenantBootstrapResult> {
  if (!userId || !email) {
    throw new Error('userId and email are required for tenant bootstrap');
  }

  const existing = await tenantRepository.findByOwner(userId);
  if (existing) {
    if (deps.settingsRepository) {
      // Idempotent: also ensures settings exist for an already-bootstrapped
      // tenant whose webhook fired before this code rolled out.
      const { ensureTenantSettings } = await import('../settings/settings');
      await ensureTenantSettings(existing.id, deps.settingsRepository);
    }
    return { tenantId: existing.id, ownerId: userId, created: false };
  }

  const tenant = await tenantRepository.create({
    ownerId: userId,
    ownerEmail: email,
    name: email.split('@')[0] + "'s Organization",
  });

  if (deps.settingsRepository) {
    const { ensureTenantSettings } = await import('../settings/settings');
    await ensureTenantSettings(tenant.id, deps.settingsRepository, {
      businessName: tenant.name,
    });
  }

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
