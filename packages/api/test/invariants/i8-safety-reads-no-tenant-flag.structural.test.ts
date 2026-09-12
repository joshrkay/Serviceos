/**
 * §5 I8′ (STRUCTURAL) — *"…and I want no setting anywhere able to switch that
 * off, so a misconfiguration can't be fatal"* (#1021, map #995).
 *
 * **The rule in one sentence:** no module on the emergency-tier classification
 * path may read a tenant-configurable input — no settings repository, no
 * tenant config, no feature flag — and no `process.env` outside one recorded
 * logging exception.
 *
 * ## Why this needed a guard rather than a test
 *
 * I8′ rests on the ABSENCE of a parameter, and absence is the one thing a
 * behavioural test cannot demonstrate. `emergency-tier.test.ts` proves that a
 * tier-1 phrase yields E1 *with no rules loaded* — 57 passing cases — but
 * every one of them exercises the code as it is. Add
 * `if (settings.emergencyDetection === false) return 'E3'` tomorrow and all 57
 * still pass, because none of them configures a tenant. G1 confirmed the
 * absence holds today and that nothing pins it. This pins it.
 *
 * ## Scope: the closure, not the file
 *
 * A flag does not have to be read in `emergency-tier.ts` to suppress
 * `emergency-tier.ts` — it only has to be read by something it calls. So the
 * guard walks the TRANSITIVE import closure of the two entry modules and
 * checks every file in it, and separately pins the closure's membership: a new
 * import into the safety path is precisely how a flag would arrive, so the
 * import itself has to be reviewed.
 *
 * ## The `process.env` line
 *
 * One `process.env` read survives, and it is named rather than pattern-matched
 * away: `classify-urgency-tier.ts:62` passes `NODE_ENV` to `createLogger` as
 * the logger's environment label. It configures log output, cannot reach the
 * tier decision, and is not tenant-settable. Every other `process.env` read on
 * this path fails the build — I8′'s story says "no setting ANYWHERE", and a
 * deploy-time env switch is still a setting.
 *
 * ## Two axes, after review (PR #1063)
 *
 * A fixed CONFIG vocabulary (`settingsRepo`, `tenantSettings`, …) is renameable:
 * `options.disableEmergency` matches none of it. So the guard also keys on the
 * ACTION a kill switch must perform — disable, suppress, bypass, skip, opt out,
 * override — which is not renameable; and it pins the exported SIGNATURES of
 * the path's entry points, because a tier function cannot consult a setting it
 * was never handed. Between them, the object name no longer matters.
 *
 * Evidence class: STRUCTURAL (negative controls plant a tenant-flag read, an
 * env switch, a generically-named suppression switch, and a new closure
 * member).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stripComments, plantTree, removeTree, toPosix } from '../support/structural-scan';

const API_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(API_ROOT, 'src');

/** The two entry points of the emergency-tier path (D-027, ANS-001). */
const SAFETY_ENTRY_MODULES = [
  'src/ai/agents/customer-calling/emergency-tier.ts',
  'src/ai/agents/customer-calling/emergency-detector.ts',
] as const;

// ─── Import closure ─────────────────────────────────────────────────────────

function resolveRelativeImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // package imports are not walked
  const base = path.normalize(path.join(path.dirname(fromFile), spec));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every first-party module reachable from `entries` by relative import,
 * comment-stripped so a module named only in prose is not walked into.
 *
 * Pure in `entries` and in the filesystem root, which is what lets the
 * negative control below point it at a planted tree.
 */
export function importClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) continue;
    seen.add(file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(file, m[1]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
    // `import '…'` side-effect form and `require('…')`.
    for (const m of code.matchAll(/(?:^|[^\w.])(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(file, m[1]);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return [...seen].map((f) => toPosix(path.relative(API_ROOT, f))).sort();
}

// ─── Forbidden reads ────────────────────────────────────────────────────────

/**
 * Each rule names the class of switch it forbids. A rule, not a keyword list:
 * the reason is what a reviewer reads when the build goes red.
 */
const FORBIDDEN_READS: ReadonlyArray<{ rule: string; why: string; pattern: RegExp }> = [
  {
    rule: 'tenant-settings-read',
    why: 'A per-tenant settings row could disable detection for one tenant — the misconfiguration I8′ names as "fatal".',
    pattern:
      /\b(settingsRepo|SettingsRepository|tenantSettings|escalationSettings|voiceSettings|tenantConfig|getSetting|findByTenant)\b/,
  },
  {
    rule: 'feature-flag-read',
    why: 'A flag service is a setting with a nicer name; a kill switch on safety detection is the same fatal misconfiguration.',
    pattern: /\b(featureFlag|isFeatureEnabled|flagsRepo|FlagRepository|isEnabled)\s*\(|\bflags\./,
  },
  {
    rule: 'environment-switch',
    why: 'I8′ says no setting ANYWHERE. A deploy-time env switch on the safety path is still a setting, and one nobody sees in review.',
    pattern: /\bprocess\.env\b/,
  },
  {
    rule: 'suppression-verb',
    why: "Keyed on the ACTION, not the object. Reviewed on PR #1063: the three rules above recognise a fixed CONFIG vocabulary, so `options.disableEmergency` or a destructured alias slips past every one of them. What cannot be renamed away is what a kill switch has to DO — disable, suppress, bypass, skip, turn off, opt out, override — so that is what this matches, on any receiver.",
    pattern:
      /\.(disable[A-Z_]?\w*|suppress\w*|bypass\w*|skip\w*|optOut\w*|override\w*|\w*Disabled|\w*Suppressed|\w*Bypassed)\b|\b(disable|suppress|bypass|skipSafety|turnOff)[A-Z]\w*\s*[:=]/,
  },
];

/**
 * The exported entry points of the safety path, with the parameter list each
 * one is allowed to take.
 *
 * The second half of the PR #1063 answer. A text scan cannot trace a
 * configuration value through a destructured alias — but a tier function
 * cannot consult a tenant setting it was never handed, so pinning the
 * SIGNATURES closes the same hole from the other end: a new `options` or
 * `settings` parameter on any of these fails here, whatever it is called
 * inside. `rules?: TriageRules` is the one config-shaped parameter, and it is
 * the OPTIONAL corpus enrichment the module's own header describes — it can
 * only add signals, never remove one, because the final tier is the MAX.
 */
const PINNED_ENTRY_SIGNATURES: ReadonlyArray<{ file: string; signature: RegExp; why: string }> = [
  {
    file: 'src/ai/agents/customer-calling/emergency-tier.ts',
    signature:
      /export function classifyCallerSafety\(\s*utterance: string,\s*ctx: UrgencyContext,\s*rules\?: TriageRules,\s*\)/,
    why: 'The tier entry point. Takes the utterance, the call context, and the OPTIONAL corpus rules — no tenant handle of any kind.',
  },
  {
    file: 'src/ai/agents/customer-calling/emergency-tier.ts',
    signature: /export function detectLifeSafetyE1\(\s*transcript: string,\s*\)/,
    why: 'The E1 detector takes a transcript and nothing else.',
  },
  {
    file: 'src/ai/agents/customer-calling/emergency-tier.ts',
    signature: /export function detectEmbeddedE2\(\s*transcript: string,\s*\)/,
    why: 'The E2 detector takes a transcript and nothing else.',
  },
  {
    file: 'src/ai/agents/customer-calling/emergency-detector.ts',
    signature: /export function detectEmergency\(transcript: string\): EmergencyMatch/,
    why: 'The keyword backstop takes a transcript and nothing else.',
  },
  {
    file: 'src/ai/skills/classify-urgency-tier.ts',
    signature:
      /export function classifyUrgencyTier\(\s*input: UrgencyClassificationInput,\s*rules: TriageRules,\s*\)/,
    why: 'The richer engine takes its input and the corpus rules — no tenant handle.',
  },
];

/**
 * The single recorded exception, with its reason. `process.env.NODE_ENV` is
 * passed to `createLogger` as the log-output environment label — it cannot
 * reach a tier decision and is not tenant-settable.
 */
const RECORDED_EXCEPTIONS: ReadonlyArray<{ at: string; why: string }> = [
  {
    at: 'src/ai/skills/classify-urgency-tier.ts:62',
    why: "createLogger({ service, environment: process.env.NODE_ENV || 'development' }) — logger construction at module load, not a tier input.",
  },
];

export interface ConfigRead {
  readonly at: string;
  readonly rule: string;
  readonly snippet: string;
}

/** Every forbidden configuration read in `files` (paths relative to API_ROOT). */
export function configReadsIn(files: readonly string[], root = API_ROOT): ConfigRead[] {
  const found: ConfigRead[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const code = stripComments(text).split('\n');
    const raw = text.split('\n');
    for (let i = 0; i < code.length; i += 1) {
      for (const rule of FORBIDDEN_READS) {
        if (!new RegExp(rule.pattern.source, rule.pattern.flags.replace(/g/g, '')).test(code[i])) {
          continue;
        }
        found.push({
          at: `${toPosix(rel)}:${i + 1}`,
          rule: rule.rule,
          snippet: (raw[i] ?? '').trim(),
        });
      }
    }
  }
  return found;
}

// ─── The guard ──────────────────────────────────────────────────────────────

describe('§5 I8′ (STRUCTURAL) — no tenant setting, flag or env switch can suppress safety', () => {
  const entries = SAFETY_ENTRY_MODULES.map((f) => path.join(API_ROOT, f));

  it('the closure is not vacuous and contains the real tier engine', () => {
    const closure = importClosure(entries);
    expect(closure).toContain('src/ai/agents/customer-calling/emergency-tier.ts');
    expect(closure).toContain('src/ai/agents/customer-calling/emergency-detector.ts');
    expect(closure).toContain('src/ai/skills/classify-urgency-tier.ts');
    expect(closure.length).toBeGreaterThan(3);
  });

  it('the emergency-tier import closure is pinned (a new import into the safety path is reviewed)', () => {
    // A flag does not need to be read in emergency-tier.ts to suppress it —
    // only by something it calls. Pinning membership makes the import itself
    // the review trigger.
    expect(importClosure(entries)).toEqual([
      'src/ai/agents/customer-calling/emergency-detector.ts',
      'src/ai/agents/customer-calling/emergency-tier.ts',
      'src/ai/skills/classify-urgency-tier.ts',
      'src/ai/skills/condition-grammar.ts',
      'src/ai/skills/triage-rules.schema.ts',
      'src/logging/logger.ts',
      'src/logging/redact.ts',
    ]);
  });

  it('no module on the emergency-tier path reads a tenant setting, a flag, or an unrecorded env switch', () => {
    const reads = configReadsIn(importClosure(entries));
    const unrecorded = reads.filter((r) => !RECORDED_EXCEPTIONS.some((e) => e.at === r.at));
    expect(
      unrecorded.map((r) => `${r.at}  [${r.rule}]  ${r.snippet}`),
      [
        'A configuration read appeared on the emergency-tier path.',
        '',
        'I8′: safety escalation beats containment (D-027) and NO setting anywhere',
        'may switch it off. A tier decision that consults a tenant row, a flag or',
        'an env var is one misconfiguration away from a missed life-safety call.',
        '',
        'If the read genuinely cannot reach a tier decision, add it to',
        'RECORDED_EXCEPTIONS with the reason — visibly, in review.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the one recorded exception is still exactly what the report says it is', () => {
    for (const exception of RECORDED_EXCEPTIONS) {
      const [rel, line] = exception.at.split(':');
      const text = fs.readFileSync(path.join(API_ROOT, rel), 'utf8').split('\n')[Number(line) - 1];
      expect(text, exception.at).toContain('process.env.NODE_ENV');
      expect(text, exception.at).not.toMatch(/tier|emergency|E1|suppress/i);
    }
    expect(RECORDED_EXCEPTIONS).toHaveLength(1);
  });

  it('the safety entry points still take no tenant handle (a new config parameter fails here)', () => {
    for (const pinned of PINNED_ENTRY_SIGNATURES) {
      const text = fs.readFileSync(path.join(API_ROOT, pinned.file), 'utf8');
      const normalized = stripComments(text).replace(/\s+/g, ' ');
      expect(
        pinned.signature.test(normalized),
        `${pinned.file}: ${pinned.why}\n\nA safety entry point's signature changed. If a ` +
          'parameter was added, say what it is and why it cannot suppress a tier — I8′ is the ' +
          'invariant that no setting anywhere can switch safety off.',
      ).toBe(true);
    }
  });

  // ─── Negative controls ────────────────────────────────────────────────────

  it('NEGATIVE CONTROL — a suppression switch read through a GENERIC name is reported', () => {
    // The false negative reviewed on PR #1063: `options`, `preferences` and
    // destructured aliases match none of the config-vocabulary rules.
    const dir = plantTree('i8-generic-name', {
      'planted-options.ts': [
        "export function classify(utterance: string, options: { disableEmergency?: boolean }) {",
        "  if (options.disableEmergency) return 'E3';",
        "  return 'E1';",
        '}',
        '',
      ].join('\n'),
      'planted-destructured.ts': [
        'export function classify(prefs: Record<string, boolean>) {',
        '  const { emergencyDetectionDisabled } = prefs;',
        "  return emergencyDetectionDisabled ? 'E3' : 'E1';",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const reads = configReadsIn(['planted-options.ts', 'planted-destructured.ts'], dir);
      expect(reads.map((r) => r.rule)).toContain('suppression-verb');
      expect(reads.some((r) => r.at.startsWith('planted-options.ts'))).toBe(true);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a planted tenant-settings read on the path is reported', () => {
    const dir = plantTree('i8-tenant-flag', {
      'planted-tier.ts': [
        'export async function classify(tenantId: string, settingsRepo: any) {',
        '  const settings = await settingsRepo.findByTenant(tenantId);',
        "  if (settings?.escalationSettings?.emergencyDetection === false) return 'E3';",
        "  return 'E1';",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const reads = configReadsIn(['planted-tier.ts'], dir);
      expect(reads.map((r) => r.rule)).toContain('tenant-settings-read');
      expect(reads.length).toBeGreaterThan(0);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a planted env switch on the path is reported', () => {
    const dir = plantTree('i8-env-switch', {
      'planted-env.ts': [
        "export const DETECTION_ON = process.env.EMERGENCY_DETECTION !== 'off';",
        '',
      ].join('\n'),
    });
    try {
      const reads = configReadsIn(['planted-env.ts'], dir);
      expect(reads.map((r) => r.rule)).toEqual(['environment-switch']);
      expect(reads[0].snippet).toContain('EMERGENCY_DETECTION');
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a planted feature-flag read on the path is reported', () => {
    const dir = plantTree('i8-flag', {
      'planted-flag.ts': [
        "import { flags } from './flags';",
        'export function on(tenantId: string) {',
        "  return flags.isEnabled('safety.emergency_tier', tenantId);",
        '}',
        '',
      ].join('\n'),
    });
    try {
      const reads = configReadsIn(['planted-flag.ts'], dir);
      expect(reads.map((r) => r.rule)).toContain('feature-flag-read');
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL — a new import into the safety path changes the pinned closure', () => {
    const dir = plantTree('i8-closure', {
      'entry.ts': ["import { on } from './settings-gate';", 'export const x = on;', ''].join('\n'),
      'settings-gate.ts': ['export const on = true;', ''].join('\n'),
    });
    try {
      const closure = importClosure([path.join(dir, 'entry.ts')]);
      // The new module is pulled in by the import alone — which is how a flag
      // would arrive without touching emergency-tier.ts at all.
      expect(closure.some((f) => f.endsWith('settings-gate.ts'))).toBe(true);
      expect(closure).toHaveLength(2);
    } finally {
      removeTree(dir);
    }
  });

  it('NEGATIVE CONTROL (inverse) — a config read named only in a comment is NOT reported', () => {
    const dir = plantTree('i8-comment-only', {
      'commented.ts': [
        '/**',
        ' * Deliberately reads no settingsRepo and no process.env: I8′ requires that',
        ' * no tenant flag can suppress the tier.',
        ' */',
        "export const TIER = 'E1';",
        '',
      ].join('\n'),
    });
    try {
      expect(configReadsIn(['commented.ts'], dir)).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  it('every forbidden-read rule carries its reason', () => {
    expect(FORBIDDEN_READS).toHaveLength(4);
    for (const rule of FORBIDDEN_READS) {
      expect(rule.why.length, rule.rule).toBeGreaterThan(50);
    }
    for (const pinned of PINNED_ENTRY_SIGNATURES) {
      expect(pinned.why.length, pinned.file).toBeGreaterThan(30);
    }
  });
});
