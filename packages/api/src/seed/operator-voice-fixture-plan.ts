import { z } from 'zod';

const fixtureKeySchema = z.string().regex(
  /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/,
  'fixture key must be a stable dotted lowercase key',
);
const utcIsoSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'), 'timestamp must be a UTC ISO value ending in Z');
const centsSchema = z.number().int().nonnegative();
const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);

const lineItemSchema = z
  .object({
    description: z.string().trim().min(1),
    category: z.enum(['labor', 'material', 'equipment', 'other']),
    quantity: z.number().int().positive(),
    unitPriceCents: centsSchema,
    taxable: z.boolean(),
  })
  .strict();

const customerSchema = z
  .object({
    key: fixtureKeySchema,
    firstName: z.string(),
    lastName: z.string(),
    displayName: z.string().trim().min(1),
    primaryPhone: phoneSchema,
    email: z.string().email(),
  })
  .strict();

const locationSchema = z
  .object({
    key: fixtureKeySchema,
    customerKey: fixtureKeySchema,
    street1: z.string().trim().min(1),
    city: z.string().trim().min(1),
    state: z.string().trim().length(2),
    postalCode: z.string().trim().min(3),
  })
  .strict();

const jobSchema = z
  .object({
    key: fixtureKeySchema,
    customerKey: fixtureKeySchema,
    locationKey: fixtureKeySchema,
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

const estimateSchema = z
  .object({
    key: fixtureKeySchema,
    jobKey: fixtureKeySchema,
    estimateNumber: z.string().trim().min(1),
    taxRateBps: z.number().int().min(0).max(10_000),
    validUntil: utcIsoSchema,
    lineItems: z.array(lineItemSchema).min(1),
  })
  .strict();

const invoiceSchema = z
  .object({
    key: fixtureKeySchema,
    jobKey: fixtureKeySchema,
    estimateKey: fixtureKeySchema.optional(),
    invoiceNumber: z.string().trim().min(1),
    taxRateBps: z.number().int().min(0).max(10_000),
    lineItems: z.array(lineItemSchema).min(1),
  })
  .strict();

const appointmentSchema = z
  .object({
    key: fixtureKeySchema,
    jobKey: fixtureKeySchema,
    scheduledStart: utcIsoSchema,
    scheduledEnd: utcIsoSchema,
    timezone: z.string().trim().min(1),
    notes: z.string().trim().min(1),
  })
  .strict();

const technicianSchema = z
  .object({
    key: fixtureKeySchema,
    firstName: z.string().trim().min(1),
    lastName: z.string(),
    role: z.literal('technician'),
    existingOnly: z.literal(true),
  })
  .strict();

const leadSchema = z
  .object({
    key: fixtureKeySchema,
    firstName: z.string(),
    lastName: z.string(),
    companyName: z.string().trim().min(1),
    primaryPhone: phoneSchema,
    email: z.string().email(),
    source: z.enum(['web_form', 'phone_call', 'referral', 'walk_in', 'marketplace', 'other']),
    estimatedValueCents: centsSchema,
    street1: z.string().trim().min(1),
    city: z.string().trim().min(1),
    state: z.string().trim().length(2),
    postalCode: z.string().trim().min(3),
    country: z.string().trim().length(2),
  })
  .strict();

const operatorVoiceFixtureCatalogSchema = z
  .object({
    version: z.literal('v1'),
    customers: z.array(customerSchema).min(1),
    locations: z.array(locationSchema).min(1),
    jobs: z.array(jobSchema).min(1),
    estimates: z.array(estimateSchema).min(1),
    invoices: z.array(invoiceSchema).min(1),
    appointments: z.array(appointmentSchema).min(1),
    technicians: z.array(technicianSchema).length(1),
    leads: z.array(leadSchema).length(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    const forbiddenCustomers = new Set(['maria alvarez', 'james patel']);
    for (const [index, customer] of catalog.customers.entries()) {
      const names = [
        customer.displayName,
        `${customer.firstName} ${customer.lastName}`.trim(),
      ].map((name) => name.toLocaleLowerCase());
      if (names.some((name) => forbiddenCustomers.has(name))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['customers', index, 'displayName'],
          message: `${customer.displayName} must not be pre-seeded because the corpus tests creation`,
        });
      }

      const computedDisplayName = `${customer.firstName} ${customer.lastName}`.trim();
      if (computedDisplayName !== customer.displayName) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['customers', index, 'displayName'],
          message: 'displayName must match the production customer name calculation',
        });
      }
    }

    const groups = [
      catalog.customers,
      catalog.locations,
      catalog.jobs,
      catalog.estimates,
      catalog.invoices,
      catalog.appointments,
      catalog.technicians,
      catalog.leads,
    ];
    const seenKeys = new Set<string>();
    for (const group of groups) {
      for (const fixture of group) {
        if (seenKeys.has(fixture.key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate fixture key ${fixture.key}`,
          });
        }
        seenKeys.add(fixture.key);
      }
    }

    const customerKeys = new Set(catalog.customers.map((fixture) => fixture.key));
    const locations = new Map(catalog.locations.map((fixture) => [fixture.key, fixture]));
    const jobs = new Map(catalog.jobs.map((fixture) => [fixture.key, fixture]));
    const estimates = new Map(catalog.estimates.map((fixture) => [fixture.key, fixture]));

    for (const location of catalog.locations) {
      if (!customerKeys.has(location.customerKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${location.key} references unknown customer ${location.customerKey}`,
        });
      }
    }
    for (const job of catalog.jobs) {
      const location = locations.get(job.locationKey);
      if (!customerKeys.has(job.customerKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${job.key} references unknown customer ${job.customerKey}`,
        });
      }
      if (!location || location.customerKey !== job.customerKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${job.key} must reference a location owned by ${job.customerKey}`,
        });
      }
    }
    for (const estimate of catalog.estimates) {
      if (!jobs.has(estimate.jobKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${estimate.key} references unknown job ${estimate.jobKey}`,
        });
      }
    }
    for (const invoice of catalog.invoices) {
      if (!jobs.has(invoice.jobKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${invoice.key} references unknown job ${invoice.jobKey}`,
        });
      }
      if (invoice.estimateKey) {
        const estimate = estimates.get(invoice.estimateKey);
        if (!estimate || estimate.jobKey !== invoice.jobKey) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${invoice.key} must reference an estimate on ${invoice.jobKey}`,
          });
        }
      }
    }
    for (const appointment of catalog.appointments) {
      if (!jobs.has(appointment.jobKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${appointment.key} references unknown job ${appointment.jobKey}`,
        });
      }
      if (Date.parse(appointment.scheduledEnd) <= Date.parse(appointment.scheduledStart)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${appointment.key} scheduledEnd must be after scheduledStart`,
        });
      }
    }

    for (const [kind, numbers] of [
      ['estimate', catalog.estimates.map((fixture) => fixture.estimateNumber)],
      ['invoice', catalog.invoices.map((fixture) => fixture.invoiceNumber)],
    ] as const) {
      if (new Set(numbers).size !== numbers.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${kind} numbers must be unique within the QA tenant`,
        });
      }
    }
  });

export type OperatorVoiceFixtureCatalog = z.infer<typeof operatorVoiceFixtureCatalogSchema>;
export type OperatorVoiceFixturePlan = OperatorVoiceFixtureCatalog;

export const OPERATOR_VOICE_FIXTURE_PROVENANCE_PREFIX = 'qa-operator-voice:v1:';

export function operatorVoiceFixtureProvenance(key: string): string {
  return `${OPERATOR_VOICE_FIXTURE_PROVENANCE_PREFIX}${key}`;
}

export function buildOperatorVoiceFixturePlan(rawCatalog: unknown): OperatorVoiceFixturePlan {
  return operatorVoiceFixtureCatalogSchema.parse(rawCatalog);
}
