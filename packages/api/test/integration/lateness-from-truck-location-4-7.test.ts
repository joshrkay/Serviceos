/**
 * Docker-gated integration test — PRD v5 §8.4 row 4.7, "lateness from truck
 * location", at real Postgres.
 *
 * ROW CRITERION: "Given geofence/dwell signals, when evaluated, then a lateness
 * state with a confidence breakdown."
 *
 * WHAT IS WIRED, AND WHAT IS NOT (read 2026-09-12):
 *  - WIRED, and pinned below: the signal INGESTION half. `POST
 *    /api/technician-location` (src/routes/technician-location.ts, mounted at
 *    app.ts:5523) validates and persists pings through
 *    `PgTechnicianLocationPingRepository`
 *    (src/telemetry/pg-technician-location-ping.ts:22) into
 *    `technician_location_pings`.
 *  - NOT WIRED: the EVALUATION half. `computeDispatchLateness`
 *    (src/dispatch/lateness.ts:278) is the module's ONLY value export and has
 *    no caller anywhere under `src/`. The single import of that module,
 *    `board-query.ts:5`, binds `DispatchLatenessResult` — a type, used only in
 *    type positions (board-query.ts:40, 91, 149, 294, 323). TypeScript elides
 *    it at emit, so no runtime edge exists between the board and the evaluator.
 *  - WHERE A LATENESS STATE WOULD LAND: `DispatchBoardItem.lateness`
 *    (board-query.ts:40), populated by the optional
 *    `BoardQueryDependencies.getAppointmentLateness` hook (board-query.ts:91,
 *    called at 289 and 317) and served to the owner by `GET /api/dispatch/board`
 *    (src/dispatch/routes.ts:2). The seam exists; the production route never
 *    supplies the hook — `DispatchRouteDeps` (routes.ts:29-38) has no lateness
 *    dependency at all, so `lateness` is `undefined` on every board item the
 *    product has ever served.
 *
 * The decision this row needs — wire the evaluator or retire it — is Josh's.
 * These tests take neither: they pin the ingestion that works, the absence of
 * the runtime edge, and state the criterion as the one `it.fails`.
 *
 * Run: cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *   --config vitest.integration.config.ts --reporter=verbose \
 *   test/integration/lateness-from-truck-location-4-7.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgTechnicianLocationPingRepository } from '../../src/telemetry/pg-technician-location-ping';
import { createTechnicianLocationPing } from '../../src/telemetry/technician-location-ping';
import { createAppointment } from '../../src/appointments/appointment';
import { getDispatchBoardData, BoardQueryDependencies } from '../../src/dispatch/board-query';

/** Service address the fixture pings sit on top of (Phoenix). */
const SITE = { lat: 33.4484, lng: -112.074 };

/** Every .ts file under packages/api/src. */
function srcFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      srcFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Files under `src/` that mention `symbol` at all, excluding the file that
 * declares it. A value export with no such file has no runtime caller: a
 * type-only binding cannot survive emit, and a call cannot happen without the
 * name appearing.
 */
function srcFilesReferencing(symbol: string, declaredIn: string): string[] {
  const srcRoot = resolve(__dirname, '../../src');
  const declaringFile = resolve(srcRoot, declaredIn);
  const pattern = new RegExp(`\\b${symbol}\\b`);
  return srcFiles(srcRoot)
    .filter((file) => file !== declaringFile)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(srcRoot.length + 1));
}

interface SeededTenant {
  tenant: TestTenant;
  appointmentId: string;
  technicianId: string;
  dateStr: string;
}

describe('Postgres integration — §8.4 row 4.7 lateness from truck location', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let auditRepo: PgAuditRepository;
  let pingRepo: PgTechnicianLocationPingRepository;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  async function seedTenant(label: string): Promise<SeededTenant> {
    const tenant = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: label,
      lastName: 'Customer',
      displayName: `${label} Customer`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Lateness Road',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: `${label} long visit`,
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // An appointment that STARTED 90 minutes ago and should have ended 30
    // minutes ago — the shape the evaluator would call late.
    const scheduledStart = new Date(Date.now() - 90 * 60 * 1000);
    const scheduledEnd = new Date(Date.now() - 30 * 60 * 1000);
    const appointment = await createAppointment(
      {
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart,
        scheduledEnd,
        timezone: 'America/Phoenix',
        createdBy: tenant.userId,
      },
      appointmentRepo,
      undefined,
      auditRepo,
      'system',
    );

    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Phoenix',
    }).format(scheduledStart);

    return {
      tenant,
      appointmentId: appointment.id,
      technicianId: tenant.userId,
      dateStr,
    };
  }

  /** Dwell pings parked on the service location — the geofence/dwell signal. */
  async function seedDwellPings(seeded: SeededTenant, count = 6): Promise<number> {
    const pings = Array.from({ length: count }, (_, i) =>
      createTechnicianLocationPing({
        tenantId: seeded.tenant.tenantId,
        technicianId: seeded.technicianId,
        clientPingId: crypto.randomUUID(),
        appointmentId: seeded.appointmentId,
        lat: SITE.lat + i * 0.00001,
        lng: SITE.lng + i * 0.00001,
        accuracyMeters: 8,
        speedMps: 0,
        recordedAt: new Date(Date.now() - (count - i) * 5 * 60 * 1000),
        source: 'mobile',
      }),
    );
    const written = await pingRepo.insertMany(seeded.tenant.tenantId, pings);
    return written.length;
  }

  /**
   * The board dependencies the PRODUCTION route builds
   * (src/dispatch/routes.ts) — note there is no `getAppointmentLateness`
   * to pass, because `DispatchRouteDeps` does not declare one.
   */
  function productionBoardDeps(): BoardQueryDependencies {
    return { appointmentRepo, assignmentRepo };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    pingRepo = new PgTechnicianLocationPingRepository(pool);
    tenantA = await seedTenant('Alpha');
    tenantB = await seedTenant('Bravo');
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('STRUCTURAL: computeDispatchLateness — the only value export of dispatch/lateness.ts — is referenced by NO file under src/; negative control: getDispatchBoardData is referenced by the dispatch route', () => {
    // Negative control FIRST. A scanner that can only return [] proves
    // nothing, so show it finds a function the product really does call.
    const control = srcFilesReferencing('getDispatchBoardData', 'dispatch/board-query.ts');
    expect(control).toContain('dispatch/routes.ts');
    expect(control.length).toBeGreaterThan(0);

    // The claim under test: no runtime caller of the evaluator.
    expect(srcFilesReferencing('computeDispatchLateness', 'dispatch/lateness.ts')).toEqual([]);

    // And the module's single importer binds only the RESULT TYPE, never a value.
    const boardQuery = readFileSync(
      resolve(__dirname, '../../src/dispatch/board-query.ts'),
      'utf8',
    );
    expect(boardQuery).toContain("import { DispatchLatenessResult } from './lateness'");
  });

  it('CURRENT: a technician location update persists to technician_location_pings and reads back tenant-scoped through the repository the route wires', async () => {
    const written = await seedDwellPings(tenantA);
    expect(written).toBe(6);

    const byAppointment = await pingRepo.listByAppointment(
      tenantA.tenant.tenantId,
      tenantA.appointmentId,
    );
    expect(byAppointment).toHaveLength(6);
    expect(byAppointment.every((p) => p.tenantId === tenantA.tenant.tenantId)).toBe(true);
    expect(byAppointment.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
    expect(byAppointment.every((p) => p.accuracyMeters === 8)).toBe(true);

    const byTechnician = await pingRepo.listByTechnician(
      tenantA.tenant.tenantId,
      tenantA.technicianId,
    );
    expect(byTechnician).toHaveLength(6);
  });

  it('CURRENT (T1): a neighbour tenant`s pings are invisible to tenant A — each tenant reads only its own truck', async () => {
    await seedDwellPings(tenantB, 4);

    const aSeesOwn = await pingRepo.listByTechnician(
      tenantA.tenant.tenantId,
      tenantA.technicianId,
    );
    expect(aSeesOwn).toHaveLength(6);

    // Tenant A asking for the neighbour's technician and the neighbour's
    // appointment gets nothing.
    const aSeesOtherTenantTech = await pingRepo.listByTechnician(
      tenantA.tenant.tenantId,
      tenantB.technicianId,
    );
    expect(aSeesOtherTenantTech).toHaveLength(0);
    const aSeesOtherTenantAppt = await pingRepo.listByAppointment(
      tenantA.tenant.tenantId,
      tenantB.appointmentId,
    );
    expect(aSeesOtherTenantAppt).toHaveLength(0);

    const bSeesOwn = await pingRepo.listByAppointment(
      tenantB.tenant.tenantId,
      tenantB.appointmentId,
    );
    expect(bSeesOwn).toHaveLength(4);
  });

  it('CURRENT: with those pings in the database, the dispatch board built the way the production route builds it carries NO lateness on any item', async () => {
    const board = await getDispatchBoardData(
      tenantA.tenant.tenantId,
      tenantA.dateStr,
      productionBoardDeps(),
      'America/Phoenix',
    );

    const items = [
      ...board.unassignedAppointments,
      ...board.technicianLanes.flatMap((lane) => lane.appointments),
    ];
    expect(items.some((item) => item.id === tenantA.appointmentId)).toBe(true);
    expect(items.every((item) => item.lateness === undefined)).toBe(true);
  });

  it('CURRENT: the audit trail reads back for the appointment through PgAuditRepository.findByEntity, and a location update writes NO audit row of its own', async () => {
    const events = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'appointment',
      tenantA.appointmentId,
    );
    expect(events.map((e) => e.eventType)).toContain('appointment.created');
    expect(events.every((e) => e.tenantId === tenantA.tenant.tenantId)).toBe(true);
    // No lateness event was ever emitted for this appointment.
    expect(events.map((e) => e.eventType).filter((t) => t.includes('late'))).toEqual([]);

    // The pings themselves are unaudited — nothing under this entity type.
    const pings = await pingRepo.listByAppointment(
      tenantA.tenant.tenantId,
      tenantA.appointmentId,
    );
    const pingEvents = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'technician_location_ping',
      pings[0].id,
    );
    expect(pingEvents).toHaveLength(0);

    // The neighbour tenant reads none of tenant A's appointment audit rows.
    const crossTenant = await auditRepo.findByEntity(
      tenantB.tenant.tenantId,
      'appointment',
      tenantA.appointmentId,
    );
    expect(crossTenant).toHaveLength(0);
  });

  /**
   * THE ROW'S GAP, stated as the row states it. Where it WOULD land:
   * `DispatchBoardItem.lateness` (board-query.ts:40) — the field
   * `GET /api/dispatch/board` already serializes, populated by the
   * `getAppointmentLateness` hook (board-query.ts:91) that the production
   * route never supplies.
   *
   * Wire or retire is Josh's decision — see the drafted issue in the lane
   * report. This test only pins that the criterion does not hold today.
   */
  it.fails(
    'DESIRED (row 4.7): with dwell pings on the service location, the dispatch board item for that appointment carries a lateness state and a confidence breakdown',
    async () => {
      const board = await getDispatchBoardData(
        tenantA.tenant.tenantId,
        tenantA.dateStr,
        productionBoardDeps(),
        'America/Phoenix',
      );
      const items = [
        ...board.unassignedAppointments,
        ...board.technicianLanes.flatMap((lane) => lane.appointments),
      ];
      const item = items.find((i) => i.id === tenantA.appointmentId);
      expect(item?.lateness?.latenessState).toBeDefined();
      expect(item?.lateness?.confidenceBreakdown).toBeDefined();
    },
  );
});
