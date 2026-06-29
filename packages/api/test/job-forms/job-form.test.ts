import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryJobFormRepository,
  archiveJobFormTemplate,
  createJobFormSubmission,
  createJobFormTemplate,
  normalizeAnswers,
  normalizeFields,
  updateJobFormSubmission,
  updateJobFormTemplate,
  validateAnswerValue,
  validateJobFormTemplateInput,
  validateSubmissionAnswers,
  type JobFormField,
} from '../../src/job-forms/job-form';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

function field(overrides: Partial<JobFormField> = {}): JobFormField {
  return {
    id: 'f1',
    label: 'Notes',
    fieldType: 'text',
    options: [],
    required: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe('job forms & checklists (J-FORM) — pure domain', () => {
  let repo: InMemoryJobFormRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryJobFormRepository();
    audit = new InMemoryAuditRepository();
  });

  it('validates a template: needs a name and at least one valid field', () => {
    expect(validateJobFormTemplateInput({ name: '', fields: [{ label: 'X' }] })).toContain(
      'name is required'
    );
    expect(validateJobFormTemplateInput({ name: 'Tuneup', fields: [] })).toContain(
      'a template needs at least one field'
    );
    expect(
      validateJobFormTemplateInput({
        name: 'Tuneup',
        fields: [{ label: 'Tier', fieldType: 'select' }],
      })
    ).toEqual(['field 1: select field "Tier" requires at least one option']);
    expect(
      validateJobFormTemplateInput({ name: 'Tuneup', fields: [{ label: 'Notes' }] })
    ).toHaveLength(0);
  });

  it('normalizeFields assigns ids, defaults type, strips options off non-select, and orders', () => {
    const out = normalizeFields([
      { label: ' Tier ', fieldType: 'select', options: [' gold ', '', 'silver'] },
      { id: 'keep-me', label: 'Done', fieldType: 'checkbox', options: ['ignored'] },
    ]);
    expect(out[0].id).toBeTruthy();
    expect(out[0].label).toBe('Tier');
    expect(out[0].options).toEqual(['gold', 'silver']);
    expect(out[0].sortOrder).toBe(0);
    // Caller-supplied id is preserved so edits keep answers attached.
    expect(out[1].id).toBe('keep-me');
    // Non-select fields drop options.
    expect(out[1].options).toEqual([]);
    expect(out[1].sortOrder).toBe(1);
  });

  it('validates an answer value against its field type', () => {
    expect(validateAnswerValue(field({ fieldType: 'number' }), 'abc')).toMatch(/must be a number/);
    expect(validateAnswerValue(field({ fieldType: 'number' }), '42')).toBeNull();
    expect(validateAnswerValue(field({ fieldType: 'date' }), '2026/01/01')).toMatch(/must be a date/);
    expect(validateAnswerValue(field({ fieldType: 'date' }), '2026-01-01')).toBeNull();
    expect(validateAnswerValue(field({ fieldType: 'checkbox' }), 'yes')).toMatch(/true or false/);
    expect(validateAnswerValue(field({ fieldType: 'checkbox' }), 'true')).toBeNull();
    expect(
      validateAnswerValue(field({ fieldType: 'select', options: ['a', 'b'] }), 'c')
    ).toMatch(/not a valid option/);
    expect(
      validateAnswerValue(field({ fieldType: 'select', options: ['a', 'b'] }), 'a')
    ).toBeNull();
    // Blank is always allowed at the value level.
    expect(validateAnswerValue(field({ fieldType: 'number' }), '')).toBeNull();
  });

  it('rejects unknown field ids and enforces required only on completion', () => {
    const fields = [field({ id: 'req', label: 'Serial', required: true })];
    // Unknown field id is always an error.
    expect(validateSubmissionAnswers(fields, [{ fieldId: 'ghost', value: 'x' }])).toContain(
      'unknown field "ghost"'
    );
    // Missing required is fine for a draft...
    expect(validateSubmissionAnswers(fields, [])).toHaveLength(0);
    // ...but blocks completion.
    expect(validateSubmissionAnswers(fields, [], { requireComplete: true })).toContain(
      '"Serial" is required'
    );
  });

  it('treats an unchecked required checkbox as missing on completion', () => {
    const fields = [field({ id: 'safety', label: 'Safety check', fieldType: 'checkbox', required: true })];
    expect(
      validateSubmissionAnswers(fields, [{ fieldId: 'safety', value: 'false' }], {
        requireComplete: true,
      })
    ).toContain('"Safety check" is required');
    expect(
      validateSubmissionAnswers(fields, [{ fieldId: 'safety', value: 'true' }], {
        requireComplete: true,
      })
    ).toHaveLength(0);
  });

  it('normalizeAnswers trims, drops blanks, and keeps the latest per field', () => {
    expect(
      normalizeAnswers([
        { fieldId: 'a', value: ' hi ' },
        { fieldId: 'b', value: '   ' },
        { fieldId: 'a', value: 'final' },
      ])
    ).toEqual([{ fieldId: 'a', value: 'final' }]);
  });

  it('creates a template and emits an audit event', async () => {
    const tpl = await createJobFormTemplate(
      {
        tenantId: TENANT,
        name: 'Furnace Tune-Up',
        fields: [{ label: 'Filter replaced', fieldType: 'checkbox' }],
        createdBy: ACTOR,
      },
      repo,
      audit
    );
    expect(tpl.fields).toHaveLength(1);
    expect(await repo.listTemplates(TENANT)).toHaveLength(1);
    const events = await audit.findByEntity(TENANT, 'job_form_template', tpl.id);
    expect(events[0].eventType).toBe('job_form_template.created');
  });

  it('updates a template and archived templates drop out of the active list', async () => {
    const tpl = await createJobFormTemplate(
      { tenantId: TENANT, name: 'Inspect', fields: [{ label: 'A' }], createdBy: ACTOR },
      repo
    );
    const renamed = await updateJobFormTemplate(
      TENANT,
      tpl.id,
      { name: 'Inspection' },
      repo,
      ACTOR,
      audit
    );
    expect(renamed.name).toBe('Inspection');
    expect(renamed.fields).toHaveLength(1); // unchanged fields preserved

    await archiveJobFormTemplate(TENANT, tpl.id, repo, ACTOR, audit);
    expect(await repo.listTemplates(TENANT)).toHaveLength(0);
    expect(await repo.listTemplates(TENANT, true)).toHaveLength(1);
  });

  it('snapshots template fields onto the submission so later edits do not change history', async () => {
    const tpl = await createJobFormTemplate(
      {
        tenantId: TENANT,
        name: 'Checklist',
        fields: [{ label: 'Step 1', fieldType: 'checkbox' }],
        createdBy: ACTOR,
      },
      repo
    );
    const fieldId = tpl.fields[0].id;
    const sub = await createJobFormSubmission(
      {
        tenantId: TENANT,
        jobId: JOB,
        templateId: tpl.id,
        answers: [{ fieldId, value: 'true' }],
        createdBy: ACTOR,
      },
      repo,
      audit
    );
    expect(sub.status).toBe('draft');
    expect(sub.templateName).toBe('Checklist');
    expect(sub.fields).toHaveLength(1);

    // Editing the template afterward must not mutate the existing submission.
    await updateJobFormTemplate(
      TENANT,
      tpl.id,
      { fields: [{ label: 'Step 1 changed', fieldType: 'text' }] },
      repo
    );
    const reloaded = await repo.findSubmissionById(TENANT, sub.id);
    expect(reloaded!.fields[0].label).toBe('Step 1');
    expect(reloaded!.fields[0].fieldType).toBe('checkbox');
  });

  it('blocks completing a submission with a missing required field, then completes it', async () => {
    const tpl = await createJobFormTemplate(
      {
        tenantId: TENANT,
        name: 'Safety',
        fields: [{ label: 'Serial', required: true }],
        createdBy: ACTOR,
      },
      repo
    );
    const fieldId = tpl.fields[0].id;
    const sub = await createJobFormSubmission(
      { tenantId: TENANT, jobId: JOB, templateId: tpl.id, createdBy: ACTOR },
      repo
    );

    await expect(
      updateJobFormSubmission(TENANT, sub.id, { complete: true }, repo, ACTOR)
    ).rejects.toThrow(/"Serial" is required/);

    const completed = await updateJobFormSubmission(
      TENANT,
      sub.id,
      { answers: [{ fieldId, value: 'SN-123' }], complete: true },
      repo,
      ACTOR,
      audit
    );
    expect(completed.status).toBe('completed');
    expect(completed.completedBy).toBe(ACTOR);
    expect(completed.completedAt).toBeInstanceOf(Date);
    const events = await audit.findByEntity(TENANT, 'job', JOB);
    expect(events.some((e) => e.eventType === 'job_form_submission.completed')).toBe(true);
  });

  it('rejects rolled-over calendar dates (strict YYYY-MM-DD)', () => {
    const dateField = field({ id: 'd', label: 'Service date', fieldType: 'date' });
    expect(validateAnswerValue(dateField, '2026-02-30')).toMatch(/must be a date/); // rolls over
    expect(validateAnswerValue(dateField, '2026-02-28')).toBeNull();
    expect(validateAnswerValue(dateField, '2028-02-29')).toBeNull(); // leap year
  });

  it('locks a completed submission against further edits', async () => {
    const tpl = await createJobFormTemplate(
      { tenantId: TENANT, name: 'Lock', fields: [{ label: 'Note' }], createdBy: ACTOR },
      repo
    );
    const fieldId = tpl.fields[0].id;
    const sub = await createJobFormSubmission(
      {
        tenantId: TENANT,
        jobId: JOB,
        templateId: tpl.id,
        answers: [{ fieldId, value: 'done' }],
        complete: true,
        createdBy: ACTOR,
      },
      repo
    );
    expect(sub.status).toBe('completed');
    await expect(
      updateJobFormSubmission(TENANT, sub.id, { answers: [{ fieldId, value: 'tampered' }] }, repo, ACTOR)
    ).rejects.toThrow(/completed and can no longer be edited/);
  });

  it('rejects a submission for a template that does not exist', async () => {
    await expect(
      createJobFormSubmission(
        { tenantId: TENANT, jobId: JOB, templateId: 'nope', createdBy: ACTOR },
        repo
      )
    ).rejects.toThrow(/not found/);
  });

  it('rejects a new submission against an archived template', async () => {
    const tpl = await createJobFormTemplate(
      { tenantId: TENANT, name: 'Retired', fields: [{ label: 'A' }], createdBy: ACTOR },
      repo
    );
    await archiveJobFormTemplate(TENANT, tpl.id, repo, ACTOR);
    await expect(
      createJobFormSubmission(
        { tenantId: TENANT, jobId: JOB, templateId: tpl.id, createdBy: ACTOR },
        repo
      )
    ).rejects.toThrow(/archived/);
  });

  it('isolates templates and submissions by tenant', async () => {
    const tpl = await createJobFormTemplate(
      { tenantId: TENANT, name: 'T', fields: [{ label: 'A' }], createdBy: ACTOR },
      repo
    );
    const other = '99999999-9999-9999-9999-999999999999';
    expect(await repo.findTemplateById(other, tpl.id)).toBeNull();
    expect(await repo.listTemplates(other)).toHaveLength(0);
  });
});
