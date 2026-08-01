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
    expect(result).toEqual({ ok: true, action: 'approve', proposalId: 'prop-1', tenantId: 'tenant-1' });
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

describe('Track-E — one-tap confirm flag (defense-in-depth for non-capture)', () => {
  it('mints a confirm-flagged approve token that verifies with confirm: true', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'p-money',
      tenantId: 'tenant-1',
      secret: SECRET,
      confirm: true,
    });
    const result = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toMatchObject({
      ok: true,
      action: 'approve',
      proposalId: 'p-money',
      confirm: true,
    });
  });

  it('a default approve token carries no confirm flag (legacy result shape preserved)', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: 'p-cap',
      tenantId: 'tenant-1',
      secret: SECRET,
    });
    const result = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    // `confirm` is omitted entirely when unset — the legacy approve result.
    expect(result).toEqual({
      ok: true,
      action: 'approve',
      proposalId: 'p-cap',
      tenantId: 'tenant-1',
    });
  });

  it('routeUnsupervisedProposal threads confirmNonCapture into the minted token', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];
    const result = await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to: string, body: string) => {
          sms.push({ to, body });
        },
        buildApproveUrl: (token: string) => `https://app.test/p/approve?token=${token}`,
      },
      {
        tenantId: 'tenant-1',
        proposalId: 'prop-money',
        channel: 'voice_inbound',
        ownerPhone: '+15555550100',
        routing: 'queue_and_sms',
        summaryText: 'Refund $99',
        renderSmsBody: (url: string) => `Approve refund: ${url}`,
        confirmNonCapture: true,
      },
    );
    expect(result.smsSent).toBe(true);
    const match = sms[0].body.match(/token=([A-Za-z0-9._-]+)/);
    expect(match).toBeTruthy();
    const verified = await verifyOneTapApproveToken({
      token: match![1],
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(verified).toMatchObject({
      ok: true,
      action: 'approve',
      proposalId: 'prop-money',
      confirm: true,
    });
  });

  it('routeUnsupervisedProposal without confirmNonCapture mints a plain (non-confirm) token', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];
    await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to: string, body: string) => {
          sms.push({ to, body });
        },
        buildApproveUrl: (token: string) => `https://app.test/p/approve?token=${token}`,
      },
      {
        tenantId: 'tenant-1',
        proposalId: 'prop-cap',
        channel: 'voice_inbound',
        ownerPhone: '+15555550100',
        routing: 'queue_and_sms',
        summaryText: 'New booking',
        renderSmsBody: (url: string) => `Approve booking: ${url}`,
      },
    );
    const match = sms[0].body.match(/token=([A-Za-z0-9._-]+)/);
    const verified = await verifyOneTapApproveToken({
      token: match![1],
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(verified).toEqual({
      ok: true,
      action: 'approve',
      proposalId: 'prop-cap',
      tenantId: 'tenant-1',
    });
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

  it('queue_and_sms pushes a needs_approval notification to the registered devices', async () => {
    const d = deps();
    const pushes: Array<{ tenantId: string; proposal: { id: string; summary: string } }> = [];
    await routeUnsupervisedProposal(
      { ...d.routeDeps, notifyPush: async (args) => { pushes.push(args); } },
      { ...base, summaryText: 'New booking for Jane D.' },
    );
    expect(pushes).toEqual([
      { tenantId: 'tenant-1', proposal: { id: 'prop-1', summary: 'New booking for Jane D.' } },
    ]);
  });

  it('queue_and_sms with no phone still pushes (push is independent of the SMS seam)', async () => {
    const d = deps();
    const pushes: unknown[] = [];
    await routeUnsupervisedProposal(
      { ...d.routeDeps, notifyPush: async (args) => { pushes.push(args); } },
      { ...base, ownerPhone: null },
    );
    expect(pushes).toHaveLength(1);
  });

  it('queue_only does not push (respects the no-active-notify preference)', async () => {
    const d = deps();
    const pushes: unknown[] = [];
    await routeUnsupervisedProposal(
      { ...d.routeDeps, notifyPush: async (args) => { pushes.push(args); } },
      { ...base, routing: 'queue_only' },
    );
    expect(pushes).toHaveLength(0);
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
    const recorded: {
      body: string;
      kind: 'proposal_rendered' | 'review_required_rendered';
      expiresAt?: Date;
    }[] = [];

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
    expect(recorded[0].kind).toBe('proposal_rendered');
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

// ───────────────────────────────────────────────────────────────────────────
// RV-007 (F-4) — Confidence Marker auto-approve guard
//
// `payload._meta.overallConfidence` of 'low' / 'very_low' must NEVER
// auto-approve, regardless of the numeric score vs threshold. 'medium'
// does NOT block (it renders as a marker downstream). Payloads without
// `_meta` keep today's numeric-threshold behavior exactly.
// ───────────────────────────────────────────────────────────────────────────

import { confidenceMetaBlocksAutoApprove } from '../../src/proposals/auto-approve';

describe('RV-007 — confidenceMetaBlocksAutoApprove', () => {
  it('blocks on low and very_low', () => {
    expect(confidenceMetaBlocksAutoApprove({ _meta: { overallConfidence: 'low' } })).toBe(true);
    expect(confidenceMetaBlocksAutoApprove({ _meta: { overallConfidence: 'very_low' } })).toBe(
      true,
    );
  });

  it('does not block on high or medium', () => {
    expect(confidenceMetaBlocksAutoApprove({ _meta: { overallConfidence: 'high' } })).toBe(false);
    expect(confidenceMetaBlocksAutoApprove({ _meta: { overallConfidence: 'medium' } })).toBe(
      false,
    );
  });

  it('never blocks (and never throws) on absent or malformed _meta', () => {
    expect(confidenceMetaBlocksAutoApprove(undefined)).toBe(false);
    expect(confidenceMetaBlocksAutoApprove(null)).toBe(false);
    expect(confidenceMetaBlocksAutoApprove('low')).toBe(false);
    expect(confidenceMetaBlocksAutoApprove({})).toBe(false);
    expect(confidenceMetaBlocksAutoApprove({ _meta: null })).toBe(false);
    expect(confidenceMetaBlocksAutoApprove({ _meta: 'low' })).toBe(false);
    expect(confidenceMetaBlocksAutoApprove({ _meta: {} })).toBe(false);
    expect(confidenceMetaBlocksAutoApprove({ _meta: { overallConfidence: 42 } })).toBe(false);
  });
});

describe('RV-007 — decideInitialStatus confidence-marker guard', () => {
  // create_customer is capture-class; autonomous tier is the only path
  // that can reach 'approved'.
  const base = {
    proposalType: 'create_customer' as const,
    sourceTrustTier: 'autonomous' as const,
  };

  it.each(['low', 'very_low'] as const)(
    '%s blocks auto-approve at ANY score, in every supervisor mode path',
    (level) => {
      const payload = { name: 'X', _meta: { overallConfidence: level } };

      // Legacy path (no mode threaded) — 0.99 clears 0.9 numerically.
      expect(decideInitialStatus({ ...base, confidenceScore: 0.99, payload })).toBe('draft');

      // Mode-aware paths — 1.0 clears every threshold numerically.
      for (const mode of ['supervisor', 'both', 'tech'] as const) {
        expect(
          decideInitialStatus({
            ...base,
            confidenceScore: 1.0,
            supervisorMode: mode,
            supervisorPresent: true,
            payload,
          }),
        ).toBe('draft');
      }

      // Tenant override path — even a permissive 0.5 override is beaten.
      expect(
        decideInitialStatus({
          ...base,
          confidenceScore: 0.99,
          supervisorMode: 'supervisor',
          supervisorPresent: true,
          tenantThresholdOverride: { supervisor: 0.5 },
          payload,
        }),
      ).toBe('draft');

      // Unsupervised path: a blocked proposal is NOT a "would have
      // auto-approved" — it lands in 'draft', not 'ready_for_review'.
      expect(
        decideInitialStatus({
          ...base,
          confidenceScore: 0.99,
          supervisorMode: 'supervisor',
          supervisorPresent: false,
          payload,
        }),
      ).toBe('draft');
    },
  );

  it('medium does NOT block (F-4: only low/very_low block)', () => {
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.96,
        supervisorMode: 'supervisor',
        supervisorPresent: true,
        payload: { name: 'X', _meta: { overallConfidence: 'medium' } },
      }),
    ).toBe('approved');
  });

  it('high does not block either', () => {
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.96,
        supervisorMode: 'tech',
        supervisorPresent: true,
        payload: { name: 'X', _meta: { overallConfidence: 'high' } },
      }),
    ).toBe('approved');
  });

  it('regression pin — absent _meta keeps today\'s behavior per supervisor mode path', () => {
    const payload = { name: 'X' }; // no _meta

    // Legacy (no mode): 0.91 approves, 0.89 drafts.
    expect(decideInitialStatus({ ...base, confidenceScore: 0.91, payload })).toBe('approved');
    expect(decideInitialStatus({ ...base, confidenceScore: 0.89, payload })).toBe('draft');

    // supervisor (0.90): boundary inclusive.
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.9,
        supervisorMode: 'supervisor',
        supervisorPresent: true,
        payload,
      }),
    ).toBe('approved');

    // both (0.92).
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.92,
        supervisorMode: 'both',
        supervisorPresent: true,
        payload,
      }),
    ).toBe('approved');
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.91,
        supervisorMode: 'both',
        supervisorPresent: true,
        payload,
      }),
    ).toBe('draft');

    // tech (0.95).
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.95,
        supervisorMode: 'tech',
        supervisorPresent: true,
        payload,
      }),
    ).toBe('approved');
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.94,
        supervisorMode: 'tech',
        supervisorPresent: true,
        payload,
      }),
    ).toBe('draft');

    // Unsupervised: still routes to ready_for_review (unchanged).
    expect(
      decideInitialStatus({
        ...base,
        confidenceScore: 0.96,
        supervisorMode: 'supervisor',
        supervisorPresent: false,
        payload,
      }),
    ).toBe('ready_for_review');

    // No payload threaded at all (legacy callers): unchanged.
    expect(decideInitialStatus({ ...base, confidenceScore: 0.91 })).toBe('approved');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RV-074 (F-4) — routing-site one-tap guard
//
// Low/very_low proposals must never get a Y-able one-tap link in the
// routeUnsupervisedProposal path.  The predicate reuse is tested here: the
// same `confidenceMetaBlocksAutoApprove` gate used by decideInitialStatus
// also governs whether the one-tap token is minted.
// ───────────────────────────────────────────────────────────────────────────

describe('RV-074 — routeUnsupervisedProposal: low/very_low confidence suppresses one-tap link', () => {
  const baseInput = {
    tenantId: 'tenant-1',
    proposalId: 'prop-1',
    channel: 'other' as const,
    ownerPhone: '+15555550100',
  };

  for (const level of ['low', 'very_low'] as const) {
    it(`${level}: sends SMS without approve URL, anchors as review_required_rendered, audits the suppression`, async () => {
      const audit = new InMemoryAuditRepository();
      const sms: { to: string; body: string }[] = [];
      const smsSentCalls: {
        body: string;
        kind: 'proposal_rendered' | 'review_required_rendered';
        expiresAt?: Date;
      }[] = [];

      const result = await routeUnsupervisedProposal(
        {
          auditRepo: audit,
          secret: SECRET,
          sendSms: async (to, body) => sms.push({ to, body }),
          buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
          onSmsSent: async (sent) => smsSentCalls.push(sent),
        },
        {
          ...baseInput,
          payload: { _meta: { overallConfidence: level } },
          renderSmsBody: (approveUrl: string) =>
            approveUrl
              ? `Review and approve. ${approveUrl}`
              : `Low-confidence proposal. Needs review in app. Reply N to reject.`,
        },
      );

      expect(result.smsSent).toBe(true);
      // Body must NOT contain an approve URL
      expect(sms[0].body).not.toContain('https://app.test/p/approve');
      // Body contains the no-approve form
      expect(sms[0].body).toContain('Needs review in app');
      // No one-tap link expiry (no token was minted)
      expect(result.approveLinkExpiresAt).toBeUndefined();
      // RV-074 review fix: the low-confidence send IS anchored — it solicits
      // "reply N to reject", so it must become the latest reply target.
      expect(smsSentCalls).toHaveLength(1);
      expect(smsSentCalls[0].kind).toBe('review_required_rendered');
      expect(smsSentCalls[0].body).toBe(sms[0].body);
      expect(smsSentCalls[0].expiresAt).toBeUndefined();
      // The suppressed approve affordance is auditable.
      const events = await audit.findByEntity('tenant-1', 'proposal', 'prop-1');
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        smsSent: true,
        approveLinkSuppressed: true,
        suppressReason: 'low_confidence',
      });
    });
  }

  it('high confidence (control): sends SMS with approve URL and calls onSmsSent', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];
    const smsSentCalls: {
      body: string;
      kind: 'proposal_rendered' | 'review_required_rendered';
      expiresAt?: Date;
    }[] = [];

    const result = await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to, body) => sms.push({ to, body }),
        buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
        onSmsSent: async (sent) => smsSentCalls.push(sent),
      },
      {
        ...baseInput,
        payload: { _meta: { overallConfidence: 'high' } },
        renderSmsBody: (approveUrl: string) => `Approve here: ${approveUrl}`,
      },
    );

    expect(result.smsSent).toBe(true);
    expect(sms[0].body).toContain('https://app.test/p/approve');
    expect(result.approveLinkExpiresAt).toBeInstanceOf(Date);
    expect(smsSentCalls).toHaveLength(1);
    expect(smsSentCalls[0].kind).toBe('proposal_rendered');
    expect(smsSentCalls[0].expiresAt).toBeInstanceOf(Date);
    // No suppression metadata on the normal path.
    const events = await audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events[0].metadata).not.toHaveProperty('approveLinkSuppressed');
  });

  it('absent _meta: preserves original behavior (one-tap link sent)', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];

    const result = await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to, body) => sms.push({ to, body }),
        buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
      },
      {
        ...baseInput,
        // No payload field threaded — legacy path
        summaryText: 'A proposal needs your approval',
      },
    );

    expect(result.smsSent).toBe(true);
    expect(sms[0].body).toContain('https://app.test/p/approve');
    expect(result.approveLinkExpiresAt).toBeInstanceOf(Date);
  });

  // Item 2 pin: when BOTH low-confidence AND suppressApproveLink fire,
  // the audit metadata records 'low_confidence+action_class'.
  it('both low_confidence AND suppressApproveLink: suppressReason is "low_confidence+action_class"', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];

    await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to, body) => sms.push({ to, body }),
        buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
      },
      {
        ...baseInput,
        // Low-confidence payload AND caller-asserted suppression.
        payload: { _meta: { overallConfidence: 'low' } },
        suppressApproveLink: true,
        renderSmsBody: (approveUrl: string) =>
          approveUrl ? `Approve: ${approveUrl}` : 'Needs review in app.',
      },
    );

    const events = await audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      approveLinkSuppressed: true,
      suppressReason: 'low_confidence+action_class',
    });
    // No one-tap link in the body.
    expect(sms[0].body).not.toContain('https://app.test/p/approve');
  });

  it('only suppressApproveLink (no low confidence): suppressReason is "action_class"', async () => {
    const audit = new InMemoryAuditRepository();
    const sms: { to: string; body: string }[] = [];

    await routeUnsupervisedProposal(
      {
        auditRepo: audit,
        secret: SECRET,
        sendSms: async (to, body) => sms.push({ to, body }),
        buildApproveUrl: (token) => `https://app.test/p/approve?token=${token}`,
      },
      {
        ...baseInput,
        // No low-confidence payload; only caller-asserted suppression.
        suppressApproveLink: true,
        renderSmsBody: (_approveUrl: string) => 'Needs review in app.',
      },
    );

    const events = await audit.findByEntity('tenant-1', 'proposal', 'prop-1');
    expect(events[0].metadata).toMatchObject({
      approveLinkSuppressed: true,
      suppressReason: 'action_class',
    });
  });
});

// Wiring proof: createProposal threads its payload into decideInitialStatus,
// so the guard holds on the real proposal-creation path (the single entry
// every AI task handler uses).
import { createProposal } from '../../src/proposals/proposal';

describe('RV-007 — createProposal wiring', () => {
  const baseInput = {
    tenantId: 't1',
    proposalType: 'create_customer' as const,
    summary: 's',
    createdBy: 'u1',
    sourceTrustTier: 'autonomous' as const,
    confidenceScore: 0.99,
    supervisorMode: 'supervisor' as const,
    supervisorPresent: true,
  };

  it('low _meta forces draft even at 0.99 confidence', () => {
    const p = createProposal({
      ...baseInput,
      payload: { name: 'X', _meta: { overallConfidence: 'low' } },
    });
    expect(p.status).toBe('draft');
    expect(p.approvedAt).toBeUndefined();
  });

  it('same proposal without _meta still auto-approves (regression pin)', () => {
    const p = createProposal({ ...baseInput, payload: { name: 'X' } });
    expect(p.status).toBe('approved');
    expect(p.approvedAt).toBeInstanceOf(Date);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RV-065 — one-tap token action variants ('approve' | 'mint_draft_invoice')
// ───────────────────────────────────────────────────────────────────────────

describe('RV-065 — one-tap token action variants', () => {
  it("round-trips a 'mint_draft_invoice' token bound to tenant + jobId", async () => {
    const { token } = createOneTapApproveToken({
      action: 'mint_draft_invoice',
      jobId: 'job-77',
      tenantId: 'tenant-1',
      secret: SECRET,
    });
    const result = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      expectedTenantId: 'tenant-1',
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({
      ok: true,
      action: 'mint_draft_invoice',
      jobId: 'job-77',
      tenantId: 'tenant-1',
    });
  });

  it('back-compat: approve token payload bytes are unchanged (pin: keys exactly p,t,n,e)', () => {
    const now = 1_000_000;
    const { token } = createOneTapApproveToken({
      proposalId: 'prop-1',
      tenantId: 'tenant-1',
      secret: SECRET,
      nowMs: now,
    });
    const rawJson = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    const parsed = JSON.parse(rawJson) as { p: string; t: string; n: string; e: number };
    // Byte-identical pin: the serialized payload is exactly the legacy
    // four-key shape in the legacy key order — no `a` discriminator, no
    // extra keys, for ANY default-action token.
    expect(rawJson).toBe(
      `{"p":"prop-1","t":"tenant-1","n":"${parsed.n}","e":${parsed.e}}`,
    );
    expect(parsed.e).toBe(now + ONE_TAP_APPROVE_MAX_TTL_MS);
  });

  it("an explicit action: 'approve' also produces the legacy byte shape", () => {
    const { token } = createOneTapApproveToken({
      action: 'approve',
      proposalId: 'prop-9',
      tenantId: 't',
      secret: SECRET,
    });
    const rawJson = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(rawJson))).toEqual(['p', 't', 'n', 'e']);
  });

  it('mint tokens expire and are single-use, same machinery as approve', async () => {
    const now = 5_000_000;
    const { token } = createOneTapApproveToken({
      action: 'mint_draft_invoice',
      jobId: 'job-1',
      tenantId: 't',
      secret: SECRET,
      nowMs: now,
    });
    const expired = await verifyOneTapApproveToken({
      token,
      secret: SECRET,
      nowMs: now + ONE_TAP_APPROVE_MAX_TTL_MS,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(expired).toEqual({ ok: false, reason: 'expired' });

    const consumeNonce = createInMemoryNonceStore();
    const first = await verifyOneTapApproveToken({ token, secret: SECRET, nowMs: now, consumeNonce });
    expect(first.ok).toBe(true);
    const replayed = await verifyOneTapApproveToken({ token, secret: SECRET, nowMs: now, consumeNonce });
    expect(replayed).toEqual({ ok: false, reason: 'already_used' });
  });

  it('mint tokens enforce the tenant binding', async () => {
    const { token } = createOneTapApproveToken({
      action: 'mint_draft_invoice',
      jobId: 'job-1',
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

  it('rejects an unknown action discriminator as malformed (signed but bogus)', async () => {
    // Forge a payload with a bad `a` and sign it with the real secret to
    // prove the structural guard (not just the signature) rejects it.
    const { createHmac } = await import('node:crypto');
    const payloadB64 = Buffer.from(
      JSON.stringify({ p: 'x', t: 't', n: 'n1', e: Date.now() + 60000, a: 'delete_everything' }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = await verifyOneTapApproveToken({
      token: `${payloadB64}.${sig}`,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses to mint without the subject id for the action', () => {
    expect(() =>
      createOneTapApproveToken({ tenantId: 't', secret: SECRET }),
    ).toThrow(/proposalId/);
    expect(() =>
      createOneTapApproveToken({
        action: 'mint_draft_invoice',
        proposalId: 'p',
        tenantId: 't',
        secret: SECRET,
      }),
    ).toThrow(/jobId/);
  });
});
