import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgTenantRepository } from '../auth/pg-tenant';
import { PgCustomerRepository } from '../customers/pg-customer';
import { createCustomer } from '../customers/customer';
import { PgLocationRepository } from '../locations/pg-location';
import { createLocation } from '../locations/location';
import { PgJobRepository } from '../jobs/pg-job';
import { createJob } from '../jobs/job';
import { PgEstimateRepository } from '../estimates/pg-estimate';
import { createEstimate } from '../estimates/estimate';
import { PgInvoiceRepository } from '../invoices/pg-invoice';
import { createInvoice } from '../invoices/invoice';
import { PgAppointmentRepository } from '../appointments/pg-appointment';
import { createAppointment } from '../appointments/appointment';
import { PgLeadRepository } from '../leads/pg-lead';
import { createLead } from '../leads/lead-service';
import { PgUserRepository } from '../users/pg-user';
import type { User } from '../users/user';
import { PgAuditRepository } from '../audit/pg-audit';
import {
  createAuditEvent,
  type AuditEvent,
  type AuditRepository,
} from '../audit/audit';
import { PgTenantTransactionRunner } from '../db/tenant-transaction';
import { PgEntityResolver } from '../ai/resolution/pg-entity-resolver';
import { buildLineItem } from '../shared/billing-engine';
import {
  buildOperatorVoiceFixturePlan,
  operatorVoiceFixtureProvenance,
  type OperatorVoiceFixturePlan,
} from './operator-voice-fixture-plan';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OperatorVoiceFixtureRunOptions {
  qaTenantId?: string;
  qaActorId?: string;
  targetEnvironment?: string;
  allowUnsafeTarget?: boolean;
}

export interface ValidatedOperatorVoiceFixtureRunOptions {
  qaTenantId: string;
  qaActorId: string;
  targetEnvironment: string;
  allowUnsafeTarget: boolean;
}

export interface OperatorVoiceFixtureSeedRecord {
  id: string;
  entityType: string;
  provenance: string;
}

export interface OperatorVoiceFixtureSeedResult {
  tenantId: string;
  actorId: string;
  records: Record<string, OperatorVoiceFixtureSeedRecord>;
  createdKeys: string[];
  reusedKeys: string[];
}

export function validateOperatorVoiceFixtureRunOptions(
  options: OperatorVoiceFixtureRunOptions,
): ValidatedOperatorVoiceFixtureRunOptions {
  if (!options.qaTenantId) {
    throw new Error('QA_TENANT_ID is required and must identify one explicit QA tenant');
  }
  if (!UUID_RE.test(options.qaTenantId)) {
    throw new Error('QA_TENANT_ID must be a canonical UUID, not an unscoped tenant selector');
  }
  if (!options.qaActorId) {
    throw new Error('QA_ACTOR_ID is required and must identify one canonical users.id actor');
  }
  if (!UUID_RE.test(options.qaActorId)) {
    throw new Error('QA_ACTOR_ID must be a canonical UUID from users.id');
  }
  if (!options.targetEnvironment?.trim()) {
    throw new Error('The target environment is required; refusing an unknown deployment target');
  }

  const targetEnvironment = options.targetEnvironment.trim().toLocaleLowerCase();
  const allowUnsafeTarget = options.allowUnsafeTarget === true;
  if (targetEnvironment !== 'development' && !allowUnsafeTarget) {
    if (targetEnvironment === 'production' || targetEnvironment === 'prod') {
      throw new Error(
        'Refusing production operator-voice fixture seed without the explicit safety override',
      );
    }
    throw new Error(
      `Refusing non-Development target "${targetEnvironment}" without the explicit safety override`,
    );
  }

  return {
    qaTenantId: options.qaTenantId,
    qaActorId: options.qaActorId,
    targetEnvironment,
    allowUnsafeTarget,
  };
}

class ProvenanceAuditRepository implements AuditRepository {
  constructor(
    private readonly delegate: AuditRepository,
    private readonly key: string,
  ) {}

  async create(event: AuditEvent): Promise<AuditEvent> {
    const provenance = operatorVoiceFixtureProvenance(this.key);
    return this.delegate.create({
      ...event,
      correlationId: provenance,
      metadata: {
        ...(event.metadata ?? {}),
        provenance,
        fixtureKey: this.key,
        fixtureVersion: 'v1',
      },
    });
  }

  findByEntity(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<AuditEvent[]> {
    return this.delegate.findByEntity(tenantId, entityType, entityId);
  }

  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.delegate.findByCorrelation(tenantId, correlationId);
  }

  findRecentByTenant(
    tenantId: string,
    options?: { limit?: number },
  ): Promise<AuditEvent[]> {
    if (!this.delegate.findRecentByTenant) return Promise.resolve([]);
    return this.delegate.findRecentByTenant(tenantId, options);
  }
}

interface FixtureEntity {
  id: string;
}

interface EnsureFixtureInput<T extends FixtureEntity> {
  tenantId: string;
  key: string;
  entityType: string;
  transactionRunner: PgTenantTransactionRunner;
  auditRepo: PgAuditRepository;
  load: (id: string) => Promise<T | null>;
  create: (auditRepo: AuditRepository) => Promise<T>;
}

async function ensureFixture<T extends FixtureEntity>(
  input: EnsureFixtureInput<T>,
): Promise<{ entity: T; created: boolean }> {
  const provenance = operatorVoiceFixtureProvenance(input.key);
  return input.transactionRunner.run(input.tenantId, async (scope) => {
    await scope.lock(`operator-voice-fixture:${input.key}`);

    const matchingAudits = (await input.auditRepo.findByCorrelation(input.tenantId, provenance))
      .filter((event) => event.metadata?.provenance === provenance);
    if (matchingAudits.length > 1) {
      throw new Error(`Duplicate provenance audits found for ${provenance}; refusing to guess`);
    }
    if (matchingAudits.length === 1) {
      const audit = matchingAudits[0];
      if (audit.entityType !== input.entityType) {
        throw new Error(
          `Provenance ${provenance} points to ${audit.entityType}, expected ${input.entityType}`,
        );
      }
      const existing = await input.load(audit.entityId);
      if (!existing) {
        throw new Error(
          `Provenance ${provenance} points to missing ${input.entityType} ${audit.entityId}`,
        );
      }
      return { entity: existing, created: false };
    }

    const taggedAuditRepo = new ProvenanceAuditRepository(input.auditRepo, input.key);
    const entity = await input.create(taggedAuditRepo);
    const createdAudits = (await input.auditRepo.findByCorrelation(input.tenantId, provenance))
      .filter((event) => event.metadata?.provenance === provenance);
    if (
      createdAudits.length !== 1 ||
      createdAudits[0].entityType !== input.entityType ||
      createdAudits[0].entityId !== entity.id
    ) {
      throw new Error(
        `Fixture ${input.key} did not emit exactly one matching provenance audit`,
      );
    }
    return { entity, created: true };
  });
}

function requireFixtureId(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);
  if (!id) throw new Error(`Fixture dependency ${key} has not been created`);
  return id;
}

function technicianDisplayName(technician: {
  firstName: string;
  lastName: string;
}): string {
  return `${technician.firstName} ${technician.lastName}`.trim();
}

async function resolveExistingTechnicians(
  pool: Pool,
  plan: OperatorVoiceFixturePlan,
  tenantId: string,
  userRepo: PgUserRepository,
): Promise<Map<string, User>> {
  const resolver = new PgEntityResolver(pool);
  const resolved = new Map<string, User>();
  for (const technician of plan.technicians) {
    const reference = technicianDisplayName(technician);
    const outcome = await resolver.resolve({
      tenantId,
      reference,
      kind: 'technician',
    });
    if (outcome.kind !== 'resolved' || outcome.candidate.label !== reference) {
      throw new Error(
        `QA tenant must contain exactly one active technician named ${reference}; ` +
          'provision that user through the normal Clerk invitation flow before seeding',
      );
    }
    const user = await userRepo.findById(tenantId, outcome.candidate.id);
    if (!user || user.role !== 'technician') {
      throw new Error(`${reference} must be an active technician in the scoped QA tenant`);
    }
    resolved.set(technician.key, user);
  }
  return resolved;
}

function recordFixture(
  result: OperatorVoiceFixtureSeedResult,
  key: string,
  entityType: string,
  entityId: string,
  created: boolean,
): void {
  result.records[key] = {
    id: entityId,
    entityType,
    provenance: operatorVoiceFixtureProvenance(key),
  };
  (created ? result.createdKeys : result.reusedKeys).push(key);
}

export async function runOperatorVoiceFixtureSeed(
  pool: Pool,
  rawCatalog: unknown,
  runOptions: OperatorVoiceFixtureRunOptions,
): Promise<OperatorVoiceFixtureSeedResult> {
  const options = validateOperatorVoiceFixtureRunOptions(runOptions);
  const plan = buildOperatorVoiceFixturePlan(rawCatalog);

  const tenantRepo = new PgTenantRepository(pool);
  const userRepo = new PgUserRepository(pool);
  const tenant = await tenantRepo.findById(options.qaTenantId);
  if (!tenant) {
    throw new Error(`QA tenant ${options.qaTenantId} does not exist`);
  }
  if (!/(?:^|\W)(?:qa|quality assurance)(?:$|\W)/i.test(tenant.name)) {
    throw new Error(
      `Tenant ${options.qaTenantId} is not explicitly marked as QA in its canonical name`,
    );
  }
  const actor = await userRepo.findById(options.qaTenantId, options.qaActorId);
  if (!actor) {
    throw new Error(
      `Canonical actor ${options.qaActorId} does not belong to QA tenant ${options.qaTenantId}`,
    );
  }

  // Team-member creation is owned by Clerk. The fixture runner never fabricates
  // an auth identity; it registers one exact, already-active Carlos technician.
  const technicians = await resolveExistingTechnicians(
    pool,
    plan,
    options.qaTenantId,
    userRepo,
  );

  const auditRepo = new PgAuditRepository(pool);
  const transactionRunner = new PgTenantTransactionRunner(pool);
  const customerRepo = new PgCustomerRepository(pool);
  const locationRepo = new PgLocationRepository(pool);
  const jobRepo = new PgJobRepository(pool);
  const estimateRepo = new PgEstimateRepository(pool);
  const invoiceRepo = new PgInvoiceRepository(pool);
  const appointmentRepo = new PgAppointmentRepository(pool);
  const leadRepo = new PgLeadRepository(pool);
  const result: OperatorVoiceFixtureSeedResult = {
    tenantId: options.qaTenantId,
    actorId: options.qaActorId,
    records: {},
    createdKeys: [],
    reusedKeys: [],
  };
  const ids = new Map<string, string>();

  for (const fixture of plan.customers) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'customer',
      transactionRunner,
      auditRepo,
      load: (id) => customerRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createCustomer(
          {
            tenantId: options.qaTenantId,
            firstName: fixture.firstName,
            lastName: fixture.lastName,
            primaryPhone: fixture.primaryPhone,
            email: fixture.email,
            preferredChannel: 'phone',
            createdBy: options.qaActorId,
            actorRole: actor.role,
          },
          customerRepo,
          fixtureAuditRepo,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'customer', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.locations) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'location',
      transactionRunner,
      auditRepo,
      load: (id) => locationRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createLocation(
          {
            tenantId: options.qaTenantId,
            customerId: requireFixtureId(ids, fixture.customerKey),
            street1: fixture.street1,
            city: fixture.city,
            state: fixture.state,
            postalCode: fixture.postalCode,
          },
          locationRepo,
          fixtureAuditRepo,
          options.qaActorId,
          actor.role,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'location', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.jobs) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'job',
      transactionRunner,
      auditRepo,
      load: (id) => jobRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createJob(
          {
            tenantId: options.qaTenantId,
            customerId: requireFixtureId(ids, fixture.customerKey),
            locationId: requireFixtureId(ids, fixture.locationKey),
            summary: fixture.summary,
            createdBy: options.qaActorId,
            actorRole: actor.role,
          },
          jobRepo,
          fixtureAuditRepo,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'job', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.estimates) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'estimate',
      transactionRunner,
      auditRepo,
      load: (id) => estimateRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createEstimate(
          {
            tenantId: options.qaTenantId,
            jobId: requireFixtureId(ids, fixture.jobKey),
            estimateNumber: fixture.estimateNumber,
            taxRateBps: fixture.taxRateBps,
            validUntil: new Date(fixture.validUntil),
            lineItems: fixture.lineItems.map((lineItem, index) =>
              buildLineItem(
                uuidv4(),
                lineItem.description,
                lineItem.quantity,
                lineItem.unitPriceCents,
                index,
                lineItem.taxable,
                lineItem.category,
                'manual',
              ),
            ),
            createdBy: options.qaActorId,
          },
          estimateRepo,
          fixtureAuditRepo,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'estimate', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.invoices) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'invoice',
      transactionRunner,
      auditRepo,
      load: (id) => invoiceRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createInvoice(
          {
            tenantId: options.qaTenantId,
            jobId: requireFixtureId(ids, fixture.jobKey),
            estimateId: fixture.estimateKey
              ? requireFixtureId(ids, fixture.estimateKey)
              : undefined,
            invoiceNumber: fixture.invoiceNumber,
            taxRateBps: fixture.taxRateBps,
            lineItems: fixture.lineItems.map((lineItem, index) =>
              buildLineItem(
                uuidv4(),
                lineItem.description,
                lineItem.quantity,
                lineItem.unitPriceCents,
                index,
                lineItem.taxable,
                lineItem.category,
                'manual',
              ),
            ),
            createdBy: options.qaActorId,
          },
          invoiceRepo,
          fixtureAuditRepo,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'invoice', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.appointments) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'appointment',
      transactionRunner,
      auditRepo,
      load: (id) => appointmentRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createAppointment(
          {
            tenantId: options.qaTenantId,
            jobId: requireFixtureId(ids, fixture.jobKey),
            scheduledStart: new Date(fixture.scheduledStart),
            scheduledEnd: new Date(fixture.scheduledEnd),
            timezone: fixture.timezone,
            notes: fixture.notes,
            idempotencyKey: operatorVoiceFixtureProvenance(fixture.key),
            createdBy: options.qaActorId,
          },
          appointmentRepo,
          undefined,
          fixtureAuditRepo,
          actor.role,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'appointment', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.technicians) {
    const technician = technicians.get(fixture.key);
    if (!technician) throw new Error(`Missing preflight technician ${fixture.key}`);
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'technician',
      transactionRunner,
      auditRepo,
      load: async (id) => {
        const user = await userRepo.findById(options.qaTenantId, id);
        return user?.role === 'technician' ? user : null;
      },
      create: async (fixtureAuditRepo) => {
        await fixtureAuditRepo.create(
          createAuditEvent({
            tenantId: options.qaTenantId,
            actorId: options.qaActorId,
            actorRole: actor.role,
            eventType: 'qa_fixture.technician_registered',
            entityType: 'technician',
            entityId: technician.id,
            metadata: { existingOnly: true },
          }),
        );
        return technician;
      },
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'technician', ensured.entity.id, ensured.created);
  }

  for (const fixture of plan.leads) {
    const ensured = await ensureFixture({
      tenantId: options.qaTenantId,
      key: fixture.key,
      entityType: 'lead',
      transactionRunner,
      auditRepo,
      load: (id) => leadRepo.findById(options.qaTenantId, id),
      create: (fixtureAuditRepo) =>
        createLead(
          {
            tenantId: options.qaTenantId,
            firstName: fixture.firstName,
            lastName: fixture.lastName,
            companyName: fixture.companyName,
            primaryPhone: fixture.primaryPhone,
            email: fixture.email,
            source: fixture.source,
            estimatedValueCents: fixture.estimatedValueCents,
            street1: fixture.street1,
            city: fixture.city,
            state: fixture.state,
            postalCode: fixture.postalCode,
            country: fixture.country,
            createdBy: options.qaActorId,
            actorRole: actor.role,
          },
          leadRepo,
          fixtureAuditRepo,
        ),
    });
    ids.set(fixture.key, ensured.entity.id);
    recordFixture(result, fixture.key, 'lead', ensured.entity.id, ensured.created);
  }

  return result;
}
