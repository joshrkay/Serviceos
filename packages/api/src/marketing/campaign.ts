import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { Customer, CustomerRepository } from '../customers/customer';
import { TagRepository } from '../customers/tag';
import { MessageDeliveryProvider } from '../notifications/delivery-provider';

/**
 * MKT (Jobber parity) — customer email campaigns.
 *
 * Jobber's marketing suite sends segmented email/postcard campaigns; this is
 * the email-campaign core: compose a message, target all active customers or a
 * tag segment, and send via the existing delivery provider. Recipient
 * resolution is a pure function so targeting is unit-testable; sending is
 * provider-agnostic (the MessageDeliveryProvider abstraction).
 */

export type CampaignStatus = 'draft' | 'sent';

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** null = all active customers; otherwise customers carrying this tag. */
  segmentTag: string | null;
  status: CampaignStatus;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  createdBy: string;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCampaignInput {
  tenantId: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  segmentTag?: string | null;
  createdBy: string;
  actorRole?: string;
}

export interface CampaignRepository {
  create(campaign: Campaign): Promise<Campaign>;
  findById(tenantId: string, id: string): Promise<Campaign | null>;
  list(tenantId: string): Promise<Campaign[]>;
  update(campaign: Campaign): Promise<Campaign>;
}

export function validateCampaignInput(input: {
  name?: string;
  subject?: string;
  bodyText?: string;
}): string[] {
  const errors: string[] = [];
  if (!input.name || !input.name.trim()) errors.push('name is required');
  if (!input.subject || !input.subject.trim()) errors.push('subject is required');
  if (!input.bodyText || !input.bodyText.trim()) errors.push('bodyText is required');
  return errors;
}

/** A resolved recipient: a customer with a usable email address. */
export interface CampaignRecipient {
  customerId: string;
  email: string;
  name: string;
}

/**
 * Resolve recipients from a customer set, optionally restricted to a tag's
 * members. Pure: customers with no email are dropped, archived customers are
 * excluded, and each email is de-duplicated (last write wins). Deterministic
 * given inputs — unit-testable without a DB.
 */
export function resolveRecipients(
  customers: Customer[],
  tagMemberIds: Set<string> | null
): CampaignRecipient[] {
  const byEmail = new Map<string, CampaignRecipient>();
  for (const c of customers) {
    if (c.isArchived) continue;
    if (tagMemberIds && !tagMemberIds.has(c.id)) continue;
    const email = c.email?.trim();
    if (!email) continue;
    byEmail.set(email.toLowerCase(), {
      customerId: c.id,
      email,
      name: c.displayName || `${c.firstName} ${c.lastName}`.trim() || 'there',
    });
  }
  return Array.from(byEmail.values());
}

export async function createCampaign(
  input: CreateCampaignInput,
  repository: CampaignRepository,
  auditRepo?: AuditRepository
): Promise<Campaign> {
  const errors = validateCampaignInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  const campaign: Campaign = {
    id: uuidv4(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    subject: input.subject.trim(),
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml?.trim() || null,
    segmentTag: input.segmentTag?.trim() || null,
    status: 'draft',
    recipientCount: 0,
    sentCount: 0,
    failedCount: 0,
    createdBy: input.createdBy,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.create(campaign);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'marketing_campaign.created',
        entityType: 'marketing_campaign',
        entityId: created.id,
        metadata: { name: created.name, segmentTag: created.segmentTag },
      })
    );
  }
  return created;
}

export interface SendCampaignDeps {
  campaignRepo: CampaignRepository;
  customerRepo: CustomerRepository;
  tagRepo: TagRepository;
  delivery: MessageDeliveryProvider;
  auditRepo?: AuditRepository;
}

/**
 * Send a draft campaign to its resolved segment. Each email is sent
 * independently; a per-recipient failure increments failedCount rather than
 * aborting the run. Idempotent at the campaign level: a campaign already in
 * `sent` is returned unchanged (no double-send).
 */
export async function sendCampaign(
  tenantId: string,
  campaignId: string,
  deps: SendCampaignDeps,
  actorId?: string
): Promise<Campaign> {
  const campaign = await deps.campaignRepo.findById(tenantId, campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'sent') return campaign;

  const customers = await deps.customerRepo.findByTenant(tenantId);
  const tagMembers = campaign.segmentTag
    ? new Set(await deps.tagRepo.listCustomerIdsByTag(tenantId, campaign.segmentTag))
    : null;
  const recipients = resolveRecipients(customers, tagMembers);

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    try {
      await deps.delivery.sendEmail({
        to: r.email,
        subject: campaign.subject,
        text: campaign.bodyText,
        html: campaign.bodyHtml ?? undefined,
      });
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  const updated: Campaign = {
    ...campaign,
    status: 'sent',
    recipientCount: recipients.length,
    sentCount: sent,
    failedCount: failed,
    sentAt: new Date(),
    updatedAt: new Date(),
  };
  const saved = await deps.campaignRepo.update(updated);

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actorId ?? campaign.createdBy,
        actorRole: 'unknown',
        eventType: 'marketing_campaign.sent',
        entityType: 'marketing_campaign',
        entityId: saved.id,
        metadata: { recipientCount: saved.recipientCount, sentCount: sent, failedCount: failed },
      })
    );
  }
  return saved;
}

export class InMemoryCampaignRepository implements CampaignRepository {
  private campaigns: Map<string, Campaign> = new Map();

  async create(campaign: Campaign): Promise<Campaign> {
    this.campaigns.set(campaign.id, { ...campaign });
    return { ...campaign };
  }

  async findById(tenantId: string, id: string): Promise<Campaign | null> {
    const c = this.campaigns.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async list(tenantId: string): Promise<Campaign[]> {
    return Array.from(this.campaigns.values())
      .filter((c) => c.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((c) => ({ ...c }));
  }

  async update(campaign: Campaign): Promise<Campaign> {
    this.campaigns.set(campaign.id, { ...campaign });
    return { ...campaign };
  }
}
