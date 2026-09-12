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
 *    `technician_location_pings`, AND emits
 *    `technician_location.batch_ingested` against the `technician` entity
 *    (`emitLocationBatchAudit`, routes/technician-location.ts:106). Both legs
 *    are exercised through the real router below.
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
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
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
import { assignTechnician } from '../../src/appointments/assignment';
import { createDispatchRoutes } from '../../src/dispatch/routes';
import { createTechnicianLocationRouter } from '../../src/routes/technician-location';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

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
  customerId: string;
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
      // The pings below sit on these exact coordinates. Without them the
      // fixture only LOOKS like a dwell signal on the service location: a
      // geofence evaluator keyed on a located address would skip this
      // appointment entirely, and both the `lateness === undefined` assertion
      // and the it.fails would stay green while real wiring worked fine for
      // located customers.
      latitude: SITE.lat,
      longitude: SITE.lng,
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

    // A real technician user — `assignTechnician` refuses anything else
    // ("Assigned user must have technician role"), and the router submits as
    // this person. createTestTenant's own user is the owner.
    const technicianId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [
        technicianId,
        tenant.tenantId,
        technicianId,
        `tech-${technicianId.slice(0, 8)}@example.com`,
        'technician',
      ],
    );

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

    // The technician must actually be ASSIGNED to this appointment, or the
    // router's assignment gate strips the appointmentId off every ping below
    // (routes/technician-location.ts:77) and the dwell fixture stops being
    // about this visit at all.
    await assignTechnician(
      {
        tenantId: tenant.tenantId,
        appointmentId: appointment.id,
        technicianId,
        technicianRole: 'technician',
        isPrimary: true,
        assignedBy: tenant.userId,
      },
      assignmentRepo,
    );

    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Phoenix',
    }).format(scheduledStart);

    return {
      tenant,
      customerId,
      appointmentId: appointment.id,
      technicianId,
      dateStr,
    };
  }

  /**
   * An express app wired the way `app.ts:5521-5533` wires the location router:
   * the real repository, the assignment gate, and the audit repo. Auth is the
   * technician submitting for themselves.
   */
  function productionLocationApp(seeded: SeededTenant) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: seeded.tenant.userId,
        canonicalUserId: seeded.technicianId,
        sessionId: 'row-4-7-session',
        tenantId: seeded.tenant.tenantId,
        role: 'technician',
      };
      next();
    });
    app.use(
      '/api/technician-location',
      createTechnicianLocationRouter({
        repository: pingRepo,
        // The gate app.ts supplies. Without it `sanitizeAppointmentIds`
        // (routes/technician-location.ts:50) is a passthrough and the fixture
        // would carry an appointmentId production would have stripped.
        isAppointmentAssignedToTechnician: async (tenantId, appointmentId, technicianId) => {
          const assignments = await assignmentRepo.findByAppointment(tenantId, appointmentId);
          return assignments.some((a) => a.technicianId === technicianId);
        },
        auditRepo,
      }),
    );
    return app;
  }

  /**
   * Dwell pings parked on the service location — the geofence/dwell signal —
   * ingested through the PRODUCTION router, not `insertMany`.
   *
   * Why it matters that these go through the route: `app.ts` supplies
   * `isAppointmentAssignedToTechnician`, so a ping naming an appointment the
   * submitting technician is NOT assigned to has its `appointmentId` stripped
   * (routes/technician-location.ts:77). Inserting directly bypasses that, and
   * the fixture would hold appointment-linked pings production could never
   * produce — so an evaluator reading pings by appointment would find nothing
   * real, and the desired-state test could stay red even once the row is
   * correctly wired. The appointment is assigned to this technician in
   * `beforeAll`, so the ids survive the gate.
   */
  async function seedDwellPings(seeded: SeededTenant, count = 6): Promise<number> {
    const res = await request(productionLocationApp(seeded))
      .post('/api/technician-location')
      .send({
        technicianId: seeded.technicianId,
        pings: Array.from({ length: count }, (_, i) => ({
          clientPingId: crypto.randomUUID(),
          appointmentId: seeded.appointmentId,
          lat: SITE.lat + i * 0.00001,
          lng: SITE.lng + i * 0.00001,
          accuracyMeters: 8,
          speedMps: 0,
          recordedAt: new Date(Date.now() - (count - i) * 5 * 60 * 1000).toISOString(),
          source: 'mobile',
        })),
      });
    expect(res.status).toBe(201);
    return (
      await pingRepo.listByAppointment(seeded.tenant.tenantId, seeded.appointmentId)
    ).length;
  }

  /**
   * The REAL dispatch board endpoint — `createDispatchRoutes` mounted at
   * `/api/dispatch`, exactly as app.ts:4938 mounts it, reached over HTTP.
   *
   * Calling `getDispatchBoardData` directly with a hand-built deps object was
   * the wrong shape for this row: the whole question is whether the PRODUCTION
   * route supplies `getAppointmentLateness`, and a locally hard-coded deps
   * literal can never answer that. Worse, it froze the answer — wire the
   * adapter into `DispatchRouteDeps` tomorrow and the old assertions would not
   * have noticed, so the `it.fails` would stay red and the "no lateness"
   * characterization stay green while the shipped board worked.
   *
   * Going through `createDispatchRoutes` means both flip on their own the day
   * someone closes the row.
   */
  function productionBoardApp(seeded: SeededTenant) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: seeded.tenant.userId,
        canonicalUserId: seeded.tenant.userId,
        sessionId: 'row-4-7-board',
        tenantId: seeded.tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/dispatch',
      createDispatchRoutes({ appointmentRepo, assignmentRepo, jobRepo, customerRepo, locationRepo, auditRepo }),
    );
    return app;
  }

  /** Every board item the real endpoint serves for that tenant and day. */
  async function boardItems(seeded: SeededTenant): Promise<Array<Record<string, unknown>>> {
    const res = await request(productionBoardApp(seeded))
      .get('/api/dispatch/board')
      // `dateStr` is a Phoenix-local calendar date, so the route must use the
      // same boundary. Omitting `timezone` makes `getDispatchBoardData` fall
      // back to UTC (routes.ts:146), and for the ~7 hours a day where the
      // Phoenix and UTC dates differ the seeded appointment falls outside the
      // queried window — the assertions would then fail on a wall clock rather
      // than on anything to do with lateness wiring.
      .query({ date: seeded.dateStr, timezone: 'America/Phoenix' });
    expect(res.status).toBe(200);
    const body = res.body as {
      unassignedAppointments?: Array<Record<string, unknown>>;
      technicianLanes?: Array<{ appointments: Array<Record<string, unknown>> }>;
    };
    return [
      ...(body.unassignedAppointments ?? []),
      ...(body.technicianLanes ?? []).flatMap((lane) => lane.appointments ?? []),
    ];
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
    // Seeded HERE, not inside an `it`. Every test below asserts against these
    // pings, so seeding them in one test would make the rest order-dependent:
    // a filtered run (`vitest -t "neighbour tenant"`) would find tenant A with
    // zero pings and fail before reaching the behaviour it claims to pin.
    expect(await seedDwellPings(tenantA, 6)).toBe(6);
    expect(await seedDwellPings(tenantB, 4)).toBe(4);
    // The appointment ids SURVIVED the router's assignment gate — every ping
    // still names the visit it was dwelling at. If the assignment above were
    // dropped, these would come back 0 and the fixture would be silently
    // appointment-less.
    expect(
      await pingRepo.listByAppointment(tenantA.tenant.tenantId, tenantA.appointmentId),
    ).toHaveLength(6);

    // The service location really carries the coordinates the pings dwell on,
    // so the fixture is a geofence signal and not merely a set of rows.
    const [site] = await locationRepo.findByCustomer(
      tenantA.tenant.tenantId,
      tenantA.customerId,
    );
    expect(site.latitude).toBeCloseTo(SITE.lat, 5);
    expect(site.longitude).toBeCloseTo(SITE.lng, 5);
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
    const items = await boardItems(tenantA);
    expect(items.some((item) => item.id === tenantA.appointmentId)).toBe(true);
    expect(items.every((item) => item.lateness === undefined)).toBe(true);
  });

  it('CURRENT: ingestion through the PRODUCTION route emits technician_location.batch_ingested, readable back via findByEntity on the technician entity', async () => {
    // Through the real router (`createTechnicianLocationRouter`, mounted at
    // app.ts:5523) with the same `auditRepo` app.ts supplies — NOT the bare
    // repository. `emitLocationBatchAudit` (routes/technician-location.ts:106)
    // writes `technician_location.batch_ingested` against the TECHNICIAN
    // entity, so a bare `insertMany` plus a query on some other entity type
    // would return empty and prove nothing about the production path.
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenantA.tenant.userId,
        canonicalUserId: tenantA.technicianId,
        sessionId: 'row-4-7-session',
        tenantId: tenantA.tenant.tenantId,
        role: 'technician',
      };
      next();
    });
    app.use(
      '/api/technician-location',
      createTechnicianLocationRouter({ repository: pingRepo, auditRepo }),
    );

    const res = await request(app)
      .post('/api/technician-location')
      .send({
        technicianId: tenantA.technicianId,
        pings: [
          {
            clientPingId: crypto.randomUUID(),
            lat: SITE.lat,
            lng: SITE.lng,
            recordedAt: new Date(Date.now() - 60 * 1000).toISOString(),
            source: 'gps',
          },
        ],
      });
    expect(res.status).toBe(201);

    const technicianEvents = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'technician',
      tenantA.technicianId,
    );
    expect(technicianEvents.map((e) => e.eventType)).toContain(
      'technician_location.batch_ingested',
    );

    // POSITIVE CONTROL for the assignment gate. The dwell fixture's ids
    // surviving proves nothing on its own — they would survive an ABSENT gate
    // too. So submit a ping naming an appointment this technician is NOT
    // assigned to: the location is still accepted, but `sanitizeAppointmentIds`
    // (routes/technician-location.ts:77) must strip the appointmentId. If this
    // comes back linked, the gate is not wired in this harness and the dwell
    // fixture is not production-shaped.
    const unassignedClientPingId = crypto.randomUUID();
    const unassigned = await request(productionLocationApp(tenantA))
      .post('/api/technician-location')
      .send({
        technicianId: tenantA.technicianId,
        pings: [
          {
            clientPingId: unassignedClientPingId,
            appointmentId: tenantB.appointmentId, // never assigned to this tech
            lat: SITE.lat,
            lng: SITE.lng,
            recordedAt: new Date().toISOString(),
            source: 'gps',
          },
        ],
      });
    expect(unassigned.status).toBe(201);
    const { rows: strippedRows } = await pool.query(
      `SELECT appointment_id FROM technician_location_pings
        WHERE tenant_id = $1 AND client_ping_id = $2`,
      [tenantA.tenant.tenantId, unassignedClientPingId],
    );
    expect(strippedRows).toHaveLength(1);
    expect(strippedRows[0].appointment_id).toBeNull();
    expect(technicianEvents.every((e) => e.tenantId === tenantA.tenant.tenantId)).toBe(true);

    // The neighbour tenant reads none of it.
    expect(
      await auditRepo.findByEntity(
        tenantB.tenant.tenantId,
        'technician',
        tenantA.technicianId,
      ),
    ).toHaveLength(0);
  });

  it('CURRENT: the appointment audit trail reads back, and NO lateness event has ever been emitted for it', async () => {
    const events = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'appointment',
      tenantA.appointmentId,
    );
    expect(events.map((e) => e.eventType)).toContain('appointment.created');
    expect(events.every((e) => e.tenantId === tenantA.tenant.tenantId)).toBe(true);
    // The absence that actually belongs to this row: ingestion IS audited (see
    // the test above), but nothing downstream ever evaluates those pings, so no
    // lateness/delay event exists on the appointment or the technician.
    expect(events.map((e) => e.eventType).filter((t) => /late|delay/.test(t))).toEqual([]);
    const technicianEvents = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'technician',
      tenantA.technicianId,
    );
    expect(
      technicianEvents.map((e) => e.eventType).filter((t) => /late|delay/.test(t)),
    ).toEqual([]);

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
      const items = await boardItems(tenantA);
      const item = items.find((i) => i.id === tenantA.appointmentId) as
        | { lateness?: { latenessState?: string; confidenceBreakdown?: unknown } }
        | undefined;
      expect(item?.lateness?.latenessState).toBeDefined();
      expect(item?.lateness?.confidenceBreakdown).toBeDefined();
    },
  );
});
