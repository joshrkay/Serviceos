import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TechnicianAssignmentNotifier,
  formatAssignmentWhenLabel,
  setTechnicianAssignmentNotifier,
  type UserNotifier,
} from '../../src/appointments/assignment-notifications';
import {
  assignTechnician,
  unassignTechnician,
  InMemoryAssignmentRepository,
} from '../../src/appointments/assignment';
import type { Appointment } from '../../src/appointments/appointment';
import type { Job } from '../../src/jobs/job';
import type { Customer } from '../../src/customers/customer';
import type { User } from '../../src/users/user';

const TENANT = 'tenant-1';
const APPT_ID = 'appt-1';
const JOB_ID = 'job-1';
const CUSTOMER_ID = 'cust-1';
const TECH_ID = 'tech-uuid-1';
const TECH_CLERK = 'clerk-tech-1';

function makeAppointment(over: Partial<Appointment> = {}): Appointment {
  return {
    id: APPT_ID,
    tenantId: TENANT,
    jobId: JOB_ID,
    scheduledStart: new Date('2026-06-23T18:00:00Z'),
    scheduledEnd: new Date('2026-06-23T19:00:00Z'),
    timezone: 'America/New_York',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Appointment;
}

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    summary: 'AC not cooling',
    ...over,
  } as Job;
}

function makeCustomer(over: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    firstName: 'Maria',
    lastName: 'Lopez',
    displayName: 'Maria Lopez',
    ...over,
  } as Customer;
}

function makeUser(over: Partial<User> = {}): User {
  return {
    id: TECH_ID,
    tenantId: TENANT,
    clerkUserId: TECH_CLERK,
    email: 'tech@x.test',
    role: 'technician',
    canFieldServe: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as User;
}

/** A capturing UserNotifier so tests assert what would have been pushed. */
function capturingNotifier() {
  const calls: Array<{ userId: string; type: string; ctx: Record<string, unknown> }> = [];
  const notifier: UserNotifier = {
    async notifyUser(_tenantId, userId, type, ctx) {
      calls.push({ userId, type, ctx: ctx as Record<string, unknown> });
    },
  };
  return { calls, notifier };
}

function buildNotifier(opts: {
  appointment?: Appointment | null;
  job?: Job | null;
  customer?: Customer | null;
  user?: User | null;
  notifier: UserNotifier;
}) {
  return new TechnicianAssignmentNotifier({
    appointmentRepo: { findById: async () => opts.appointment ?? null },
    jobRepo: { findById: async () => opts.job ?? null },
    customerRepo: { findById: async () => opts.customer ?? null },
    userRepo: { findById: async () => opts.user ?? null },
    notifier: opts.notifier,
  });
}

describe('TechnicianAssignmentNotifier', () => {
  it('assigned → pushes appointment_assigned to the tech with customer/time/service', async () => {
    const { calls, notifier } = capturingNotifier();
    const svc = buildNotifier({
      appointment: makeAppointment(),
      job: makeJob(),
      customer: makeCustomer(),
      user: makeUser(),
      notifier,
    });

    await svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'assigned' });

    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe(TECH_CLERK); // resolved from users.id → clerkUserId
    expect(calls[0].type).toBe('appointment_assigned');
    expect(calls[0].ctx).toMatchObject({
      appointmentId: APPT_ID,
      customerName: 'Maria Lopez',
      serviceLabel: 'AC not cooling',
    });
    expect(String(calls[0].ctx.whenLabel)).toContain('Jun 23');
  });

  it('unassigned → pushes appointment_unassigned (no service label)', async () => {
    const { calls, notifier } = capturingNotifier();
    const svc = buildNotifier({
      appointment: makeAppointment(),
      job: makeJob(),
      customer: makeCustomer(),
      user: makeUser(),
      notifier,
    });

    await svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'unassigned' });

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('appointment_unassigned');
    expect(calls[0].ctx).not.toHaveProperty('serviceLabel');
  });

  it('falls back to a generic service label when the job has no summary', async () => {
    const { calls, notifier } = capturingNotifier();
    const svc = buildNotifier({
      appointment: makeAppointment({ appointmentType: undefined }),
      job: makeJob({ summary: '' }),
      customer: makeCustomer(),
      user: makeUser(),
      notifier,
    });

    await svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'assigned' });

    expect(calls[0].ctx.serviceLabel).toBe('Service visit');
  });

  it('uses a generic customer name when the customer cannot be resolved', async () => {
    const { calls, notifier } = capturingNotifier();
    const svc = buildNotifier({
      appointment: makeAppointment(),
      job: makeJob(),
      customer: null,
      user: makeUser(),
      notifier,
    });

    await svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'assigned' });

    expect(calls[0].ctx.customerName).toBe('A customer');
  });

  it('no-op when the technician has no Clerk id (no signed-in device to reach)', async () => {
    const { calls, notifier } = capturingNotifier();
    const svc = buildNotifier({
      appointment: makeAppointment(),
      job: makeJob(),
      customer: makeCustomer(),
      user: makeUser({ clerkUserId: null }),
      notifier,
    });

    await svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'assigned' });
    expect(calls).toHaveLength(0);
  });

  it('no-op when the appointment is gone', async () => {
    const { calls, notifier } = capturingNotifier();
    const svc = buildNotifier({
      appointment: null,
      job: makeJob(),
      customer: makeCustomer(),
      user: makeUser(),
      notifier,
    });

    await svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'assigned' });
    expect(calls).toHaveLength(0);
  });

  it('never throws when the notifier itself fails (assignment write must be unaffected)', async () => {
    const svc = buildNotifier({
      appointment: makeAppointment(),
      job: makeJob(),
      customer: makeCustomer(),
      user: makeUser(),
      notifier: {
        async notifyUser() {
          throw new Error('push gateway down');
        },
      },
    });

    await expect(
      svc.notifyChange({ tenantId: TENANT, appointmentId: APPT_ID, technicianId: TECH_ID, kind: 'assigned' }),
    ).resolves.toBeUndefined();
  });
});

describe('formatAssignmentWhenLabel', () => {
  it('renders the instant in the appointment display timezone', () => {
    // 18:00 UTC is 14:00 (2 PM) in America/New_York (EDT, June).
    const label = formatAssignmentWhenLabel(new Date('2026-06-23T18:00:00Z'), 'America/New_York');
    expect(label).toContain('2:00');
    expect(label).toContain('PM');
  });

  it('falls back to UTC for an invalid timezone instead of throwing', () => {
    expect(() => formatAssignmentWhenLabel(new Date('2026-06-23T18:00:00Z'), 'Not/AZone')).not.toThrow();
  });
});

describe('assignTechnician / unassignTechnician → notification wiring', () => {
  afterEach(() => {
    setTechnicianAssignmentNotifier(undefined); // never leak the global between tests
  });

  beforeEach(() => {
    setTechnicianAssignmentNotifier(undefined);
  });

  it('assignTechnician fires an "assigned" notification through the registered notifier', async () => {
    const { calls, notifier } = capturingNotifier();
    setTechnicianAssignmentNotifier(
      buildNotifier({
        appointment: makeAppointment(),
        job: makeJob(),
        customer: makeCustomer(),
        user: makeUser(),
        notifier,
      }),
    );

    const repo = new InMemoryAssignmentRepository();
    await assignTechnician(
      {
        tenantId: TENANT,
        appointmentId: APPT_ID,
        technicianId: TECH_ID,
        technicianRole: 'technician',
        assignedBy: 'dispatcher-1',
      },
      repo,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('appointment_assigned');
    expect(calls[0].userId).toBe(TECH_CLERK);
  });

  it('unassignTechnician fires an "unassigned" notification when ids are supplied', async () => {
    const { calls, notifier } = capturingNotifier();
    setTechnicianAssignmentNotifier(
      buildNotifier({
        appointment: makeAppointment(),
        job: makeJob(),
        customer: makeCustomer(),
        user: makeUser(),
        notifier,
      }),
    );

    const repo = new InMemoryAssignmentRepository();
    const created = await repo.create({
      id: 'assignment-1',
      tenantId: TENANT,
      appointmentId: APPT_ID,
      technicianId: TECH_ID,
      isPrimary: true,
      assignedBy: 'dispatcher-1',
      assignedAt: new Date(),
    });

    await unassignTechnician(TENANT, created.id, repo, {
      appointmentId: APPT_ID,
      technicianId: TECH_ID,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('appointment_unassigned');
  });

  it('does nothing (no throw) when no notifier is registered', async () => {
    const repo = new InMemoryAssignmentRepository();
    await expect(
      assignTechnician(
        {
          tenantId: TENANT,
          appointmentId: APPT_ID,
          technicianId: TECH_ID,
          technicianRole: 'technician',
          assignedBy: 'dispatcher-1',
        },
        repo,
      ),
    ).resolves.toBeDefined();
  });
});
