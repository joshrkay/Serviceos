/**
 * VQ-014 — Bucket 05 compliance-edges corpus tests.
 *
 * Asserts that each of the four bucket-5 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for scripts where the agent should not
 *      propose anything; populated when a constrained proposal — e.g.
 *      a callback — is mandated by the floor),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges will be recorded later via
 *      `npm run voice-quality:record` once API access is available).
 *
 * Compliance fixture-shape decisions (Layer-1 corpus convention).
 * The floor grader (`graders/floor.ts` — `complianceGatesRespected`)
 * reads three flags off `script.fixtures.tenant` defensively and
 * pass-throughs anything it does not recognise:
 *
 *   - `tenant.businessHours.afterHours: true`
 *       fires the "booker proposal must be a callback" sub-check.
 *       We carry the production `BusinessHoursConfig` shape alongside
 *       (`timezone`, `schedule[]`) plus a `currentTime` / `callMomentLocal`
 *       hint so a future runner can simulate the after-hours moment.
 *   - `tenant.dnc.blocked: true`
 *       fires the "DNC caller must terminate" sub-check.
 *       We carry the actual blocked `list: ['+15555550502']` for runner
 *       use; the grader only consults the `blocked` flag in v1.
 *   - `tenant.smsConsent.revoked: true`
 *       fires the "no outbound SMS in any proposal" sub-check.
 *       We additionally set `customers[].smsConsent: false` (the
 *       customer-record convention used elsewhere) so per-customer
 *       gating in P-series compliance code can read it directly.
 *
 * `serviceArea.zipCodes` is NOT consulted by the v1 floor grader — it
 * is documentary for the `out-of-coverage-area` script and exists so a
 * follow-up grader (or the LLM judge in criterion 12) can refuse a
 * proposal when the caller-stated ZIP falls outside the configured
 * coverage list.
 *
 * Floor scope: `[1, 2, 3, 4, 5, 7]` — emphasis on 7 (compliance).
 *   - 6 (no duplicates) and 8 (hangup) are out of scope for this bucket.
 * Disposition scope: `[9, 11, 12]` — slot extraction (10) is out of
 *   scope; these calls do not commit slots to a proposal.
 * `layer2Eligible: false` — compliance edges do not fan out to the
 *   variant-mutator in Layer 2; they are pinned-script-only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { loadScript } from '../../../src/ai/voice-quality/corpus/loader';
import { loadGoldenForScript } from '../../../src/ai/voice-quality/graders/disposition-structured';

const CORPUS_ROOT = path.resolve(
  __dirname,
  '../../../src/ai/voice-quality/corpus',
);

const SCRIPT_IDS = [
  'after-hours-callback',
  'dnc-caller-terminated',
  'stop-sent-no-sms',
  'out-of-coverage-area',
] as const;

describe('VQ-014 — Bucket 05 compliance edges', () => {
  it.each(SCRIPT_IDS)(
    'VQ-014 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '05-compliance-edges',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('05-compliance-edges');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-014 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-014 — cassette file for %s is valid JSON (entries filled after seed/record)',
    (scriptId) => {
      const cassettePath = path.join(
        CORPUS_ROOT,
        'cassettes',
        `${scriptId}.json`,
      );
      const raw = readFileSync(cassettePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.scriptId).toBe(scriptId);
      expect(parsed.version).toBe(1);
      expect(parsed.rubricVersion).toBe('v1');
      expect(Array.isArray(parsed.entries)).toBe(true);
    },
  );
});
