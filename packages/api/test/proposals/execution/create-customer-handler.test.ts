/**
 * P18-001 — `create-customer-handler` execution-handler tests.
 *
 * Covers AC-4 (audit event with correlationId tying the executed
 * proposal to the voice session) plus the safety paths from the
 * 15 secondary scenarios.
 */
import { describe, it, expect } from 'vitest';
import { CreateCustomerVoiceExecutionHandler, splitName } from '../../../src/proposals/execution/create-customer-handler';
import { createProposal } from '../../../src/proposals/proposal';
import {
  InMemoryCustomerRepository,
} from '../../../src/customers/customer';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = 'tenant-1';
const EXECUTOR = 'voice_agent';

function makeProposal(payload: Record<string, unknown>, opts?: { sourceContext?: Record<string, unknown> }) {
  return createProposal({
    tenantId: TENANT,
    proposalType: 'create_customer',
    payload,
    summary: 'create customer from voice',
    createdBy: EXECUTOR,
    sourceContext: opts?.sourceContext,
  });
}

describe('P18-001 create_customer execution handler', () => {
  it('persists a customer record and returns its id (AC-4 happy path)', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateCustomerVoiceExecutionHandler(customerRepo, auditRepo);

    const proposal = makeProposal({
      name: 'Alex Smith',
      phone: '+15551230100',
      email: 'alex@example.com',
      voice: { sessionId: 'sess-1', callSid: 'CA-1' },
      smsConsent: false,
    });

    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: EXECUTOR,
    });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const created = await customerRepo.findById(TENANT, result.resultEntityId!);
    expect(created).not.toBeNull();
    expect(created!.firstName).toBe('Alex');
    expect(created!.lastName).toBe('Smith');
    expect(created!.primaryPhone).toBe('+15551230100');
    expect(created!.email).toBe('alex@example.com');
    expect(created!.smsConsent).toBe(false);
  });

  it('emits an audit event with correlationId = sessionId for AC-4', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateCustomerVoiceExecutionHandler(customerRepo, auditRepo);

    const proposal = makeProposal({
      name: 'Maria Gomez',
      phone: '+15551230202',
      voice: { sessionId: 'voice-session-42' },
    });

    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: EXECUTOR,
    });
    expect(result.success).toBe(true);

    const audits = auditRepo.getAll();
    const exec = audits.find((a) => a.eventType === 'proposal.executed');
    expect(exec).toBeDefined();
    expect(exec!.correlationId).toBe('voice-session-42');
    expect(exec!.entityId).toBe(result.resultEntityId);
    const meta = exec!.metadata as Record<string, unknown>;
    expect(meta.proposalId).toBe(proposal.id);
    expect(meta.proposalType).toBe('create_customer');
    expect(meta.source).toBe('voice');
  });

  it('reads correlationId from sourceContext when payload.voice missing', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateCustomerVoiceExecutionHandler(customerRepo, auditRepo);

    const proposal = makeProposal(
      { name: 'Sarah Connor', phone: '+15550000001' },
      { sourceContext: { correlationId: 'sess-from-ctx' } },
    );

    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: EXECUTOR,
    });
    expect(result.success).toBe(true);
    const audits = auditRepo.getAll();
    const exec = audits.find((a) => a.eventType === 'proposal.executed');
    expect(exec!.correlationId).toBe('sess-from-ctx');
  });

  it('rejects payloads missing the required name field (path 9 — Zod parity)', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const handler = new CreateCustomerVoiceExecutionHandler(customerRepo);

    const proposal = makeProposal({ phone: '+15551239999' });
    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: EXECUTOR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/i);
  });

  it('falls back to synthetic id when no CustomerRepository wired (in-memory test parity)', async () => {
    const handler = new CreateCustomerVoiceExecutionHandler();
    const proposal = makeProposal({ name: 'Stub Person' });
    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: EXECUTOR,
    });
    expect(result.success).toBe(true);
    expect(typeof result.resultEntityId).toBe('string');
  });

  it('emits the canonical customer.created audit row (path 14 — observability)', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateCustomerVoiceExecutionHandler(customerRepo, auditRepo);
    const proposal = makeProposal({ name: 'Pat Smith', phone: '+15558884444' });
    await handler.execute(proposal, { tenantId: TENANT, executedBy: EXECUTOR });
    const audits = auditRepo.getAll();
    const created = audits.find((a) => a.eventType === 'customer.created');
    expect(created).toBeDefined();
    expect(created!.actorRole).toBe('voice_agent');
  });

  it('preferredChannel defaults to phone when only phone provided', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const handler = new CreateCustomerVoiceExecutionHandler(customerRepo);
    const proposal = makeProposal({ name: 'P One', phone: '+15558884444' });
    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: EXECUTOR });
    expect(result.success).toBe(true);
    const created = await customerRepo.findById(TENANT, result.resultEntityId!);
    expect(created!.preferredChannel).toBe('phone');
  });
});

describe('P18-001 splitName helper', () => {
  it('splits "First Last" into firstName + lastName', () => {
    expect(splitName('Alex Smith')).toEqual({ firstName: 'Alex', lastName: 'Smith' });
  });

  it('keeps a single-token name as firstName', () => {
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });

  it('treats everything after the first space as lastName (multi-word last names)', () => {
    expect(splitName('Maria de la Cruz')).toEqual({ firstName: 'Maria', lastName: 'de la Cruz' });
  });

  it('handles whitespace gracefully', () => {
    expect(splitName('  Alex  Smith  ')).toEqual({ firstName: 'Alex', lastName: 'Smith' });
  });
});
