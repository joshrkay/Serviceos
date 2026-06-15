import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryCustomFieldRepository,
  createCustomFieldDef,
  setCustomFieldValue,
  listResolvedCustomFields,
  validateCustomFieldDef,
  validateCustomFieldValue,
  isValidFieldKey,
  type CustomFieldDef,
} from '../../src/customers/custom-field';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

function def(overrides: Partial<CustomFieldDef> = {}): CustomFieldDef {
  const now = new Date();
  return {
    id: 'def-1',
    tenantId: TENANT,
    key: 'gate_code',
    label: 'Gate Code',
    fieldType: 'text',
    options: [],
    sortOrder: 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('customer custom fields (U2) — pure domain', () => {
  let repo: InMemoryCustomFieldRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryCustomFieldRepository();
    audit = new InMemoryAuditRepository();
  });

  it('validates field keys', () => {
    expect(isValidFieldKey('gate_code')).toBe(true);
    expect(isValidFieldKey('Gate Code')).toBe(false);
    expect(isValidFieldKey('1code')).toBe(false);
    expect(isValidFieldKey('')).toBe(false);
  });

  it('validates a def: select requires options', () => {
    expect(validateCustomFieldDef({ key: 'x', label: 'X', fieldType: 'select' })).toContain(
      'select fields require at least one option'
    );
    expect(
      validateCustomFieldDef({ key: 'x', label: 'X', fieldType: 'select', options: ['a'] })
    ).toHaveLength(0);
    expect(validateCustomFieldDef({ key: 'Bad Key', label: 'X' })).toHaveLength(1);
  });

  it('validates values against the def type', () => {
    expect(validateCustomFieldValue(def({ fieldType: 'number' }), 'abc')).toMatch(/must be a number/);
    expect(validateCustomFieldValue(def({ fieldType: 'number' }), '42')).toBeNull();
    expect(validateCustomFieldValue(def({ fieldType: 'date' }), '2026/01/01')).toMatch(/must be a date/);
    expect(validateCustomFieldValue(def({ fieldType: 'date' }), '2026-01-01')).toBeNull();
    expect(
      validateCustomFieldValue(def({ fieldType: 'select', options: ['gold', 'silver'] }), 'bronze')
    ).toMatch(/not a valid option/);
    expect(
      validateCustomFieldValue(def({ fieldType: 'select', options: ['gold', 'silver'] }), 'gold')
    ).toBeNull();
    // Blank always clears, regardless of type.
    expect(validateCustomFieldValue(def({ fieldType: 'number' }), '')).toBeNull();
  });

  it('creates a def and emits an audit event', async () => {
    const created = await createCustomFieldDef(
      { tenantId: TENANT, key: 'gate_code', label: 'Gate Code', createdBy: ACTOR },
      repo,
      audit
    );
    expect(created.fieldType).toBe('text');
    const defs = await repo.listDefs(TENANT);
    expect(defs).toHaveLength(1);
    const events = await audit.findByEntity(TENANT, 'customer_custom_field_def', created.id);
    expect(events[0].eventType).toBe('customer_custom_field.created');
  });

  it('rejects a duplicate key', async () => {
    await createCustomFieldDef(
      { tenantId: TENANT, key: 'gate_code', label: 'Gate Code', createdBy: ACTOR },
      repo
    );
    await expect(
      createCustomFieldDef(
        { tenantId: TENANT, key: 'gate_code', label: 'Other', createdBy: ACTOR },
        repo
      )
    ).rejects.toThrow(/already exists/);
  });

  it('sets and clears a value, joining defs and values for the editor', async () => {
    const membership = await createCustomFieldDef(
      {
        tenantId: TENANT,
        key: 'membership',
        label: 'Membership',
        fieldType: 'select',
        options: ['gold', 'silver'],
        createdBy: ACTOR,
      },
      repo
    );

    await setCustomFieldValue(TENANT, CUSTOMER, membership.id, 'gold', repo, ACTOR, audit);
    let resolved = await listResolvedCustomFields(TENANT, CUSTOMER, repo);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ key: 'membership', value: 'gold', options: ['gold', 'silver'] });

    // Clearing with blank removes the value.
    await setCustomFieldValue(TENANT, CUSTOMER, membership.id, '', repo, ACTOR);
    resolved = await listResolvedCustomFields(TENANT, CUSTOMER, repo);
    expect(resolved[0].value).toBeNull();
  });

  it('rejects an invalid value and a value on an archived def', async () => {
    const cap = await createCustomFieldDef(
      { tenantId: TENANT, key: 'amp', label: 'Amps', fieldType: 'number', createdBy: ACTOR },
      repo
    );
    await expect(
      setCustomFieldValue(TENANT, CUSTOMER, cap.id, 'lots', repo)
    ).rejects.toThrow(/must be a number/);

    await repo.archiveDef(TENANT, cap.id);
    await expect(
      setCustomFieldValue(TENANT, CUSTOMER, cap.id, '30', repo)
    ).rejects.toThrow(/archived/);

    // Archived defs drop out of the resolved (active) list.
    expect(await listResolvedCustomFields(TENANT, CUSTOMER, repo)).toHaveLength(0);
  });
});
