import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryJobCustomFieldRepository,
  createJobCustomFieldDef,
  setJobCustomFieldValue,
  listResolvedJobCustomFields,
} from '../../src/jobs/job-custom-field';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

describe('job custom fields (J-CF) — pure domain', () => {
  let repo: InMemoryJobCustomFieldRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryJobCustomFieldRepository();
    audit = new InMemoryAuditRepository();
  });

  it('creates a typed def and emits an audit event', async () => {
    const def = await createJobCustomFieldDef(
      { tenantId: TENANT, key: 'po_number', label: 'PO Number', createdBy: ACTOR },
      repo,
      audit
    );
    expect(def.fieldType).toBe('text');
    const events = await audit.findByEntity(TENANT, 'job_custom_field_def', def.id);
    expect(events[0].eventType).toBe('job_custom_field.created');
  });

  it('rejects an invalid key and a duplicate key', async () => {
    await expect(
      createJobCustomFieldDef(
        { tenantId: TENANT, key: 'Bad Key', label: 'X', createdBy: ACTOR },
        repo
      )
    ).rejects.toThrow(/Validation failed/);
    await createJobCustomFieldDef(
      { tenantId: TENANT, key: 'permit', label: 'Permit', createdBy: ACTOR },
      repo
    );
    await expect(
      createJobCustomFieldDef(
        { tenantId: TENANT, key: 'permit', label: 'Permit 2', createdBy: ACTOR },
        repo
      )
    ).rejects.toThrow(/already exists/);
  });

  it('sets, validates, and clears a value; resolves defs+values for the editor', async () => {
    const tier = await createJobCustomFieldDef(
      {
        tenantId: TENANT,
        key: 'tier',
        label: 'Tier',
        fieldType: 'select',
        options: ['gold', 'silver'],
        createdBy: ACTOR,
      },
      repo
    );
    await expect(
      setJobCustomFieldValue(TENANT, JOB, tier.id, 'bronze', repo)
    ).rejects.toThrow(/not a valid option/);

    await setJobCustomFieldValue(TENANT, JOB, tier.id, 'gold', repo, ACTOR, audit);
    let resolved = await listResolvedJobCustomFields(TENANT, JOB, repo);
    expect(resolved.find((r) => r.key === 'tier')?.value).toBe('gold');

    await setJobCustomFieldValue(TENANT, JOB, tier.id, '', repo);
    resolved = await listResolvedJobCustomFields(TENANT, JOB, repo);
    expect(resolved.find((r) => r.key === 'tier')?.value).toBeNull();
  });

  it('rejects a value on an archived def and drops it from the resolved list', async () => {
    const def = await createJobCustomFieldDef(
      { tenantId: TENANT, key: 'amps', label: 'Amps', fieldType: 'number', createdBy: ACTOR },
      repo
    );
    await repo.archiveDef(TENANT, def.id);
    await expect(setJobCustomFieldValue(TENANT, JOB, def.id, '30', repo)).rejects.toThrow(/archived/);
    expect(await listResolvedJobCustomFields(TENANT, JOB, repo)).toHaveLength(0);
  });

  it('isolates defs by tenant', async () => {
    const def = await createJobCustomFieldDef(
      { tenantId: TENANT, key: 'k', label: 'K', createdBy: ACTOR },
      repo
    );
    const other = '99999999-9999-9999-9999-999999999999';
    expect(await repo.findDefById(other, def.id)).toBeNull();
    expect(await repo.listDefs(other)).toHaveLength(0);
  });
});
