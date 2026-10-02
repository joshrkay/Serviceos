// #1564 — persistence port for a tenant's A2P 10DLC registration.

import type { A2pBusinessDetails, A2pRegistrationProgress } from './registration';
import { initialA2pProgress } from './registration';

/** The owner-entered details as stored: the EIN only as ciphertext + last 4. */
export type A2pStoredDetails = Omit<A2pBusinessDetails, 'ein'>;

export interface A2pRegistrationRecord {
  tenantId: string;
  details: A2pStoredDetails;
  /** TENANT_ENCRYPTION_KEY ciphertext ("iv:ct:tag") of the 9-digit EIN. */
  einEnc: string;
  einLast4: string;
  progress: A2pRegistrationProgress;
  submittedAt: Date;
  approvedAt: Date | null;
  lastCheckedAt: Date | null;
  updatedAt: Date;
}

export interface A2pRegistrationStore {
  get(tenantId: string): Promise<A2pRegistrationRecord | null>;
  /** Upserts the owner's details and restarts the registration from scratch. */
  saveSubmission(
    tenantId: string,
    input: { details: A2pStoredDetails; einEnc: string; einLast4: string },
  ): Promise<A2pRegistrationRecord>;
  saveProgress(tenantId: string, progress: A2pRegistrationProgress): Promise<void>;
}

export class InMemoryA2pRegistrationStore implements A2pRegistrationStore {
  private rows = new Map<string, A2pRegistrationRecord>();

  async get(tenantId: string): Promise<A2pRegistrationRecord | null> {
    const row = this.rows.get(tenantId);
    return row ? structuredClone(row) : null;
  }

  async saveSubmission(
    tenantId: string,
    input: { details: A2pStoredDetails; einEnc: string; einLast4: string },
  ): Promise<A2pRegistrationRecord> {
    const now = new Date();
    const row: A2pRegistrationRecord = {
      tenantId,
      details: structuredClone(input.details),
      einEnc: input.einEnc,
      einLast4: input.einLast4,
      progress: initialA2pProgress(),
      submittedAt: now,
      approvedAt: null,
      lastCheckedAt: null,
      updatedAt: now,
    };
    this.rows.set(tenantId, row);
    return structuredClone(row);
  }

  async saveProgress(tenantId: string, progress: A2pRegistrationProgress): Promise<void> {
    const row = this.rows.get(tenantId);
    if (!row) return;
    const now = new Date();
    row.progress = structuredClone(progress);
    row.lastCheckedAt = now;
    row.updatedAt = now;
    if (progress.status === 'approved' && !row.approvedAt) row.approvedAt = now;
  }
}
