import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';
import { UserRole } from './user';

/**
 * Tier 4 (Team members — PR 3). Pending invitation = a teammate the
 * tenant has invited via Clerk who hasn't accepted yet. Once they
 * accept the Clerk webhook fires user.created; the handler looks up
 * a pending invitation by email + tenant_id, marks it accepted, and
 * adds the corresponding `users` row.
 */

export interface PendingInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  /** Clerk-side invitation id. Nullable when running without
   *  CLERK_SECRET_KEY (dev/test path) so the row still records intent. */
  clerkInvitationId?: string | null;
  /** Clerk subject of the inviter. Stored as a string (not FK to users.id)
   *  so we can audit even if the inviter is later removed from the team. */
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date | null;
}

export interface CreateInvitationInput {
  tenantId: string;
  email: string;
  role: UserRole;
  invitedBy: string;
  clerkInvitationId?: string | null;
  /** Defaults to 14 days; tests override to exercise expiry. */
  expiresAt?: Date;
}

export interface PendingInvitationListOptions {
  /** When true, also include accepted invitations. Defaults to false
   *  (the UI shows pending only). */
  includeAccepted?: boolean;
}

export interface PendingInvitationRepository {
  create(input: CreateInvitationInput): Promise<PendingInvitation>;
  findByTenant(
    tenantId: string,
    options?: PendingInvitationListOptions,
  ): Promise<PendingInvitation[]>;
  /** Used by the Clerk webhook to attach a sign-up to its invitation. */
  findPendingByEmail(email: string): Promise<PendingInvitation | null>;
  markAccepted(id: string): Promise<PendingInvitation | null>;
  /** Optional — used by DELETE /api/users/invitations/:id (out of
   *  scope for the first PR; left here for the next slice). */
  delete?(tenantId: string, id: string): Promise<boolean>;
}

const DEFAULT_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateInvitationInput(input: CreateInvitationInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.email || !EMAIL_RE.test(input.email)) errors.push('valid email is required');
  if (input.email && input.email.length > 320) errors.push('email is too long');
  if (!['owner', 'dispatcher', 'technician'].includes(input.role)) {
    errors.push('role is invalid');
  }
  if (!input.invitedBy) errors.push('invitedBy is required');
  return errors;
}

export class InMemoryPendingInvitationRepository implements PendingInvitationRepository {
  private rows: Map<string, PendingInvitation> = new Map();

  async create(input: CreateInvitationInput): Promise<PendingInvitation> {
    const errors = validateInvitationInput(input);
    if (errors.length > 0) {
      throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
    }
    // Enforce single pending invite per (tenant, email).
    const existing = await this.findPendingByEmailInTenant(input.tenantId, input.email);
    if (existing) {
      throw new ValidationError('A pending invitation already exists for this email');
    }
    const now = new Date();
    const row: PendingInvitation = {
      id: uuidv4(),
      tenantId: input.tenantId,
      email: input.email.toLowerCase(),
      role: input.role,
      clerkInvitationId: input.clerkInvitationId ?? null,
      invitedBy: input.invitedBy,
      createdAt: now,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + DEFAULT_EXPIRY_MS),
      acceptedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findByTenant(
    tenantId: string,
    options?: PendingInvitationListOptions,
  ): Promise<PendingInvitation[]> {
    const all = Array.from(this.rows.values()).filter((r) => r.tenantId === tenantId);
    const filtered = options?.includeAccepted ? all : all.filter((r) => !r.acceptedAt);
    return filtered
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async findPendingByEmail(email: string): Promise<PendingInvitation | null> {
    const lc = email.toLowerCase();
    for (const row of this.rows.values()) {
      if (row.email === lc && !row.acceptedAt) return { ...row };
    }
    return null;
  }

  private async findPendingByEmailInTenant(
    tenantId: string,
    email: string,
  ): Promise<PendingInvitation | null> {
    const lc = email.toLowerCase();
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.email === lc && !row.acceptedAt) {
        return { ...row };
      }
    }
    return null;
  }

  async markAccepted(id: string): Promise<PendingInvitation | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated = { ...row, acceptedAt: new Date() };
    this.rows.set(id, updated);
    return { ...updated };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    this.rows.delete(id);
    return true;
  }
}
