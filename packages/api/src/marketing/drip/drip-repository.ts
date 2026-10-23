import { v4 as uuidv4 } from 'uuid';
import type {
  DripChannel,
  DripEnrollment,
  DripExitReason,
  DripSequence,
  DripSequenceStatus,
  DripSourceEntityType,
  DripTargetKind,
} from './sequence';

/**
 * #1735 — persistence ports for drip campaigns. The Postgres adapter is
 * pg-drip-repository.ts; the in-memory one below backs unit tests and dev.
 */

/** A customer a sequence's targeting rule picked, with what made them eligible. */
export interface DripTarget {
  customerId: string;
  sourceEntityType: DripSourceEntityType | null;
  sourceEntityId: string | null;
  /**
   * Membership renewals: the membership's end date (YYYY-MM-DD) when it was
   * targeted, kept on the enrollment so any later extension reads as renewed.
   */
  sourceDueOn?: string | null;
}

export interface DripBooking {
  appointmentId: string;
  bookedAt: Date;
}

export interface DripStepEventInput {
  tenantId: string;
  enrollmentId: string;
  stepIndex: number;
  channel: DripChannel;
  outcome: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

export interface DripSequenceStats {
  sequenceId: string;
  enrolled: number;
  active: number;
  completed: number;
  /** Enrollments a booking is credited to (the attribution). */
  booked: number;
}

export interface DripEnrollmentUpdate {
  status: DripEnrollment['status'];
  exitReason: DripExitReason | null;
  currentStep: number;
  stepAttempts: number;
  nextRunAt: Date;
  finishedAt: Date | null;
}

export interface DripRepository {
  createSequence(sequence: DripSequence): Promise<DripSequence>;
  findSequence(tenantId: string, id: string): Promise<DripSequence | null>;
  listSequences(tenantId: string): Promise<DripSequence[]>;
  setSequenceStatus(tenantId: string, id: string, status: DripSequenceStatus): Promise<DripSequence | null>;
  stats(tenantId: string): Promise<DripSequenceStats[]>;

  /** Inserts one enrollment per (sequence, customer); an existing one is left alone. Returns the count newly enrolled. */
  enroll(tenantId: string, sequenceId: string, targets: DripTarget[], firstRunAt: Date): Promise<number>;
  /** Active enrollments of ACTIVE sequences whose next_run_at has passed, oldest first. */
  listDue(tenantId: string, now: Date, limit: number): Promise<DripEnrollment[]>;
  /**
   * Single-flight lease: pushes next_run_at to `leaseUntil` only if the
   * enrollment is still active and due. False when another worker got it.
   */
  claim(tenantId: string, id: string, now: Date, leaseUntil: Date): Promise<boolean>;
  updateEnrollment(tenantId: string, id: string, update: DripEnrollmentUpdate): Promise<void>;
  recordBooking(tenantId: string, id: string, booking: DripBooking): Promise<void>;
  /** Finished enrollments, with no booking credited yet, that finished within the attribution window. */
  listAttributionCandidates(tenantId: string, since: Date, limit: number): Promise<DripEnrollment[]>;
  addStepEvent(event: DripStepEventInput): Promise<void>;
}

/** Targeting + exit-condition reads that cross into other modules' tables. */
export interface DripSignals {
  findTargets(
    tenantId: string,
    kind: DripTargetKind,
    days: number,
    now: Date,
    limit: number,
    /** Customers already enrolled in this sequence are excluded before `limit` applies. */
    sequenceId: string,
  ): Promise<DripTarget[]>;
  /** First non-cancelled appointment booked for the customer's jobs after `since`. */
  findBookingSince(tenantId: string, customerId: string, since: Date): Promise<DripBooking | null>;
  /** True when the customer texted us after `since`. */
  hasRepliedSince(tenantId: string, customerId: string, since: Date): Promise<boolean>;
  /**
   * Membership renewals: true once the enrollment's customer no longer needs
   * reminding: the enrolled membership (or one started after enrollment) is
   * active and auto-renewing, open-ended, or now ends after the end date it
   * had when targeted.
   */
  hasRenewedMembership(tenantId: string, enrollmentId: string): Promise<boolean>;
}

export class InMemoryDripRepository implements DripRepository {
  readonly sequences = new Map<string, DripSequence>();
  readonly enrollments = new Map<string, DripEnrollment>();
  readonly stepEvents: DripStepEventInput[] = [];

  async createSequence(sequence: DripSequence): Promise<DripSequence> {
    this.sequences.set(sequence.id, structuredClone(sequence));
    return structuredClone(sequence);
  }

  async findSequence(tenantId: string, id: string): Promise<DripSequence | null> {
    const s = this.sequences.get(id);
    return s && s.tenantId === tenantId ? structuredClone(s) : null;
  }

  async listSequences(tenantId: string): Promise<DripSequence[]> {
    return [...this.sequences.values()]
      .filter((s) => s.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => structuredClone(s));
  }

  async setSequenceStatus(
    tenantId: string,
    id: string,
    status: DripSequenceStatus,
  ): Promise<DripSequence | null> {
    const s = this.sequences.get(id);
    if (!s || s.tenantId !== tenantId) return null;
    s.status = status;
    s.updatedAt = new Date();
    return structuredClone(s);
  }

  async stats(tenantId: string): Promise<DripSequenceStats[]> {
    return [...this.sequences.values()]
      .filter((s) => s.tenantId === tenantId)
      .map((s) => {
        const rows = [...this.enrollments.values()].filter((e) => e.sequenceId === s.id);
        return {
          sequenceId: s.id,
          enrolled: rows.length,
          active: rows.filter((e) => e.status === 'active').length,
          completed: rows.filter((e) => e.status === 'completed').length,
          booked: rows.filter((e) => e.bookedAt !== null).length,
        };
      });
  }

  async enroll(
    tenantId: string,
    sequenceId: string,
    targets: DripTarget[],
    firstRunAt: Date,
  ): Promise<number> {
    let added = 0;
    for (const t of targets) {
      const exists = [...this.enrollments.values()].some(
        (e) => e.tenantId === tenantId && e.sequenceId === sequenceId && e.customerId === t.customerId,
      );
      if (exists) continue;
      const id = uuidv4();
      this.enrollments.set(id, {
        id,
        tenantId,
        sequenceId,
        customerId: t.customerId,
        sourceEntityType: t.sourceEntityType,
        sourceEntityId: t.sourceEntityId,
        status: 'active',
        exitReason: null,
        currentStep: 0,
        stepAttempts: 0,
        nextRunAt: firstRunAt,
        enrolledAt: new Date(),
        finishedAt: null,
        bookedAt: null,
        bookedAppointmentId: null,
      });
      added += 1;
    }
    return added;
  }

  async listDue(tenantId: string, now: Date, limit: number): Promise<DripEnrollment[]> {
    return [...this.enrollments.values()]
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.status === 'active' &&
          e.nextRunAt.getTime() <= now.getTime() &&
          this.sequences.get(e.sequenceId)?.status === 'active',
      )
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  async claim(tenantId: string, id: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const e = this.enrollments.get(id);
    if (!e || e.tenantId !== tenantId || e.status !== 'active' || e.nextRunAt.getTime() > now.getTime()) {
      return false;
    }
    e.nextRunAt = leaseUntil;
    return true;
  }

  async updateEnrollment(tenantId: string, id: string, update: DripEnrollmentUpdate): Promise<void> {
    const e = this.enrollments.get(id);
    if (!e || e.tenantId !== tenantId) return;
    Object.assign(e, update);
  }

  async recordBooking(tenantId: string, id: string, booking: DripBooking): Promise<void> {
    const e = this.enrollments.get(id);
    if (!e || e.tenantId !== tenantId) return;
    e.bookedAt = booking.bookedAt;
    e.bookedAppointmentId = booking.appointmentId;
  }

  async listAttributionCandidates(tenantId: string, since: Date, limit: number): Promise<DripEnrollment[]> {
    return [...this.enrollments.values()]
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.status !== 'active' &&
          e.bookedAt === null &&
          e.finishedAt !== null &&
          e.finishedAt.getTime() >= since.getTime(),
      )
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  async addStepEvent(event: DripStepEventInput): Promise<void> {
    this.stepEvents.push({ ...event });
  }
}
