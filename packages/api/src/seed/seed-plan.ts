/**
 * Deterministic demo-data PLAN — the DB-free core of the seed script.
 *
 * `scripts/seed.ts` was a stub that only console.log'd counts. This module
 * computes a concrete, testable plan (tenants → customers → locations → jobs →
 * estimates → appointments) that the script then inserts via the real Pg
 * repositories. Keeping the plan pure lets us PROVE the headline guarantee in a
 * unit test without a database:
 *
 *   N tenants × M customers each, with one estimate and one appointment per
 *   customer, and EVERY appointment on a separate calendar day at a separate
 *   time (no two appointments share a start instant or a date), so a demo
 *   org's schedule is spread out instead of stacked on one slot.
 *
 * Defaults (10 × 20) yield 200 customers, 200 estimates, and 200 appointments.
 */

export interface SeedPlanOptions {
  /** Number of tenants. Default 10. */
  tenantCount?: number;
  /** Customers (and thus estimates + appointments) per tenant. Default 20. */
  customersPerTenant?: number;
  /** UTC midnight the first appointment's day is based on. Default: the start
   *  of the next UTC day after `now`. */
  startDate?: Date;
  /** Appointment length in minutes. Default 60. */
  durationMin?: number;
  /** IANA timezone for every appointment. Default 'America/New_York'. */
  timezone?: string;
  /** Injectable clock (only used to derive the default startDate). */
  now?: Date;
}

export interface PlannedLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  category: 'labor' | 'material' | 'equipment' | 'other';
}

export interface PlannedAppointment {
  scheduledStart: Date;
  scheduledEnd: Date;
  timezone: string;
}

export interface PlannedEntity {
  /** 0-based index across the WHOLE plan — drives globally-unique numbers. */
  globalIndex: number;
  customer: {
    firstName: string;
    lastName: string;
    displayName: string;
    email: string;
    primaryPhone: string;
  };
  location: { street1: string; city: string; state: string; postalCode: string };
  jobSummary: string;
  estimate: {
    estimateNumber: string;
    lineItems: PlannedLineItem[];
    taxRateBps: number;
  };
  appointment: PlannedAppointment;
}

export interface PlannedTenant {
  index: number;
  businessName: string;
  /** Stable slug used to build owner/tech emails (kept unique per tenant). */
  slug: string;
  entities: PlannedEntity[];
}

export interface SeedPlan {
  options: Required<Omit<SeedPlanOptions, 'now'>>;
  tenants: PlannedTenant[];
  totals: { tenants: number; customers: number; estimates: number; appointments: number };
}

const FIRST_NAMES = [
  'John', 'Jane', 'Mike', 'Sarah', 'Bob', 'Alice', 'Tom', 'Mary', 'Chris', 'Lisa',
  'David', 'Karen', 'Steve', 'Nancy', 'Paul', 'Linda', 'Mark', 'Susan', 'James', 'Betty',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Thompson', 'White', 'Harris',
];
const STREETS = [
  '123 Main St', '456 Oak Ave', '789 Pine Rd', '321 Elm Blvd', '654 Maple Dr',
  '987 Cedar Ln', '147 Birch Way', '258 Spruce Ct', '369 Willow Pl', '741 Ash St',
];
const CITIES = ['Springfield', 'Portland', 'Austin', 'Denver', 'Raleigh'];
const STATES = ['IL', 'OR', 'TX', 'CO', 'NC'];
const JOB_SUMMARIES = [
  'AC unit not cooling', 'Furnace making noise', 'Thermostat replacement',
  'Annual HVAC maintenance', 'Duct cleaning', 'Water heater repair',
  'Boiler inspection', 'Heat pump installation', 'Filter replacement',
  'Emergency heating repair',
];

const BUSINESS_HOURS_START = 8; // 08:00
const BUSINESS_HOURS_SPAN = 8; // 08:00..15:00 start window

function startOfNextUtcDay(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * The scheduling guarantee, isolated so the test can assert it directly:
 * appointment `globalIndex` lands on its OWN calendar day (base + g days) at a
 * time-of-day that varies with g — so across the whole plan no two appointments
 * share a date, and starts are spread across business hours rather than stacked.
 */
export function planAppointmentSlot(
  globalIndex: number,
  startDate: Date,
  durationMin: number,
  timezone: string,
): PlannedAppointment {
  const start = new Date(startDate.getTime());
  start.setUTCDate(start.getUTCDate() + globalIndex); // distinct day per appointment
  const hour = BUSINESS_HOURS_START + (globalIndex % BUSINESS_HOURS_SPAN);
  const minute = (globalIndex * 5) % 60; // varied minute-of-hour
  start.setUTCHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { scheduledStart: start, scheduledEnd: end, timezone };
}

export function generateSeedPlan(options: SeedPlanOptions = {}): SeedPlan {
  const tenantCount = options.tenantCount ?? 10;
  const customersPerTenant = options.customersPerTenant ?? 20;
  const durationMin = options.durationMin ?? 60;
  const timezone = options.timezone ?? 'America/New_York';
  const startDate = options.startDate ?? startOfNextUtcDay(options.now ?? new Date());

  const tenants: PlannedTenant[] = [];
  let globalIndex = 0;

  for (let t = 0; t < tenantCount; t++) {
    const slug = `seed-tenant-${String(t + 1).padStart(2, '0')}`;
    const entities: PlannedEntity[] = [];

    for (let c = 0; c < customersPerTenant; c++) {
      const g = globalIndex;
      const firstName = FIRST_NAMES[g % FIRST_NAMES.length];
      const lastName = LAST_NAMES[(g * 7) % LAST_NAMES.length];
      const displayName = `${firstName} ${lastName}`;

      const laborHours = 1 + (g % 4);
      const materialQty = 1 + (g % 6);
      const lineItems: PlannedLineItem[] = [
        {
          description: `Labor (${laborHours}h)`,
          quantity: laborHours,
          unitPriceCents: 12500,
          category: 'labor',
        },
        {
          description: 'Parts & materials',
          quantity: materialQty,
          unitPriceCents: 2500 + (g % 5) * 500,
          category: 'material',
        },
      ];

      entities.push({
        globalIndex: g,
        customer: {
          firstName,
          lastName,
          displayName,
          // Globally-unique contact details so the per-tenant dedup advisory
          // never trips and rows never collide across the plan.
          email: `customer.${g}@${slug}.example.com`,
          primaryPhone: `+1555${String(2_000_000 + g).padStart(7, '0')}`,
        },
        location: {
          street1: STREETS[g % STREETS.length],
          city: CITIES[g % CITIES.length],
          state: STATES[g % STATES.length],
          postalCode: String(10000 + g),
        },
        jobSummary: JOB_SUMMARIES[g % JOB_SUMMARIES.length],
        estimate: {
          estimateNumber: `EST-${String(1000 + g)}`,
          lineItems,
          taxRateBps: 800, // 8%
        },
        appointment: planAppointmentSlot(g, startDate, durationMin, timezone),
      });

      globalIndex++;
    }

    tenants.push({
      index: t,
      businessName: `Comfort Zone HVAC ${String(t + 1).padStart(2, '0')}`,
      slug,
      entities,
    });
  }

  const customers = tenantCount * customersPerTenant;
  return {
    options: { tenantCount, customersPerTenant, startDate, durationMin, timezone },
    tenants,
    totals: {
      tenants: tenantCount,
      customers,
      estimates: customers,
      appointments: customers,
    },
  };
}
