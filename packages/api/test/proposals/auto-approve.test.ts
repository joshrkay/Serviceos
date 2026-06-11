import { describe, it, expect } from 'vitest';
import {
  resolveAutoApproveThreshold,
  shouldAutoApprove,
  DEFAULT_AUTO_APPROVE_THRESHOLDS,
  LEGACY_AUTO_APPROVE_THRESHOLD,
} from '../../src/proposals/auto-approve';
import { decideInitialStatus } from '../../src/proposals/proposal';

describe('P12-004 — resolveAutoApproveThreshold', () => {
  it('returns null when supervisorPresent === false (unsupervised hard-block)', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'supervisor',
        supervisorPresent: false,
      }),
    ).toBeNull();

    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'tech',
        supervisorPresent: false,
      }),
    ).toBeNull();
  });

  it('returns the legacy 0.9 default when supervisorMode is unset', () => {
    expect(resolveAutoApproveThreshold({})).toBe(LEGACY_AUTO_APPROVE_THRESHOLD);
    expect(resolveAutoApproveThreshold({ supervisorPresent: true })).toBe(
      LEGACY_AUTO_APPROVE_THRESHOLD,
    );
  });

  it('returns the locked per-mode defaults when no override is supplied', () => {
    expect(resolveAutoApproveThreshold({ supervisorMode: 'supervisor' })).toBe(
      DEFAULT_AUTO_APPROVE_THRESHOLDS.supervisor,
    );
    expect(resolveAutoApproveThreshold({ supervisorMode: 'both' })).toBe(
      DEFAULT_AUTO_APPROVE_THRESHOLDS.both,
    );
    expect(resolveAutoApproveThreshold({ supervisorMode: 'tech' })).toBe(
      DEFAULT_AUTO_APPROVE_THRESHOLDS.tech,
    );

    // Sanity: the locked defaults match the values in the plan doc.
    expect(DEFAULT_AUTO_APPROVE_THRESHOLDS.supervisor).toBe(0.9);
    expect(DEFAULT_AUTO_APPROVE_THRESHOLDS.both).toBe(0.92);
    expect(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech).toBe(0.95);
  });

  it('honors per-tenant overrides when present', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'supervisor',
        tenantOverride: { supervisor: 0.85 },
      }),
    ).toBe(0.85);

    // Override only set for one mode — others fall through to defaults.
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'tech',
        tenantOverride: { supervisor: 0.85 },
      }),
    ).toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech);
  });

  it('unsupervised hard-block beats every override', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'supervisor',
        supervisorPresent: false,
        tenantOverride: { supervisor: 0.5 }, // very permissive
      }),
    ).toBeNull();
  });

  it('explicit supervisorPresent === true still resolves a number', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'tech',
        supervisorPresent: true,
      }),
    ).toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech);
  });
});

describe('P12-004 — shouldAutoApprove (boundary behavior)', () => {
  it('returns false when threshold is null', () => {
    expect(shouldAutoApprove(0.99, null)).toBe(false);
    expect(shouldAutoApprove(1.0, null)).toBe(false);
  });

  it('returns false when confidence is undefined', () => {
    expect(shouldAutoApprove(undefined, 0.9)).toBe(false);
  });

  it('uses inclusive >= comparison at the boundary', () => {
    expect(shouldAutoApprove(0.9, 0.9)).toBe(true); // exactly at threshold
    expect(shouldAutoApprove(0.95, 0.95)).toBe(true);
    expect(shouldAutoApprove(0.8999, 0.9)).toBe(false);
    expect(shouldAutoApprove(0.91, 0.92)).toBe(false);
  });
});

describe('P12-004 — decideInitialStatus integration via auto-approve', () => {
  // Full integration is exercised via proposal.test.ts; this block
  // ensures the helper matrix is correct from the consumer's POV.
  it('maps the three lock-in modes to the documented status outputs', () => {
    // High confidence (0.96) — should auto-approve in any mode that
    // resolves a threshold below 0.96.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer', // capture-class
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.96,
        supervisorMode: 'supervisor', // threshold 0.90
        supervisorPresent: true,
      }),
    ).toBe('approved');

    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.96,
        supervisorMode: 'tech', // threshold 0.95
        supervisorPresent: true,
      }),
    ).toBe('approved');

    // Just under tech threshold — same proposal under supervisor mode
    // approves; under tech it stays draft.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.93,
        supervisorMode: 'supervisor',
        supervisorPresent: true,
      }),
    ).toBe('approved');

    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.93,
        supervisorMode: 'tech',
        supervisorPresent: true,
      }),
    ).toBe('draft');

    // Unsupervised — would-have-auto-approved proposals surface in
    // 'ready_for_review' so the unsupervised-routing worker picks them
    // up. Note this is a Phase-12 behavior change: pre-P12, an
    // autonomous + capture + 0.96 always landed in 'approved' regardless
    // of whether anyone was watching.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.96,
        supervisorMode: 'supervisor',
        supervisorPresent: false,
      }),
    ).toBe('ready_for_review');
  });

  it('preserves pre-Phase-12 behavior when supervisorMode is not threaded', () => {
    // No supervisorMode + no supervisorPresent => legacy 0.9 threshold.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.91,
      }),
    ).toBe('approved');

    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.89,
      }),
    ).toBe('draft');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P12-004 — one-tap re-approve token + unsupervised routing
// ───────────────────────────────────────────────────────────────────────────

import {
  createOneTapApproveToken,
  verifyOneTapApproveToken,
  createInMemoryNonceStore,
  routeUnsupervisedProposal,
  ONE_TAP_APPROVE_MAX_TTL_MS,
} from '../../src/proposals/auto-approve';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const SECRET = 'test-secret';

describe('P12-004 — one-tap approve token (HMAC, single-use, TTL)', () => {
  it('round-trips a valid token bound to proposal + tenant', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'prop-1',
      tenantId: 'tenant-1',
      secret: SECRET,
    });
    const result = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      expectedTenantId: 'tenant-1',
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: true, proposalId: 'prop-1', tenantId: 'tenant-1' });
  });

  it('rejects a tampered payload (bad signature)', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'prop-1',
      tenantId: 'tenant-1',
      secret: SECRET,
    });
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ p: 'prop-EVIL', t: 'tenant-1', n: 'x', e: Date.now() + 60000 }),
    ).toString('base64url');
    const result = await verifyOneTapApproveToken({
      token: `${forged}.${sig}`,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(payload).toBeTruthy();
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'p',
      tenantId: 't',
      secret: 'other-secret',
    });
    const result = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tenant mismatch', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'p',
      tenantId: 'tenant-A',
      secret: SECRET,
    });
    const result = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      expectedTenantId: 'tenant-B',
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });

  it('expires after the TTL and clamps TTL to 30 minutes', async () => {
    const now = 1_000_000;
    const { token, expiresAt } = createOneTapApproveToken({
      proposalId: 'p',
      tenantId: 't',
      secret: SECRET,
      ttlMs: 99 * 60 * 1000, // requested 99 min — must clamp to 30
      nowMs: now,
    });
    expect(expiresAt.getTime()).toBe(now + ONE_TAP_APPROVE_MAX_TTL_MS);

    const expired = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      nowMs: now + ONE_TAP_APPROVE_MAX_TTL_MS, // exactly at expiry → expired
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(expired).toEqual({ ok: false, reason: 'expired' });
  });

  it('is single-use — second verification fails with already_used', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'p',
      tenantId: 't',
      secret: SECRET,
    });
    const consumeNonce = createInMemoryNonceStore();
    const first = await verifyOneTapApproveToken({ token, secret: SECRET, consumeNonce });
    expect(first.ok).toBe(true);
    const second = await verifyOneTapApproveToken({ token, secret: SECRET, consumeNonce });
    expect(second).toEqual({ ok: false, reason: 'already_used' });
  });

  it('rejects malformed tokens', async () => {
    const result = await verifyOneTapApproveToken({
      token: 'not-a-token',
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('P12-004 — routeUnsupervisedProposal', () => {
  const base = {
    tenantId: 'tenant-1',
    proposalId: 'prop-1',
    channel: 'voice_inbound' as const,
    ownerPhone: '+15555550100',
  };

  function deps() {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];
    let escalations = 0;
    return {
      audit,
      sms,
      getEscalations: () => escalations,
      routeDeps: {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to: string, body: string) => {
          sms.push({ to, body });
        },
        escalateToOnCall: async () => {
          escalations += 1;
        },
        buildApproveUrl: (token: string) => `https://app.test/p/approve?token=${token}`,
      },
    };
  }

  it('queue_and_sms (default) sends a one-tap SMS and emits the audit event', async () => {
    const d = deps();
    const result = await routeUnsupervisedProposal(d.routeDeps, { ...base });
    expect(result.effectiveRouting).toBe('queue_and_sms');
    expect(result.smsSent).toBe(true);
    expect(d.sms).toHaveLength(1);
    expect(d.sms[0].to).toBe('+15555550100');
    expect(d.sms[0].body).toContain('https://app.test/p/approve?token=');

    const events = await d.audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('unsupervised_proposal_routed');
    expect(events[0].metadata).toMatchObject({
      requestedRouting: 'queue_and_sms',
      effectiveRouting: 'queue_and_sms',
      smsSent: true,
    });
  });

  it('queue_only sends no SMS but still audits', async () => {
    const d = deps();
    const result = await routeUnsupervisedProposal(d.routeDeps, {
      ...base,
      routing: 'queue_only',
    });
    expect(result.smsSent).toBe(false);
    expect(d.sms).toHaveLength(0);
    const events = await d.audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ effectiveRouting: 'queue_only' });
  });

  it('escalate_to_oncall on a voice call invokes the escalation seam', async () => {
    const d = deps();
    const result = await routeUnsupervisedProposal(d.routeDeps, {
      ...base,
      routing: 'escalate_to_oncall',
    });
    expect(result.escalated).toBe(true);
    expect(d.getEscalations()).toBe(1);
    expect(d.sms).toHaveLength(0);
  });

  it('escalate_to_oncall on a non-call channel falls back to queue_only', async () => {
    const d = deps();
    const result = await routeUnsupervisedProposal(d.routeDeps, {
      ...base,
      channel: 'inapp',
      routing: 'escalate_to_oncall',
    });
    expect(result.effectiveRouting).toBe('queue_only');
    expect(result.escalated).toBe(false);
    expect(d.getEscalations()).toBe(0);
    const events = await d.audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events[0].metadata).toMatchObject({
      requestedRouting: 'escalate_to_oncall',
      effectiveRouting: 'queue_only',
    });
  });

  it('queue_and_sms with no owner phone degrades gracefully (no SMS, still audited)', async () => {
    const d = deps();
    const result = await routeUnsupervisedProposal(d.routeDeps, {
      ...base,
      ownerPhone: null,
    });
    expect(result.smsSent).toBe(false);
    expect(d.sms).toHaveLength(0);
    const events = await d.audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events).toHaveLength(1);
  });
});

describe('P2-034 — routeUnsupervisedProposal SMS transport seams', () => {
  const base = {
    tenantId: 'tenant-1',
    proposalId: 'prop-1',
    channel: 'other' as const,
    ownerPhone: '+15555550100',
  };

  it('renderSmsBody builds the body around the one-tap URL and onSmsSent records it', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];
    const recorded: { body: string; expiresAt: Date }[] = [];

    const result = await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to, body) => {
          sms.push({ to, body });
        },
        buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
        onSmsSent: async (sent) => {
          recorded.push(sent);
        },
      },
      {
        ...base,
        renderSmsBody: (url) => `Custom body. Reply Y/N/EDIT. ${url}`,
      },
    );

    expect(result.smsSent).toBe(true);
    expect(sms[0].body).toMatch(/^Custom body\. Reply Y\/N\/EDIT\. https:\/\/app\.test/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].body).toBe(sms[0].body);
    expect(recorded[0].expiresAt).toEqual(result.approveLinkExpiresAt);
  });

  it('keeps the legacy link-only body when renderSmsBody is absent', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];

    await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to, body) => {
          sms.push({ to, body });
        },
        buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
      },
      { ...base, summaryText: 'New booking for Jane D.' },
    );

    expect(sms[0].body).toBe(
      `New booking for Jane D.. Tap to approve (link expires in 30 min): ${sms[0].body.split(': ')[1]}`,
    );
  });

  it('does not invoke onSmsSent when no SMS goes out', async () => {
    const audit = new InMemoryAuditRepository();
    let called = 0;

    await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        onSmsSent: async () => {
          called += 1;
        },
      },
      { ...base, ownerPhone: null },
    );

    expect(called).toBe(0);
  });
});
