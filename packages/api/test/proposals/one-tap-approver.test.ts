/**
 * B1 — a one-tap link approves as the person it was sent to.
 *
 * When a tenant has no owner phone, the unsupervised "tap to approve" text
 * goes to the backup supervisor's mobile (app.ts resolveUnsupervisedOwnerPhone),
 * and the link then approved as 'owner'. The token now carries the recipient's
 * user id and role when the recipient is not the owner, and the route acts
 * with them; an owner link is byte-identical to before. A recipient the
 * resolver does not recognise as an approver gets no link at all.
 */
import { describe, it, expect } from 'vitest';
import {
  createOneTapApproveToken,
  verifyOneTapApproveToken,
  createInMemoryNonceStore,
  routeUnsupervisedProposal,
} from '../../src/proposals/auto-approve';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createHmac } from 'crypto';

const SECRET = 'b1-one-tap-secret';
const BACKUP_PHONE = '+15125550111';
const OWNER_PHONE = '+15125550100';

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function resign(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${createHmac('sha256', SECRET).update(b64).digest('base64url')}`;
}

const verify = (token: string) =>
  verifyOneTapApproveToken({ token, secret: SECRET, consumeNonce: createInMemoryNonceStore() });

describe('B1 — the one-tap token carries a non-owner recipient', () => {
  it('round-trips the recipient user id and role', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'p-1',
      tenantId: 't-1',
      secret: SECRET,
      approver: { userId: 'clerk-backup', role: 'dispatcher' },
    });
    await expect(verify(token)).resolves.toEqual({
      ok: true,
      action: 'approve',
      proposalId: 'p-1',
      tenantId: 't-1',
      approver: { userId: 'clerk-backup', role: 'dispatcher' },
    });
  });

  it('an owner token is unchanged: exactly p, t, n, e and no approver on verify', async () => {
    const { token } = createOneTapApproveToken({ proposalId: 'p-1', tenantId: 't-1', secret: SECRET });
    expect(Object.keys(payloadOf(token)).sort()).toEqual(['e', 'n', 'p', 't']);
    await expect(verify(token)).resolves.not.toHaveProperty('approver');
  });

  it.each([
    ['an unknown role', { u: 'clerk-backup', r: 'superuser' }],
    ['a user id without a role', { u: 'clerk-backup' }],
    ['a role without a user id', { r: 'dispatcher' }],
    ['an empty user id', { u: '', r: 'dispatcher' }],
  ])('a signed token with %s is malformed', async (_label, claims) => {
    const { token } = createOneTapApproveToken({ proposalId: 'p-1', tenantId: 't-1', secret: SECRET });
    await expect(verify(resign({ ...payloadOf(token), ...claims }))).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('B1 — routeUnsupervisedProposal mints the link for its recipient', () => {
  function route(
    resolved: Awaited<ReturnType<NonNullable<Parameters<typeof routeUnsupervisedProposal>[0]['resolveLinkApprover']>>> | Error,
    ownerPhone: string,
  ) {
    const auditRepo = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];
    const anchors: string[] = [];
    const lookups: string[] = [];
    const forms: unknown[] = [];
    const run = routeUnsupervisedProposal(
      {
        auditRepo,
        secret: SECRET,
        sendSms: async (to, body) => {
          sms.push({ to, body });
        },
        buildApproveUrl: (token) => `https://app.test/approve?token=${token}`,
        resolveLinkApprover: async (_tenantId, phone) => {
          lookups.push(phone);
          if (resolved instanceof Error) throw resolved;
          return resolved;
        },
        onSmsSent: async ({ kind }) => {
          anchors.push(kind);
        },
      },
      {
        tenantId: 't-1',
        proposalId: 'prop-1',
        channel: 'other',
        ownerPhone,
        summaryText: 'Book Mrs Lee',
        renderSmsBody: (url, form) => {
          forms.push(form);
          return url ? `Book Mrs Lee. Tap: ${url}` : 'Book Mrs Lee. Review in the app.';
        },
      },
    );
    return { run, auditRepo, sms, anchors, lookups, forms };
  }

  const tokenIn = (body: string) => body.match(/token=([A-Za-z0-9._-]+)/)?.[1];

  it("the backup's link carries their user id and role", async () => {
    const r = route({ role: 'dispatcher', userId: 'clerk-backup', via: 'backup_supervisor' }, BACKUP_PHONE);
    await r.run;

    expect(r.lookups).toEqual([BACKUP_PHONE]);
    const token = tokenIn(r.sms[0].body)!;
    expect(payloadOf(token)).toMatchObject({ u: 'clerk-backup', r: 'dispatcher' });
    await expect(verify(token)).resolves.toMatchObject({
      approver: { userId: 'clerk-backup', role: 'dispatcher' },
    });
  });

  it("the owner's link is the plain owner token", async () => {
    const r = route({ role: 'owner', via: 'owner_phone' }, OWNER_PHONE);
    await r.run;

    expect(Object.keys(payloadOf(tokenIn(r.sms[0].body)!)).sort()).toEqual(['e', 'n', 'p', 't']);
    expect(r.forms).toEqual([{ recipientCannotApprove: false }]);
  });

  it.each([
    ['is not a recognised approver', null],
    ['holds a role that cannot approve (a technician backup)', { role: 'technician', userId: 'clerk-tech', via: 'backup_supervisor' }],
    ['cannot be looked up (the lookup throws)', new Error('db down')],
  ] as const)('a recipient who %s gets no link (review form only)', async (_label, resolved) => {
    const r = route(resolved, BACKUP_PHONE);
    const result = await r.run;

    expect(result.smsSent).toBe(true);
    expect(result.approveLinkExpiresAt).toBeUndefined();
    expect(r.sms[0].body).not.toContain('token=');
    expect(r.anchors).toEqual(['review_required_rendered']);
    // B1 follow-up — the renderer is told, so it drops every reply prompt
    // (their Y, N and EDIT are all refused), not just the link.
    expect(r.forms).toEqual([{ recipientCannotApprove: true }]);
    const routed = r.auditRepo.getAll().find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed?.metadata).toMatchObject({ suppressReason: 'recipient_cannot_approve' });
  });
});
