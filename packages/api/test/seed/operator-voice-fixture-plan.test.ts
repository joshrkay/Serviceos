import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOperatorVoiceFixturePlan,
  type OperatorVoiceFixtureCatalog,
} from '../../src/seed/operator-voice-fixture-plan';
import { validateOperatorVoiceFixtureRunOptions } from '../../src/seed/operator-voice-fixture-runner';

const CATALOG_PATH = resolve(
  __dirname,
  '../../../../fixtures/voice/operator-voice-fixture-catalog.json',
);

function readCatalog(): unknown {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
}

describe('operator voice QA fixture plan', () => {
  it('contains exactly the required customer, document, technician, and lead references', () => {
    const plan = buildOperatorVoiceFixturePlan(readCatalog());

    expect(plan.customers.map((customer) => customer.displayName)).toEqual([
      'Khan',
      'Johnson',
      'Mrs Lee',
      'Smith',
      'Smith',
      'Garcia',
    ]);
    expect(plan.customers.filter((customer) => customer.displayName === 'Smith')).toHaveLength(2);
    expect(plan.estimates.map((estimate) => estimate.estimateNumber)).toContain('EST-0042');
    expect(plan.invoices.map((invoice) => invoice.invoiceNumber)).toContain('INV-0042');
    expect(plan.technicians).toEqual([
      expect.objectContaining({ firstName: 'Carlos', lastName: '', role: 'technician' }),
    ]);
    expect(plan.leads).toEqual([
      expect.objectContaining({ companyName: 'Greenfield Property Management' }),
    ]);
  });

  it('contains one fixed UTC Tuesday appointment for Garcia', () => {
    const plan = buildOperatorVoiceFixturePlan(readCatalog());
    const garcia = plan.customers.find((customer) => customer.displayName === 'Garcia');
    const garciaJobKeys = new Set(
      plan.jobs.filter((job) => job.customerKey === garcia?.key).map((job) => job.key),
    );
    const appointments = plan.appointments.filter((appointment) =>
      garciaJobKeys.has(appointment.jobKey),
    );

    expect(appointments).toHaveLength(1);
    expect(appointments[0].scheduledStart.endsWith('Z')).toBe(true);
    expect(appointments[0].scheduledEnd.endsWith('Z')).toBe(true);
    expect(new Date(appointments[0].scheduledStart).getUTCDay()).toBe(2);
  });

  it('stores every money field as an integer number of cents', () => {
    const plan = buildOperatorVoiceFixturePlan(readCatalog());
    const cents: Array<{ path: string; value: unknown }> = [];

    function collect(value: unknown, path = 'catalog'): void {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collect(entry, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (key.endsWith('Cents')) cents.push({ path: childPath, value: child });
        collect(child, childPath);
      }
    }

    collect(plan);
    expect(cents.length).toBeGreaterThan(0);
    for (const money of cents) {
      expect(money.value, money.path).toEqual(expect.any(Number));
      expect(Number.isInteger(money.value), money.path).toBe(true);
    }
  });

  it.each(['Maria Alvarez', 'James Patel'])('rejects forbidden creation-workflow customer %s', (name) => {
    const raw = readCatalog() as OperatorVoiceFixtureCatalog;
    const [firstName, lastName] = name.split(' ');
    const modified = structuredClone(raw);
    modified.customers.push({
      ...modified.customers[0],
      key: `customer.forbidden-${firstName.toLowerCase()}`,
      firstName,
      lastName,
      displayName: name,
    });

    expect(() => buildOperatorVoiceFixturePlan(modified)).toThrow(/must not be pre-seeded/i);
  });
});

describe('operator voice QA fixture runner guards', () => {
  const valid = {
    qaTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    qaActorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    targetEnvironment: 'development',
  };

  it.each([
    [{ ...valid, qaTenantId: undefined }, /QA_TENANT_ID/i],
    [{ ...valid, qaActorId: undefined }, /QA_ACTOR_ID/i],
    [{ ...valid, qaTenantId: 'all-tenants' }, /QA_TENANT_ID.*UUID/i],
    [{ ...valid, qaActorId: 'clerk_user_123' }, /QA_ACTOR_ID.*UUID/i],
    [{ ...valid, targetEnvironment: undefined }, /target environment/i],
  ])('rejects missing or unscoped values', (options, message) => {
    expect(() => validateOperatorVoiceFixtureRunOptions(options)).toThrow(message);
  });

  it('refuses production without the explicit safety override', () => {
    expect(() =>
      validateOperatorVoiceFixtureRunOptions({ ...valid, targetEnvironment: 'production' }),
    ).toThrow(/production.*override/i);
  });

  it('allows a deliberate production override while preserving explicit scope', () => {
    expect(
      validateOperatorVoiceFixtureRunOptions({
        ...valid,
        targetEnvironment: 'production',
        allowUnsafeTarget: true,
      }),
    ).toMatchObject({
      qaTenantId: valid.qaTenantId,
      qaActorId: valid.qaActorId,
      targetEnvironment: 'production',
      allowUnsafeTarget: true,
    });
  });
});
