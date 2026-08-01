import { describe, it, expect } from 'vitest';

import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ValidationError } from '../../src/shared/errors';
import {
  InMemoryMessageTemplateRepository,
  createMessageTemplate,
  deleteMessageTemplate,
  extractTemplateVariables,
  renderMessageTemplate,
  updateMessageTemplate,
  validateMessageTemplateInput,
} from '../../src/messaging/message-template';

describe('extractTemplateVariables', () => {
  it('returns distinct variable names in first-seen order', () => {
    const vars = extractTemplateVariables(
      'Hi {{customer_name}}, see you {{appointment_time}}. — {{customer_name}}',
    );
    expect(vars).toEqual(['customer_name', 'appointment_time']);
  });

  it('tolerates surrounding whitespace in placeholders', () => {
    expect(extractTemplateVariables('Hello {{ name }}!')).toEqual(['name']);
  });

  it('returns empty array when there are no placeholders', () => {
    expect(extractTemplateVariables('No variables here.')).toEqual([]);
  });
});

describe('renderMessageTemplate', () => {
  it('substitutes supplied variables', () => {
    const result = renderMessageTemplate(
      'Hi {{name}}, your tech arrives at {{time}}.',
      { name: 'Sam', time: '2pm' },
    );
    expect(result.text).toBe('Hi Sam, your tech arrives at 2pm.');
    expect(result.missingVariables).toEqual([]);
  });

  it('leaves unfilled placeholders intact and reports them', () => {
    const result = renderMessageTemplate('Hi {{name}}, ref {{ticket}}.', {
      name: 'Sam',
    });
    expect(result.text).toBe('Hi Sam, ref {{ticket}}.');
    expect(result.missingVariables).toEqual(['ticket']);
  });

  it('treats empty-string values as missing', () => {
    const result = renderMessageTemplate('Hi {{name}}', { name: '' });
    expect(result.missingVariables).toEqual(['name']);
    expect(result.text).toBe('Hi {{name}}');
  });

  it('applies tenant terminology after substitution', () => {
    const result = renderMessageTemplate(
      'Your {{thing}} is ready.',
      { thing: 'job' },
      { job: 'project' },
    );
    expect(result.text).toBe('Your project is ready.');
  });

  it('ignores terminology when none is configured', () => {
    const result = renderMessageTemplate('Your job is ready.', {}, {});
    expect(result.text).toBe('Your job is ready.');
  });
});

describe('validateMessageTemplateInput', () => {
  it('requires tenantId, name, body, createdBy', () => {
    const errors = validateMessageTemplateInput({
      tenantId: '',
      name: '  ',
      body: '',
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('name is required');
    expect(errors).toContain('body is required');
    expect(errors).toContain('createdBy is required');
  });

  it('rejects invalid channel and category', () => {
    const errors = validateMessageTemplateInput({
      tenantId: 't',
      name: 'n',
      body: 'b',
      createdBy: 'u',
      channel: 'pigeon' as never,
      category: 'spam' as never,
    });
    expect(errors).toContain('invalid channel');
    expect(errors).toContain('invalid category');
  });
});

describe('createMessageTemplate', () => {
  it('defaults channel/category, trims name, and emits an audit event', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    const audit = new InMemoryAuditRepository();
    const created = await createMessageTemplate(
      {
        tenantId: 'tenant-1',
        name: '  On the way  ',
        body: 'Hi {{name}}',
        createdBy: 'user-1',
      },
      repo,
      audit,
    );

    expect(created.name).toBe('On the way');
    expect(created.channel).toBe('sms');
    expect(created.category).toBe('general');
    expect(created.usageCount).toBe(0);
    expect(created.isActive).toBe(true);

    const events = await audit.findByEntity(
      'tenant-1',
      'message_template',
      created.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('message_template.created');
  });

  it('throws ValidationError on invalid input', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    await expect(
      createMessageTemplate(
        { tenantId: 'tenant-1', name: '', body: '', createdBy: 'u' },
        repo,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('updateMessageTemplate / deleteMessageTemplate', () => {
  it('updates fields and emits an audit event', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    const audit = new InMemoryAuditRepository();
    const created = await createMessageTemplate(
      { tenantId: 't', name: 'A', body: 'b', createdBy: 'u' },
      repo,
    );

    const updated = await updateMessageTemplate(
      repo,
      't',
      created.id,
      { name: 'B', isActive: false },
      { userId: 'u', role: 'owner' },
      audit,
    );
    expect(updated?.name).toBe('B');
    expect(updated?.isActive).toBe(false);

    const events = await audit.findByEntity('t', 'message_template', created.id);
    expect(events[0].eventType).toBe('message_template.updated');
  });

  it('rejects an empty body on update', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    const created = await createMessageTemplate(
      { tenantId: 't', name: 'A', body: 'b', createdBy: 'u' },
      repo,
    );
    await expect(
      updateMessageTemplate(
        repo,
        't',
        created.id,
        { body: '   ' },
        { userId: 'u', role: 'owner' },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deletes and emits an audit event', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    const audit = new InMemoryAuditRepository();
    const created = await createMessageTemplate(
      { tenantId: 't', name: 'A', body: 'b', createdBy: 'u' },
      repo,
    );

    const deleted = await deleteMessageTemplate(
      repo,
      't',
      created.id,
      { userId: 'u', role: 'owner' },
      audit,
    );
    expect(deleted).toBe(true);
    expect(await repo.findById('t', created.id)).toBeNull();
    const events = await audit.findByEntity('t', 'message_template', created.id);
    expect(events[0].eventType).toBe('message_template.deleted');
  });
});

describe('InMemoryMessageTemplateRepository tenant isolation', () => {
  it('does not return another tenant template', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    const created = await createMessageTemplate(
      { tenantId: 'tenant-a', name: 'A', body: 'b', createdBy: 'u' },
      repo,
    );
    expect(await repo.findById('tenant-b', created.id)).toBeNull();
    expect(await repo.findByTenant('tenant-b')).toHaveLength(0);
  });

  it('filters by channel', async () => {
    const repo = new InMemoryMessageTemplateRepository();
    await createMessageTemplate(
      {
        tenantId: 't',
        name: 'sms one',
        body: 'b',
        createdBy: 'u',
        channel: 'sms',
      },
      repo,
    );
    await createMessageTemplate(
      {
        tenantId: 't',
        name: 'email one',
        body: 'b',
        createdBy: 'u',
        channel: 'email',
      },
      repo,
    );
    const smsOnly = await repo.findByTenant('t', { channel: 'sms' });
    expect(smsOnly).toHaveLength(1);
    expect(smsOnly[0].channel).toBe('sms');
  });
});
