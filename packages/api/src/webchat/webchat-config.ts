/**
 * D-044 follow-up / #1737 — per-tenant web chat widget configuration.
 *
 * One row per tenant (`webchat_config`, migration 340). The row is the
 * tenant-side half of the public-path controls: the embed token (a public id,
 * not a secret), the allowed-origin list, the owner's on/off toggle and the
 * per-day caps. The platform-side halves (the `webchat_widget` tenant flag and
 * the global kill switch) are resolved in the service, not stored here.
 *
 * Off by default: no row, or `enabled = false`, means the public endpoints
 * answer "unavailable" and the widget never opens.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

/** Conservative defaults — a small trade business, not a call centre. */
export const DEFAULT_DAILY_TURN_CAP = 200;
export const DEFAULT_DAILY_COST_CAP_CENTS = 500;
export const MAX_DAILY_TURN_CAP = 5000;
export const MAX_DAILY_COST_CAP_CENTS = 20000;
export const MAX_ALLOWED_ORIGINS = 10;

export interface WebchatConfig {
  tenantId: string;
  /** Owner's toggle. Default false. */
  enabled: boolean;
  /** Public id embedded in the snippet: `<tenantUuid>.<24 hex>`. */
  embedToken: string;
  /** Normalized origins (`https://example.com`, optional `https://*.example.com`). */
  allowedOrigins: string[];
  dailyTurnCap: number;
  /** Integer cents. */
  dailyCostCapCents: number;
  /** Per-tenant kill switch (operator/owner "stop everything now"). */
  killedAt: Date | null;
  updatedAt: Date;
}

export interface WebchatConfigPatch {
  enabled?: boolean;
  allowedOrigins?: string[];
  dailyTurnCap?: number;
  dailyCostCapCents?: number;
  killed?: boolean;
}

export interface WebchatConfigRepository {
  get(tenantId: string): Promise<WebchatConfig | null>;
  /** Insert-or-update; mints the embed token on first write. */
  upsert(tenantId: string, patch: WebchatConfigPatch): Promise<WebchatConfig>;
  /** New embed token; the old snippet stops working immediately. */
  rotateToken(tenantId: string): Promise<WebchatConfig>;
}

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mintEmbedToken(tenantId: string): string {
  return `${tenantId}.${randomBytes(12).toString('hex')}`;
}

/** The tenant id inside a token, or null when the shape is wrong. */
export function tenantIdFromToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const dot = token.indexOf('.');
  if (dot !== 36) return null;
  const tenantId = token.slice(0, dot);
  return TENANT_UUID.test(tenantId) && /^[0-9a-f]{24}$/.test(token.slice(dot + 1))
    ? tenantId.toLowerCase()
    : null;
}

export function tokenMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Normalize one allowed origin: scheme + host (+ port), lowercase, no path.
 * `https://*.example.com` allows any subdomain. Null when unusable. Plain
 * `http` is accepted only for localhost (development embeds).
 */
export function normalizeOrigin(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const wildcard = value.startsWith('https://*.');
  try {
    const url = new URL(wildcard ? value.replace('*.', 'wildcard.') : value);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null;
    // Scheme + host only; a single trailing slash is tolerated.
    if (!/^https?:\/\/[^/?#@]+\/?$/.test(value)) return null;
    const host = wildcard ? url.host.replace('wildcard.', '*.') : url.host;
    if (wildcard && host.split('.').length < 3) return null; // `*.com` is not a site
    return `${url.protocol}//${host}`;
  } catch {
    return null;
  }
}

export function normalizeOrigins(raw: readonly string[]): { origins: string[]; rejected: string[] } {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeOrigin(entry);
    if (normalized === null) rejected.push(entry);
    else if (!origins.includes(normalized)) origins.push(normalized);
  }
  return { origins, rejected };
}

/** Exact match, or `https://*.example.com` matching a subdomain. Empty list denies. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  return allowed.some((entry) => {
    if (entry === normalized) return true;
    const star = entry.indexOf('*.');
    if (star === -1) return false;
    const scheme = entry.slice(0, star); // "https://"
    const suffix = entry.slice(star + 1); // ".example.com"
    return (
      normalized.startsWith(scheme) &&
      normalized.endsWith(suffix) &&
      normalized.length > scheme.length + suffix.length
    );
  });
}

function applyPatch(base: WebchatConfig, patch: WebchatConfigPatch, now: Date): WebchatConfig {
  return {
    ...base,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.allowedOrigins !== undefined ? { allowedOrigins: patch.allowedOrigins } : {}),
    ...(patch.dailyTurnCap !== undefined ? { dailyTurnCap: patch.dailyTurnCap } : {}),
    ...(patch.dailyCostCapCents !== undefined ? { dailyCostCapCents: patch.dailyCostCapCents } : {}),
    ...(patch.killed !== undefined ? { killedAt: patch.killed ? now : null } : {}),
    updatedAt: now,
  };
}

function freshConfig(tenantId: string, now: Date): WebchatConfig {
  return {
    tenantId,
    enabled: false,
    embedToken: mintEmbedToken(tenantId),
    allowedOrigins: [],
    dailyTurnCap: DEFAULT_DAILY_TURN_CAP,
    dailyCostCapCents: DEFAULT_DAILY_COST_CAP_CENTS,
    killedAt: null,
    updatedAt: now,
  };
}

export class InMemoryWebchatConfigRepository implements WebchatConfigRepository {
  private readonly rows = new Map<string, WebchatConfig>();

  async get(tenantId: string): Promise<WebchatConfig | null> {
    const row = this.rows.get(tenantId);
    return row ? { ...row, allowedOrigins: [...row.allowedOrigins] } : null;
  }

  async upsert(tenantId: string, patch: WebchatConfigPatch): Promise<WebchatConfig> {
    const now = new Date();
    const next = applyPatch(this.rows.get(tenantId) ?? freshConfig(tenantId, now), patch, now);
    this.rows.set(tenantId, next);
    return (await this.get(tenantId))!;
  }

  async rotateToken(tenantId: string): Promise<WebchatConfig> {
    const now = new Date();
    const base = this.rows.get(tenantId) ?? freshConfig(tenantId, now);
    this.rows.set(tenantId, { ...base, embedToken: mintEmbedToken(tenantId), updatedAt: now });
    return (await this.get(tenantId))!;
  }
}

interface ConfigRow {
  tenant_id: string;
  enabled: boolean;
  embed_token: string;
  allowed_origins: string[];
  daily_turn_cap: number;
  daily_cost_cap_cents: number;
  killed_at: Date | null;
  updated_at: Date;
}

function fromRow(row: ConfigRow): WebchatConfig {
  return {
    tenantId: row.tenant_id,
    enabled: row.enabled,
    embedToken: row.embed_token,
    allowedOrigins: row.allowed_origins ?? [],
    dailyTurnCap: row.daily_turn_cap,
    dailyCostCapCents: row.daily_cost_cap_cents,
    killedAt: row.killed_at,
    updatedAt: row.updated_at,
  };
}

export class PgWebchatConfigRepository extends PgBaseRepository implements WebchatConfigRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async get(tenantId: string): Promise<WebchatConfig | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ConfigRow>(
        `SELECT * FROM webchat_config WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    });
  }

  async upsert(tenantId: string, patch: WebchatConfigPatch): Promise<WebchatConfig> {
    const current = (await this.get(tenantId)) ?? freshConfig(tenantId, new Date());
    const next = applyPatch(current, patch, new Date());
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ConfigRow>(
        `INSERT INTO webchat_config
           (tenant_id, enabled, embed_token, allowed_origins, daily_turn_cap,
            daily_cost_cap_cents, killed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           allowed_origins = EXCLUDED.allowed_origins,
           daily_turn_cap = EXCLUDED.daily_turn_cap,
           daily_cost_cap_cents = EXCLUDED.daily_cost_cap_cents,
           killed_at = EXCLUDED.killed_at,
           updated_at = NOW()
         RETURNING *`,
        [
          tenantId,
          next.enabled,
          next.embedToken,
          next.allowedOrigins,
          next.dailyTurnCap,
          next.dailyCostCapCents,
          next.killedAt,
        ],
      );
      return fromRow(result.rows[0]!);
    });
  }

  async rotateToken(tenantId: string): Promise<WebchatConfig> {
    await this.upsert(tenantId, {});
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ConfigRow>(
        `UPDATE webchat_config SET embed_token = $2, updated_at = NOW()
          WHERE tenant_id = $1 RETURNING *`,
        [tenantId, mintEmbedToken(tenantId)],
      );
      return fromRow(result.rows[0]!);
    });
  }
}
