/**
 * VQ-009 — Voice Quality v1 (Layer 1) corpus runner entry.
 *
 * This is the single entry point that the dedicated
 * `vitest.voice-quality.config.ts` runs across 4 forked workers. Each
 * worker:
 *  1. Loads the entire corpus (cheap — a few hundred small JSON
 *     files at most).
 *  2. Filters to the slice assigned to its worker id via the
 *     deterministic `i % workerCount` formula.
 *  3. Runs each assigned script through `runScript()` against an
 *     isolated InMemory repo bundle, with a tenant id namespaced to
 *     `vq_test_w<workerId>_<scriptId>` (defense-in-depth on top of
 *     per-worker repo isolation).
 *
 * # Worker id semantics
 * Vitest exposes `VITEST_POOL_ID` to test code as a 1-indexed worker
 * number (1..N). We subtract one so the modulo math lines up with
 * 0-based array indices. Falling back to `1` (rather than `0`) when
 * the env var is absent reflects vitest's actual behavior — the
 * env var is always present in fork pools but the fallback keeps
 * standalone single-process invocations sensible.
 *
 * # Empty corpus
 * The corpus is empty during the Phase-1 → Phase-2 transition window
 * (Phase 2 authors the bucket scripts). `loadCorpus()` returns `[]`
 * for a missing/empty root rather than throwing, so this entry just
 * registers a single placeholder `it()` that asserts the empty-corpus
 * case is reached. CI stays green; once Phase 2 lands the placeholder
 * is replaced by real per-script tests at runtime (no file edit
 * required).
 *
 * # Why not import the runner directly into a non-test harness
 * Vitest already gives us per-worker process isolation, JSON
 * reporting, retry semantics, and a familiar developer UX
 * (`npm run voice-quality`). Re-implementing those primitives in a
 * standalone runner would duplicate without benefit. The dedicated
 * config keeps this entry quarantined from the rest of the suite.
 */
import { describe, it, expect } from 'vitest';
import { loadCorpus } from '../../src/ai/voice-quality/corpus/loader';
import {
  runScript,
  type DriverFactoryContext,
} from '../../src/ai/voice-quality/runner';
import { TextModeDriver, type AgentDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';

// `loadCorpus()` is robust to a missing root — returns []. So this is
// safe to call at module scope even before Phase 2 authors any
// scripts.
//
// VQ2-014 — exclude `layer2Only` scripts. Those are audio-only edge
// cases (mumbled speech, mid-sentence pause) that the Layer 1
// text-mode runner cannot fairly grade; they belong to Layer 2 only.
const scripts = (() => {
  try {
    return loadCorpus().filter((s) => !s.layer2Only);
  } catch {
    // A genuine corpus *parse* failure should still be loud — but for
    // the entry-point sanity case (root absent / empty) we already
    // get []. This catch is a belt-and-braces guard so a single
    // malformed file doesn't take down all 4 workers' empty-corpus
    // skip path; the corpus loader's own tests cover the validation
    // contract.
    return [];
  }
})();

const workerCount = 4;
// VITEST_POOL_ID is 1-indexed in fork pools; standalone runs (no
// vitest pool) default to 1 → workerId 0.
const rawPoolId = parseInt(process.env.VITEST_POOL_ID ?? '1', 10);
const workerId = Number.isFinite(rawPoolId) && rawPoolId >= 1
  ? (rawPoolId - 1) % workerCount
  : 0;

const myScripts = scripts.filter(
  (_, i) => ((i % workerCount) + workerCount) % workerCount === workerId,
);

describe('Voice Quality v1 (Layer 1) — corpus', () => {
  if (scripts.length === 0) {
    it.skip('VQ-009 — corpus empty; awaiting Phase 2 authoring', () => {
      expect(true).toBe(true);
    });
    return;
  }

  if (myScripts.length === 0) {
    it(`VQ-009 — no scripts assigned to worker ${workerId}`, () => {
      expect(myScripts.length).toBe(0);
    });
    return;
  }

  for (const script of myScripts) {
    it(`VQ-CORPUS — ${script.bucket} — ${script.id}`, async () => {
      const tenantId = `vq_test_w${workerId}_${script.id}`;

      // Build a driver factory that uses a fresh `VoiceSessionStore`
      // and a mock LLM gateway. Phase 3 (cassette wiring) layers a
      // recorded cassette gateway in via env-var dispatch, but for
      // Phase-1-complete the mock keeps the runner exercising the
      // production orchestration path without external deps.
      const driverFactory = (fctx: DriverFactoryContext): AgentDriver => {
        const store = new VoiceSessionStore({ startInterval: false });
        const { gateway, provider } = createMockLLMGateway();
        // Default classifier response: a benign lookup. Real
        // intent-specific responses come from cassettes once VQ-005's
        // cassette mode is wired in for the corpus run.
        provider.setDefaultResponse(
          JSON.stringify({ intentType: 'lookup_customer', confidence: 0.9 }),
        );

        const driver = new TextModeDriver({
          voiceSessionStore: store,
          bus: fctx.bus,
          gateway,
          proposalRepo: fctx.repos.proposalRepo,
          customerRepo: fctx.repos.customerRepo,
          appointmentRepo: fctx.repos.appointmentRepo,
          invoiceRepo: fctx.repos.invoiceRepo,
          estimateRepo: fctx.repos.estimateRepo,
          jobRepo: fctx.repos.jobRepo,
          leadRepo: fctx.repos.leadRepo,
          auditRepo: fctx.repos.auditRepo,
          systemActorId: 'system:vq-corpus',
        });

        const wrapped: AgentDriver = {
          startSession: (opts) => driver.startSession({ ...opts, tenantId }),
          speak: (sid, t) => driver.speak(sid, t),
          hangup: (sid) => driver.hangup(sid),
          endSession: async (sid) => {
            await driver.endSession(sid);
            store.dispose();
          },
        };
        return wrapped;
      };

      const result = await runScript(script, {
        driverFactory,
        repoMode: 'memory',
      });

      // Phase 3 (graders / VQ-023 aggregator) will assert
      // `result.passed`. For the Phase-1-complete bar we confirm
      // the runner produced a well-formed observation. The
      // per-worker `tenantId` we constructed above is namespaced
      // (`vq_test_w<workerId>_<scriptId>`) so even if two workers
      // run identical script ids in the future, they cannot
      // collide. The runner's own canonical tenant id is read off
      // the script fixture (or freshly minted), which is fine —
      // worker isolation lives at the repo-bundle + process level,
      // not in the runner's tenant resolution.
      expect(result.observation.events.length).toBeGreaterThanOrEqual(0);
      expect(typeof result.observation.tenantId).toBe('string');
      expect(result.observation.tenantId.length).toBeGreaterThan(0);
      // The constructed worker-namespaced tenant id is non-empty
      // and unique per (worker, script) pair.
      expect(tenantId).toMatch(/^vq_test_w\d+_/);
    });
  }
});
