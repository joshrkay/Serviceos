// Story 10.5 — Templated messages.
//
// Tenant-scoped, reusable customer-message templates with `{{variable}}`
// placeholders. The same store + render path is used by humans (via the
// CRUD/render route) and by the agent draft path (via the repository +
// `renderMessageTemplate` directly), so common texts are fast and consistent.
//
// Terminology: a tenant's configured terminology preferences
// (`tenant_settings.terminology_preferences`) are applied to the rendered
// text by reusing the existing `applyWordingPreferences` transform — no
// parallel terminology engine.

import { v4 as uuidv4 } from 'uuid';

import { ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  applyWordingPreferences,
  WordingPreference,
} from '../verticals/wording-preferences';

export type MessageTemplateChannel = 'sms' | 'email';
export type MessageTemplateCategory =
  | 'general'
  | 'appointment'
  | 'estimate'
  | 'invoice'
  | 'followup'
  | 'review';

export const MESSAGE_TEMPLATE_CHANNELS: readonly MessageTemplateChannel[] = [
  'sms',
  'email',
];
export const MESSAGE_TEMPLATE_CATEGORIES: readonly MessageTemplateCategory[] = [
  'general',
  'appointment',
  'estimate',
  'invoice',
  'followup',
  'review',
];

export interface MessageTemplate {
  id: string;
  tenantId: string;
  name: string;
  category: MessageTemplateCategory;
  channel: MessageTemplateChannel;
  /** Raw template body containing `{{variable}}` placeholders. */
  body: string;
  isActive: boolean;
  usageCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMessageTemplateInput {
  tenantId: string;
  name: string;
  category?: MessageTemplateCategory;
  channel?: MessageTemplateChannel;
  body: string;
  createdBy: string;
}

export interface UpdateMessageTemplateInput {
  name?: string;
  category?: MessageTemplateCategory;
  channel?: MessageTemplateChannel;
  body?: string;
  isActive?: boolean;
}

export interface MessageTemplateFilter {
  channel?: MessageTemplateChannel;
  category?: MessageTemplateCategory;
  activeOnly?: boolean;
}

export interface MessageTemplateRepository {
  create(template: MessageTemplate): Promise<MessageTemplate>;
  findById(tenantId: string, id: string): Promise<MessageTemplate | null>;
  findByTenant(
    tenantId: string,
    filter?: MessageTemplateFilter,
  ): Promise<MessageTemplate[]>;
  update(
    tenantId: string,
    id: string,
    updates: UpdateMessageTemplateInput,
  ): Promise<MessageTemplate | null>;
  incrementUsage(tenantId: string, id: string): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

// `{{ snake_case }}` — optional surrounding whitespace, alphanumeric + underscore.
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Distinct variable names referenced by a template body, in first-seen order. */
export function extractTemplateVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    found.add(match[1]);
  }
  return [...found];
}

export interface RenderMessageTemplateResult {
  text: string;
  /** Placeholders present in the body that had no supplied value. */
  missingVariables: string[];
}

/**
 * Substitute `{{variable}}` placeholders with supplied values, then apply
 * tenant terminology preferences. Unsupplied placeholders are left intact
 * (so the gap is visible to a reviewer) and reported in `missingVariables`
 * — callers must never auto-send a draft with missing variables.
 */
export function renderMessageTemplate(
  body: string,
  variables: Record<string, string>,
  terminology?: Record<string, string>,
): RenderMessageTemplateResult {
  const missing = new Set<string>();
  const substituted = body.replace(VARIABLE_PATTERN, (_full, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return `{{${key}}}`;
    }
    return String(value);
  });

  const text =
    terminology && Object.keys(terminology).length > 0
      ? applyTerminology(substituted, terminology)
      : substituted;

  return { text, missingVariables: [...missing] };
}

/**
 * Apply tenant terminology (canonical term -> preferred wording) by reusing
 * the existing `applyWordingPreferences` transform rather than a second
 * find/replace engine.
 */
function applyTerminology(
  text: string,
  terminology: Record<string, string>,
): string {
  const prefs: WordingPreference[] = Object.entries(terminology)
    .filter(([term, preferred]) => term && preferred)
    .map(([term, preferred]) => ({
      id: '',
      tenantId: '',
      scope: 'customer_message',
      key: term,
      preferredWording: preferred,
      avoidWordings: [term],
      isActive: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
  return applyWordingPreferences(text, prefs);
}

export function validateMessageTemplateInput(
  input: CreateMessageTemplateInput,
): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.name || !input.name.trim()) errors.push('name is required');
  if (!input.body || !input.body.trim()) errors.push('body is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (
    input.category &&
    !MESSAGE_TEMPLATE_CATEGORIES.includes(input.category)
  ) {
    errors.push('invalid category');
  }
  if (input.channel && !MESSAGE_TEMPLATE_CHANNELS.includes(input.channel)) {
    errors.push('invalid channel');
  }
  return errors;
}

export async function createMessageTemplate(
  input: CreateMessageTemplateInput,
  repo: MessageTemplateRepository,
  auditRepo?: AuditRepository,
  actorRole = 'owner',
): Promise<MessageTemplate> {
  const errors = validateMessageTemplateInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }

  const now = new Date();
  const template: MessageTemplate = {
    id: uuidv4(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    category: input.category ?? 'general',
    channel: input.channel ?? 'sms',
    body: input.body,
    isActive: true,
    usageCount: 0,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const created = await repo.create(template);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole,
        eventType: 'message_template.created',
        entityType: 'message_template',
        entityId: created.id,
        metadata: {
          name: created.name,
          channel: created.channel,
          category: created.category,
        },
      }),
    );
  }

  return created;
}

export async function updateMessageTemplate(
  repo: MessageTemplateRepository,
  tenantId: string,
  id: string,
  updates: UpdateMessageTemplateInput,
  actor: { userId: string; role: string },
  auditRepo?: AuditRepository,
): Promise<MessageTemplate | null> {
  if (
    updates.category &&
    !MESSAGE_TEMPLATE_CATEGORIES.includes(updates.category)
  ) {
    throw new ValidationError('Validation failed: invalid category');
  }
  if (updates.channel && !MESSAGE_TEMPLATE_CHANNELS.includes(updates.channel)) {
    throw new ValidationError('Validation failed: invalid channel');
  }
  if (updates.name !== undefined && !updates.name.trim()) {
    throw new ValidationError('Validation failed: name must not be empty');
  }
  if (updates.body !== undefined && !updates.body.trim()) {
    throw new ValidationError('Validation failed: body must not be empty');
  }

  const updated = await repo.update(tenantId, id, updates);
  if (updated && auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'message_template.updated',
        entityType: 'message_template',
        entityId: id,
        metadata: { fields: Object.keys(updates) },
      }),
    );
  }
  return updated;
}

export async function deleteMessageTemplate(
  repo: MessageTemplateRepository,
  tenantId: string,
  id: string,
  actor: { userId: string; role: string },
  auditRepo?: AuditRepository,
): Promise<boolean> {
  const deleted = await repo.delete(tenantId, id);
  if (deleted && auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'message_template.deleted',
        entityType: 'message_template',
        entityId: id,
      }),
    );
  }
  return deleted;
}

export class InMemoryMessageTemplateRepository
  implements MessageTemplateRepository
{
  private templates: Map<string, MessageTemplate> = new Map();

  async create(template: MessageTemplate): Promise<MessageTemplate> {
    this.templates.set(template.id, { ...template });
    return { ...template };
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<MessageTemplate | null> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return null;
    return { ...t };
  }

  async findByTenant(
    tenantId: string,
    filter?: MessageTemplateFilter,
  ): Promise<MessageTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.tenantId === tenantId)
      .filter((t) => (filter?.channel ? t.channel === filter.channel : true))
      .filter((t) =>
        filter?.category ? t.category === filter.category : true,
      )
      .filter((t) => (filter?.activeOnly ? t.isActive : true))
      .map((t) => ({ ...t }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async update(
    tenantId: string,
    id: string,
    updates: UpdateMessageTemplateInput,
  ): Promise<MessageTemplate | null> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return null;
    const updated: MessageTemplate = {
      ...t,
      ...updates,
      updatedAt: new Date(),
    };
    this.templates.set(id, updated);
    return { ...updated };
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return;
    t.usageCount += 1;
    t.updatedAt = new Date();
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return false;
    this.templates.delete(id);
    return true;
  }
}
