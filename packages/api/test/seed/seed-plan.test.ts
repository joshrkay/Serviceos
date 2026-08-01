import { describe, it, expect } from 'vitest';
import { generateSeedPlan, planAppointmentSlot } from '../../src/seed/seed-plan';

const FIXED_START = new Date('2026-07-01T00:00:00Z');

describe('generateSeedPlan', () => {
  it('defaults to 200 customers, estimates, and appointments across 10 tenants', () => {
    const plan = generateSeedPlan({ startDate: FIXED_START });
    expect(plan.totals).toEqual({
      tenants: 10,
      customers: 200,
      estimates: 200,
      appointments: 200,
    });
    expect(plan.tenants).toHaveLength(10);
    for (const tenant of plan.tenants) {
      expect(tenant.entities).toHaveLength(20);
    }
    const allEntities = plan.tenants.flatMap((t) => t.entities);
    expect(allEntities).toHaveLength(200);
    // One estimate + one appointment per customer.
    expect(allEntities.filter((e) => e.estimate)).toHaveLength(200);
    expect(allEntities.filter((e) => e.appointment)).toHaveLength(200);
  });

  it('places every appointment on a SEPARATE day at a SEPARATE time', () => {
    const plan = generateSeedPlan({ startDate: FIXED_START });
    const appts = plan.tenants.flatMap((t) => t.entities.map((e) => e.appointment));

    // No two appointments share a start instant…
    const startInstants = appts.map((a) => a.scheduledStart.getTime());
    expect(new Set(startInstants).size).toBe(appts.length);

    // …nor a calendar day (each on its own date).
    const days = appts.map((a) => a.scheduledStart.toISOString().slice(0, 10));
    expect(new Set(days).size).toBe(appts.length);

    // Times-of-day are spread across business hours (not all identical).
    const hours = new Set(appts.map((a) => a.scheduledStart.getUTCHours()));
    expect(hours.size).toBeGreaterThan(1);
    for (const a of appts) {
      const h = a.scheduledStart.getUTCHours();
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThan(16);
    }
  });

  it('gives every appointment an end after its start (default 60 min)', () => {
    const plan = generateSeedPlan({ startDate: FIXED_START });
    for (const e of plan.tenants.flatMap((t) => t.entities)) {
      const a = e.appointment;
      expect(a.scheduledEnd.getTime() - a.scheduledStart.getTime()).toBe(60 * 60_000);
      expect(a.scheduledEnd.getTime()).toBeGreaterThan(a.scheduledStart.getTime());
    }
  });

  it('produces globally-unique customer emails, phones, and estimate numbers', () => {
    const plan = generateSeedPlan({ startDate: FIXED_START });
    const entities = plan.tenants.flatMap((t) => t.entities);
    const emails = entities.map((e) => e.customer.email);
    const phones = entities.map((e) => e.customer.primaryPhone);
    const estNumbers = entities.map((e) => e.estimate.estimateNumber);
    expect(new Set(emails).size).toBe(200);
    expect(new Set(phones).size).toBe(200);
    expect(new Set(estNumbers).size).toBe(200);
  });

  it('every estimate carries at least one positive-priced line item', () => {
    const plan = generateSeedPlan({ startDate: FIXED_START });
    for (const e of plan.tenants.flatMap((t) => t.entities)) {
      expect(e.estimate.lineItems.length).toBeGreaterThan(0);
      for (const li of e.estimate.lineItems) {
        expect(li.quantity).toBeGreaterThan(0);
        expect(li.unitPriceCents).toBeGreaterThan(0);
      }
    }
  });

  it('honours custom counts (e.g. 3 tenants × 5 = 15 of each)', () => {
    const plan = generateSeedPlan({ tenantCount: 3, customersPerTenant: 5, startDate: FIXED_START });
    expect(plan.totals).toEqual({ tenants: 3, customers: 15, estimates: 15, appointments: 15 });
    const appts = plan.tenants.flatMap((t) => t.entities.map((e) => e.appointment));
    expect(new Set(appts.map((a) => a.scheduledStart.getTime())).size).toBe(15);
  });

  it('planAppointmentSlot is deterministic and day-distinct for consecutive indices', () => {
    const a0 = planAppointmentSlot(0, FIXED_START, 60, 'UTC');
    const a1 = planAppointmentSlot(1, FIXED_START, 60, 'UTC');
    expect(a0.scheduledStart.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(a1.scheduledStart.toISOString().slice(0, 10)).toBe('2026-07-02');
    expect(a1.scheduledStart.getTime()).toBeGreaterThan(a0.scheduledStart.getTime());
  });

  it('derives a future default startDate when none is given', () => {
    const now = new Date('2026-06-20T13:30:00Z');
    const plan = generateSeedPlan({ now, tenantCount: 1, customersPerTenant: 1 });
    const first = plan.tenants[0].entities[0].appointment.scheduledStart;
    // Next UTC day after `now`, at the business-hours start.
    expect(first.toISOString().slice(0, 10)).toBe('2026-06-21');
    expect(first.getTime()).toBeGreaterThan(now.getTime());
  });
});
