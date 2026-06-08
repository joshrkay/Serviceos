/**
 * Shared loader for the voice-parity fixture corpus (fixtures/voice/*).
 * Not a *.test.ts file, so vitest does not collect it as a suite.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Appointment } from '../../src/appointments/appointment';
import type { BusinessHoursConfig } from '../../src/compliance/business-hours';
import type { BusinessHours } from '../../src/scheduling/booking-availability';

const here = dirname(fileURLToPath(import.meta.url));
/** Repo-root fixtures dir, resolved from this file (cwd-independent). */
export const VOICE_FIXTURE_DIR = resolve(here, '../../../../fixtures/voice');

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(VOICE_FIXTURE_DIR, file), 'utf8')) as T;
}

export interface IntentFixture {
  name: string;
  feature: string;
  language: 'en' | 'es';
  utterance: string;
  expectedIntent: string;
  expectedEmergencyDial: boolean;
  confidence: number;
  expectedCriticalHandoff: boolean;
}

export function loadIntents(): IntentFixture[] {
  return [
    ...loadJson<IntentFixture[]>('intents.en.json'),
    ...loadJson<IntentFixture[]>('intents.es.json'),
  ];
}

export interface CustomerFixture {
  name: string;
  feature: string;
  language: 'en' | 'es';
  scenario: 'returning' | 'new';
  customerName: string;
  timezone: string;
  lastService: { date: string; type: string } | null;
  expectedGreetingContains: string[];
}

export function loadCustomers(): CustomerFixture[] {
  return loadJson<CustomerFixture[]>('customers.json');
}

interface RawAppointment {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: Appointment['status'];
}

interface RawBookingFixture {
  name: string;
  feature: string;
  language: 'en' | 'es';
  fromDate: string;
  toDate: string;
  durationMin: number;
  expectBookable: boolean;
  existingAppointments: RawAppointment[];
}

interface RawBookingCorpus {
  tenantId: string;
  timezone: string;
  now: string;
  schedule: BusinessHoursConfig;
  businessHours: BusinessHours;
  fixtures: RawBookingFixture[];
}

export interface BookingCorpus {
  tenantId: string;
  timezone: string;
  now: Date;
  schedule: BusinessHoursConfig;
  businessHours: BusinessHours;
  fixtures: Array<{
    name: string;
    language: 'en' | 'es';
    fromDate: string;
    toDate: string;
    durationMin: number;
    expectBookable: boolean;
    existingAppointments: Appointment[];
  }>;
}

/** Build a full Appointment from the minimal fixture shape. */
function toAppointment(raw: RawAppointment, tenantId: string, timezone: string): Appointment {
  const created = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: raw.id,
    tenantId,
    jobId: `job-${raw.id}`,
    scheduledStart: new Date(raw.scheduledStart),
    scheduledEnd: new Date(raw.scheduledEnd),
    timezone,
    status: raw.status,
    holdPendingApproval: false,
    createdBy: 'fixture',
    createdAt: created,
    updatedAt: created,
  };
}

export function loadBookingCorpus(): BookingCorpus {
  const raw = loadJson<RawBookingCorpus>('booking.json');
  return {
    tenantId: raw.tenantId,
    timezone: raw.timezone,
    now: new Date(raw.now),
    schedule: raw.schedule,
    businessHours: raw.businessHours,
    fixtures: raw.fixtures.map((f) => ({
      name: f.name,
      language: f.language,
      fromDate: f.fromDate,
      toDate: f.toDate,
      durationMin: f.durationMin,
      expectBookable: f.expectBookable,
      existingAppointments: f.existingAppointments.map((a) =>
        toAppointment(a, raw.tenantId, raw.timezone),
      ),
    })),
  };
}
