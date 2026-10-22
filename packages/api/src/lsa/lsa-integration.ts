/**
 * #1738 — Google Local Services Ads (LSA) lead intake: per-tenant linking.
 *
 * First slice: linking is a per-tenant webhook secret, not Google OAuth. The
 * LSA lead API is a pull API that needs a Google Ads manager credential we do
 * not hold, so an owner (or a relay such as a lead-email forwarder / a Zapier
 * zap / a future poller) POSTs leads to `/webhooks/lsa/:tenantId`,
 * authenticated with this secret. The OAuth path (reusing
 * reputation/google-business-integration.ts) is a follow-up that would
 * replace the relay with a poller feeding the same ingest handler.
 *
 * OFF by default: a tenant has no row until an owner links; `autoRespond`
 * (the speed-to-lead first-response text) starts false and is only ever
 * flipped by the owner.
 */
import { randomBytes } from 'crypto';

export const LSA_LEAD_TYPES = ['phone_call', 'message', 'booking'] as const;
export type LsaLeadType = (typeof LSA_LEAD_TYPES)[number];

export const LSA_DISPOSITIONS = ['booked', 'not_booked', 'spam'] as const;
export type LsaDisposition = (typeof LSA_DISPOSITIONS)[number];

export interface LsaIntegration {
  id: string;
  tenantId: string;
  enabled: boolean;
  /** Owner opt-in for the speed-to-lead first-response text on LSA leads. */
  autoRespond: boolean;
  /** Last 4 chars of the secret, so the owner can tell which one is live. */
  secretHint: string;
  /** Optional Google LSA account / customer id, display + attribution only. */
  accountId?: string;
  linkedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LsaLeadRecord {
  id: string;
  tenantId: string;
  externalLeadId: string;
  leadId: string;
  leadType: LsaLeadType;
  receivedAt: Date;
  speedToLeadOutcome?: string;
  disposition?: LsaDisposition;
  dispositionReportedAt?: Date;
}

export interface LinkLsaInput {
  tenantId: string;
  linkedBy: string;
  accountId?: string;
}

export interface LsaIntegrationRepository {
  get(tenantId: string): Promise<LsaIntegration | null>;
  /** Plaintext webhook secret, for signature verification only. */
  getWebhookSecret(tenantId: string): Promise<string | null>;
  /**
   * Create the link, or rotate the secret of an existing one (settings are
   * kept; `enabled` is set true — linking is the owner's explicit opt-in).
   * Returns the plaintext secret exactly once.
   */
  link(input: LinkLsaInput): Promise<{ integration: LsaIntegration; webhookSecret: string }>;
  update(
    tenantId: string,
    patch: { enabled?: boolean; autoRespond?: boolean; accountId?: string | null },
  ): Promise<LsaIntegration | null>;
  unlink(tenantId: string): Promise<boolean>;
  /** Idempotent insert keyed on (tenant, external lead id); `inserted=false` on replay. */
  recordLead(
    rec: Omit<LsaLeadRecord, 'id' | 'receivedAt'>,
  ): Promise<{ inserted: boolean; record: LsaLeadRecord }>;
  setSpeedToLeadOutcome(tenantId: string, externalLeadId: string, outcome: string): Promise<void>;
  findLeadByLeadId(tenantId: string, leadId: string): Promise<LsaLeadRecord | null>;
  markDisposition(
    tenantId: string,
    externalLeadId: string,
    disposition: LsaDisposition,
    reported: boolean,
  ): Promise<void>;
  listRecent(tenantId: string, limit: number): Promise<LsaLeadRecord[]>;
}

export function generateLsaWebhookSecret(): string {
  return `lsa_${randomBytes(24).toString('hex')}`;
}

export function secretHint(secret: string): string {
  return secret.slice(-4);
}

export class InMemoryLsaIntegrationRepository implements LsaIntegrationRepository {
  private integrations = new Map<string, LsaIntegration & { secret: string }>();
  private leads: LsaLeadRecord[] = [];
  private seq = 0;

  async get(tenantId: string): Promise<LsaIntegration | null> {
    const row = this.integrations.get(tenantId);
    if (!row) return null;
    const { secret: _secret, ...view } = row;
    return { ...view };
  }

  async getWebhookSecret(tenantId: string): Promise<string | null> {
    return this.integrations.get(tenantId)?.secret ?? null;
  }

  async link(input: LinkLsaInput) {
    const secret = generateLsaWebhookSecret();
    const now = new Date();
    const prev = this.integrations.get(input.tenantId);
    const row = {
      id: prev?.id ?? `lsa-int-${++this.seq}`,
      tenantId: input.tenantId,
      enabled: true,
      autoRespond: prev?.autoRespond ?? false,
      secretHint: secretHint(secret),
      accountId: input.accountId ?? prev?.accountId,
      linkedBy: input.linkedBy,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      secret,
    };
    this.integrations.set(input.tenantId, row);
    const { secret: _s, ...view } = row;
    return { integration: view, webhookSecret: secret };
  }

  async update(
    tenantId: string,
    patch: { enabled?: boolean; autoRespond?: boolean; accountId?: string | null },
  ) {
    const row = this.integrations.get(tenantId);
    if (!row) return null;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.autoRespond !== undefined) row.autoRespond = patch.autoRespond;
    if (patch.accountId !== undefined) row.accountId = patch.accountId ?? undefined;
    row.updatedAt = new Date();
    return this.get(tenantId);
  }

  async unlink(tenantId: string): Promise<boolean> {
    return this.integrations.delete(tenantId);
  }

  async recordLead(rec: Omit<LsaLeadRecord, 'id' | 'receivedAt'>) {
    const existing = this.leads.find(
      (l) => l.tenantId === rec.tenantId && l.externalLeadId === rec.externalLeadId,
    );
    if (existing) return { inserted: false, record: { ...existing } };
    const record: LsaLeadRecord = { ...rec, id: `lsa-lead-${++this.seq}`, receivedAt: new Date() };
    this.leads.push(record);
    return { inserted: true, record: { ...record } };
  }

  async setSpeedToLeadOutcome(tenantId: string, externalLeadId: string, outcome: string) {
    const l = this.leads.find((x) => x.tenantId === tenantId && x.externalLeadId === externalLeadId);
    if (l) l.speedToLeadOutcome = outcome;
  }

  async findLeadByLeadId(tenantId: string, leadId: string) {
    const l = this.leads.find((x) => x.tenantId === tenantId && x.leadId === leadId);
    return l ? { ...l } : null;
  }

  async markDisposition(
    tenantId: string,
    externalLeadId: string,
    disposition: LsaDisposition,
    reported: boolean,
  ) {
    const l = this.leads.find((x) => x.tenantId === tenantId && x.externalLeadId === externalLeadId);
    if (!l) return;
    l.disposition = disposition;
    if (reported) l.dispositionReportedAt = new Date();
  }

  async listRecent(tenantId: string, limit: number) {
    return this.leads
      .filter((l) => l.tenantId === tenantId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, limit)
      .map((l) => ({ ...l }));
  }
}
