/**
 * P0-023 — app-wiring static-source assertion.
 *
 * Loads packages/api/src/app.ts as text and asserts that each of the six
 * Wave 1A entities is wired through the standard `pool ? Pg : InMemory`
 * ternary. We deliberately do not boot the app — booting requires Pg in
 * staging/prod (and a stubbed pool in dev). A source-level check is
 * cheaper, faster, and immune to future side effects in createApp().
 *
 * If a regression renames either the Pg or InMemory class, or accidentally
 * drops the ternary (e.g. by re-introducing a bare `new InMemoryX()`), this
 * test fails with the offending entity name.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('P0-023 — app-wiring (pool ternary coverage)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

  // RETIRED (D-024 Stage 1) — the seven `pool ? Pg : InMemory` coverage cases
  // that used to live here asserted on app.ts AS TEXT, because the ternaries
  // were inline in a 6,715-line function with no interface to test through.
  // Repository construction now lives behind buildRepositories(), so those
  // cases moved to test/app/build-repositories.test.ts where they assert the
  // RESOLVED implementation instead of the source characters. The remaining
  // assertions in this file still read source text; they cover wiring order
  // and lifecycle, which has no interface yet.

  it('tech-status (OUT|SICK|UNAVAILABLE) keyword handler is registered', () => {
    // U1 (P6-028) — guards against re-regression to "built but never wired":
    // app.ts MUST call registerTechStatusKeywords or a verified tech's OUT SMS
    // is silently dropped by the inbound dispatcher.
    expect(src).toMatch(/registerTechStatusKeywords\(/);
  });

  it('held-slot reaper is scheduled under its own leader lock', () => {
    // U6 — the reaper must own a distinct SWEEP_LOCK key and run via runAsLeader
    // so concurrent instances don't double-cancel holds.
    expect(src).toMatch(/holdReaper:\s*590015/);
    expect(src).toMatch(/runAsLeader\(SWEEP_LOCK\.holdReaper/);
    expect(src).toContain('runHoldReaperSweep');
  });

  it('supervisor agent is wired DEFAULT-ON with platform caps (U3)', () => {
    // U3 — the gate must resolve supervisor_agent default-TRUE (opt-out kill
    // switch), and the service must carry platform-default budget caps.
    expect(src).toMatch(
      /isEnabledForTenantWithDefault\(\s*tenantId,\s*'supervisor_agent',\s*true\s*\)/,
    );
    expect(src).toMatch(/defaultRules:\s*platformDefaultSupervisorRules/);
  });

  it('the daily payment-link reconciliation sweep runs under its own leader lock, worker roles only (S5a-6)', () => {
    expect(src).toMatch(/paymentLinkReconciliation:\s*590034/);
    const segment = src.slice(src.indexOf('// S5a-6 (U8) — daily payment-link reconciliation sweep.'));
    const block = segment.slice(0, segment.indexOf('// Billing resilience (Part B)'));
    expect(block).toContain('if (shouldRunWorkers) {');
    expect(block).toContain('isPaymentLinkReconciliationHour(new Date())');
    expect(block).toMatch(/runAsLeader\(SWEEP_LOCK\.paymentLinkReconciliation/);
    expect(block).toContain('listCollectOnSiteTenantIds(pool)');
  });

  it('the geocode sweep runs under its own leader lock, worker roles only, and only with a pool and a geocoder (dispatch FR-2)', () => {
    expect(src).toMatch(/geocodeLocations:\s*590035/);
    const segment = src.slice(src.indexOf('// Dispatch FR-2 phase 1 — geocode sweep.'));
    const block = segment.slice(0, segment.indexOf('// P8-009'));
    expect(block).toContain('if (shouldRunWorkers && pool && geocoder) {');
    expect(block).toMatch(/runAsLeader\(SWEEP_LOCK\.geocodeLocations/);
    expect(block).toContain('listPendingLocations(pool, limit)');
    expect(block).toContain('writeGeocodeOutcome(pool, loc, outcome)');
  });

  it('the shadow-comparison retention sweep runs beside the recording retention sweep, under its own leader lock, worker roles only, whatever SHADOW_LLM_ENABLED says', () => {
    // #1813 follow-up — "built but never wired" guard. Pool-gated like the
    // recording retention purge (the Pg repository is the only one), and NOT
    // gated on SHADOW_LLM_ENABLED: rows written while the flag was on must
    // still age out after it is turned off.
    expect(src).toMatch(/shadowComparisonRetention:\s*590047/);
    const segment = src.slice(src.indexOf('// RV-132 — recording retention purge. Hourly;'));
    const recording = segment.slice(0, segment.indexOf('// Shadow-comparison retention'));
    expect(recording).toMatch(/runAsLeader\(SWEEP_LOCK\.recordingRetention/);
    const rest = segment.slice(segment.indexOf('// Shadow-comparison retention'));
    const block = rest.slice(0, rest.indexOf('// Voice-parity (Feature 7)'));
    expect(block).toContain('if (pool && shouldRunWorkers) {');
    expect(block).not.toContain('SHADOW_LLM_ENABLED ===');
    expect(block).toContain('new PgShadowComparisonRetentionRepository(');
    expect(block).toMatch(/runAsLeader\(SWEEP_LOCK\.shadowComparisonRetention,/);
    expect(block).toContain('runShadowComparisonRetentionSweep({');
    expect(block).toContain('retentionDays: config.SHADOW_COMPARISON_RETENTION_DAYS');
    // The audit row is written in the purge's own transaction by the
    // repository, never as a separate best-effort write after it.
    expect(block).not.toContain('auditRepo');
    expect(block).toMatch(/registerInterval\(setInterval\(/);
  });

  it('exactly one digest path remains; SWEEP_LOCK has no duplicate keys (U5)', () => {
    // U5 — the redundant P5-020 hourly digest worker was deleted; only the
    // RV-063 daily digest sweep remains.
    expect(src).toContain('runDailyDigestSweep');
    expect(src).not.toContain('runDigestSweep(');
    expect(src).not.toMatch(/SWEEP_LOCK\.digest\b/);
    // No two SWEEP_LOCK keys may share an advisory-lock value (the 590014
    // digest/hfcrWeeklySend collision is resolved).
    const block = src.slice(src.indexOf('const SWEEP_LOCK = {'));
    const values = Array.from(block.slice(0, block.indexOf('} as const')).matchAll(/:\s*(\d{6})/g)).map(
      (m) => m[1],
    );
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
  });

  it('graceful shutdown registers SIGTERM/SIGINT pool drain', () => {
    expect(src).toMatch(/process\.once\(\s*['"]SIGTERM['"]/);
    expect(src).toMatch(/process\.once\(\s*['"]SIGINT['"]/);
    expect(src).toMatch(/pool\.end\(\)/);
  });

  it('pool initialization is gated on DATABASE_URL', () => {
    expect(src).toMatch(/process\.env\.DATABASE_URL\s*\?\s*createPool\(\)/);
  });

  // Blocker 5 — graceful shutdown stops background loops before draining the
  // pool, and tenant-wide sweeps are leader-elected via a Postgres advisory
  // lock so they don't duplicate on multi-instance deploys.
  describe('Blocker 5 — background-loop lifecycle + leader election', () => {
    it('shutdown clears all registered background intervals before pool drain', () => {
      expect(src).toMatch(/const\s+backgroundIntervals\s*:\s*NodeJS\.Timeout\[\]/);
      expect(src).toMatch(/registerInterval\(setInterval\(/);
      expect(src).toMatch(/for\s*\(const\s+handle\s+of\s+backgroundIntervals\)\s*clearInterval\(handle\)/);
      // The clearInterval loop must run inside the shutdown handler, before pool.end().
      // ARCH-02: the handler body was extracted into `runShutdown`, memoized
      // behind `shutdown` for idempotency (see AppWithLifecycle/gracefulDrain) —
      // `runShutdown` is the anchor now instead of the old inline `shutdown`.
      const shutdownIdx = src.indexOf('const runShutdown = async (signal');
      const clearIdx = src.indexOf('for (const handle of backgroundIntervals)');
      const poolEndIdx = src.indexOf('pool.end()');
      expect(shutdownIdx).toBeGreaterThan(-1);
      expect(clearIdx).toBeGreaterThan(shutdownIdx);
      expect(poolEndIdx).toBeGreaterThan(clearIdx);
    });

    it('a shuttingDown guard gates new sweep work', () => {
      expect(src).toMatch(/let\s+shuttingDown\s*=\s*false/);
      expect(src).toMatch(/shuttingDown\s*=\s*true/);
      expect(src).toMatch(/if\s*\(shuttingDown\)\s*return/);
    });

    it('unified poll loop has an in-flight guard (pollInFlight flag + try/finally)', () => {
      // Guard prevents unbounded concurrency when image workers hold large
      // in-memory buffers across slow 250ms ticks.
      expect(src).toMatch(/let\s+pollInFlight\s*=\s*false/);
      expect(src).toMatch(/if\s*\(pollInFlight\)\s*return/);
      expect(src).toMatch(/pollInFlight\s*=\s*true/);
      // The flag must be reset inside a finally block so exceptions don't
      // permanently lock out further ticks.
      const setTrueIdx = src.indexOf('pollInFlight = true;');
      const finallyIdx = src.indexOf('} finally {', setTrueIdx);
      const resetIdx = src.indexOf('pollInFlight = false;', finallyIdx);
      expect(setTrueIdx).toBeGreaterThan(-1);
      expect(finallyIdx).toBeGreaterThan(setTrueIdx);
      expect(resetIdx).toBeGreaterThan(finallyIdx);
    });

    it('tenant-wide sweeps are wrapped in runAsLeader with a pg advisory lock', () => {
      // #1125 — the lock/unlock pair moved into workers/leader-tick.ts, which
      // app.ts's runLeaderTick delegates to.
      const leaderTickSrc = readFileSync(resolve(__dirname, '../../src/workers/leader-tick.ts'), 'utf8');
      expect(src).toMatch(/runLeaderGatedTick\(directPool \?\? pool, lockKey, work/);
      expect(leaderTickSrc).toMatch(/pg_try_advisory_lock/);
      expect(leaderTickSrc).toMatch(/pg_advisory_unlock/);
      // Each of the six tenant-wide sweeps is gated by a distinct lock key.
      for (const key of [
        'recurringAgreements',
        'overdueInvoice',
        'appointmentReminder',
        'estimateReminder',
        'estimateExpiry',
        'googleReviews',
      ]) {
        expect(src).toMatch(new RegExp(`runAsLeader\\(SWEEP_LOCK\\.${key}`));
      }
    });
  });

  it('#1588 — the dormant voice features are wired DEFAULT-ON: multi-action reaches the memo worker, both flags resolve through createVoiceFlagResolver', () => {
    // #1588 — `multiActionEnabled` had zero call sites in app.ts, so a
    // two-action memo silently kept one action; `voice_extended_intents` was
    // read default-FALSE and never seeded. Both must resolve through the one
    // default-on resolver (tenant override → platform flag → ON), and the
    // memo worker must actually receive the multi-action gate.
    expect(src).toMatch(/createVoiceFlagResolver\(\s*\{\s*tenantFeatureFlags,\s*featureFlagRepo\s*\}\s*\)/);
    const workerCall = src.slice(src.indexOf('createVoiceActionRouterWorker({'));
    const workerDeps = workerCall.slice(0, workerCall.indexOf('});'));
    expect(workerDeps).toMatch(/multiActionEnabled:\s*voiceMultiActionFlagShim/);
    expect(workerDeps).toMatch(/extendedIntentsEnabled:\s*voiceExtendedIntentsFlagShim/);
    // The old default-false read is gone — nothing may resolve this flag off by default.
    expect(src).not.toMatch(/isFlagEnabledForTenant\(\s*tenantId,\s*'voice_extended_intents'\s*\)/);
  });

  it('#1534 — boot starts filler synthesis with the shared media-streams TTS, never awaited', () => {
    // No clips ship in the image; the boot fill is the only way the 250 ms
    // filler ever plays. It must use the same TTS the adapter speaks with and
    // must not block boot (fire-and-forget, never `await`ed).
    expect(src).toMatch(/fillerCache\.load\(\);\s*void startFillerSynthesis\(fillerCache, sharedTtsProvider\);/);
    expect(src).not.toMatch(/await\s+startFillerSynthesis/);
  });

  it('B4 — the SMS reply transport and the one-tap link get the approval-time reference checks', () => {
    // Both seams take the checks as an OPTIONAL dep (unit fixtures omit it),
    // so a dropped line here would silently let a texted Y or a tapped link
    // approve a card the dashboard approve route holds.
    const depsOf = (call: string) => {
      const from = src.slice(src.indexOf(call));
      return from.slice(0, from.indexOf('});'));
    };
    expect(depsOf('registerProposalReplySms(')).toMatch(/\bapprovalReferenceChecks,/);
    expect(depsOf('createOneTapApproveRouter({')).toMatch(/\bapprovalReferenceChecks,/);
  });

  it('B1 — every one-tap approve-link mint site resolves who its recipient approves as', () => {
    // routeUnsupervisedProposal mints the legacy OWNER link when this optional
    // dep is absent, so a dropped line would hand the backup supervisor's
    // mobile a link that approves as 'owner' again.
    const block = (opener: string) => {
      const from = src.slice(src.indexOf(`\n    ${opener}`));
      return from.slice(0, from.indexOf('\n    },'));
    };
    expect(src).toMatch(/const resolveLinkApprover = \(tenantId: string, phone: string\) =>\s*resolveApproverRole\(/);
    for (const opener of ['unsupervisedRouting: {', 'voiceApprovalOneTap: {', 'autonomousClose: {']) {
      expect(block(opener)).toMatch(/\bresolveLinkApprover,/);
    }
  });

  it('C-1698-P1 — the memo worker reads the creator mode through the fail-closed loader', () => {
    // The request middleware's mode loader defaults a missing user or a DB
    // error to 'supervisor' (the permissive threshold); the memo path must not.
    expect(src).toMatch(/resolveMemberMode: createMemoCreatorModeLoader\(\(\) => userModeService\),/);
    expect(src).not.toMatch(/resolveUserMode/);
  });

  it('B1 follow-up — every approval SMS recipient is resolved through the active-member check', () => {
    // The inline resolver read the backup's users row by id and texted it
    // whatever its status, so a deactivated backup still got job details.
    expect(src).toMatch(
      /const resolveUnsupervisedOwnerPhone = \(tenantId: string\): Promise<string \| null> =>\s*resolveApprovalSmsPhone\(\{ settingsRepo, userRepo \}, tenantId\);/,
    );
    expect(src).not.toMatch(/backup\?\.mobileNumber/);
    expect(src.match(/resolveOwnerPhone: resolveUnsupervisedOwnerPhone,/g)?.length ?? 0).toBeGreaterThan(0);
    // B3-2 — the three approval-link senders get the same recipient, with
    // whose phone it is (the owner phone needs no second lookup).
    expect(src).toMatch(
      /const resolveApprovalRecipient = \(tenantId: string\) =>\s*resolveApprovalSmsRecipient\(\{ settingsRepo, userRepo \}, tenantId\);/,
    );
    const block = (opener: string) => {
      const from = src.slice(src.indexOf(`\n    ${opener}`));
      return from.slice(0, from.indexOf('\n    },'));
    };
    for (const opener of ['unsupervisedRouting: {', 'voiceApprovalOneTap: {', 'autonomousClose: {']) {
      expect(block(opener)).toMatch(/\bresolveSmsRecipient: resolveApprovalRecipient,/);
    }
  });

  it('B1 — the one-tap route re-checks a backup link against the current backup supervisor', () => {
    // Optional dep: dropped, a link minted for a backup who has since been
    // replaced or deactivated would still approve for its 30 minutes.
    const from = src.slice(src.indexOf('createOneTapApproveRouter({'));
    expect(from.slice(0, from.indexOf('});'))).toMatch(
      /resolveBackupApprover: \(tenantId: string\) =>\s*resolveBackupSupervisorApprover\(\{ settingsRepo, userRepo \}, tenantId\)/,
    );
  });

  it('PRIV-3 — a failed live card-number rewrite is queued, and the retry worker that writes it is registered', () => {
    // Without the queue the rewrite lives only in the session's memory (lost
    // on a restart); without the worker the job is never consumed.
    const store = src.slice(src.indexOf('const voiceSessionStore = new VoiceSessionStore({'));
    expect(store.slice(0, store.indexOf('});'))).toContain('cardRewriteRetryQueue: queue,');
    expect(src).toMatch(/createCardNumberRewriteRetryWorker\(\{ callTranscriptTurnRepo, auditRepo \}\)/);
    expect(src).toMatch(/workerRegistry\.set\(\s*cardNumberRewriteRetryWorker\.type,/);
  });

  it('PRIV-3 — the recording hook writes the card-number rewrites still queued for the call before ingesting it', () => {
    // Without it, a restart between a failed live rewrite and the recording
    // callback (or a callback on another replica) ingests the fragments.
    const hook = src.slice(src.indexOf('onPersisted: createRecordingTranscriptHook({'));
    expect(hook.slice(0, hook.indexOf('logger: createLogger('))).toContain(
      'pendingCardNumberRewrites: pendingCardNumberRewrites(queue),',
    );
  });
});
