import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Static contract for the Maestro device flows (research #1002, PRD 3.3 / 5.4).
 * The flows themselves only execute on an Android emulator in CI
 * (.github/workflows/mobile-maestro.yml); this suite pins what can be checked
 * without a device: the files parse, target this app, and make the assertions
 * the PRD rows need.
 */
const MAESTRO_DIR = path.resolve(__dirname, '../../.maestro');

type Command = Record<string, unknown> | string;
interface Flow {
  file: string;
  config: Record<string, unknown>;
  commands: Command[];
}

function loadFlow(rel: string): Flow {
  const docs = parseAllDocuments(readFileSync(path.join(MAESTRO_DIR, rel), 'utf8'));
  for (const d of docs) expect(d.errors, `${rel} YAML errors`).toEqual([]);
  expect(docs, `${rel} must be <config> --- <commands>`).toHaveLength(2);
  return {
    file: rel,
    config: docs[0].toJS() as Record<string, unknown>,
    commands: docs[1].toJS() as Command[],
  };
}

function allFlowFiles(dir = MAESTRO_DIR, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? allFlowFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
      : e.name.endsWith('.yaml')
        ? [`${prefix}${e.name}`]
        : [],
  );
}

describe('Maestro device flows — static contract', () => {
  it('ships the 3.3 and 5.4 flows, each a valid flow for the Rivet Android app', () => {
    const files = allFlowFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        'prd-3.3-defaults-notice.yaml',
        'prd-5.4-offline-capture.yaml',
        'prd-5.4-crash-relaunch.yaml',
        'prd-5.4-reconnect.yaml',
      ]),
    );
    for (const f of files) {
      const flow = loadFlow(f);
      expect(flow.config.appId, f).toBe('com.serviceos.app');
      expect(Array.isArray(flow.commands) && flow.commands.length > 0, f).toBe(true);
    }
  });

  it('signed-in subflow waits out the setup gate: skip onboarding, then land on the tab bar', () => {
    // Run 36767934585: the old subflow accepted "(Skip for now|Today|Home)" —
    // the tab bar is visible for a moment BEFORE /api/onboarding/status
    // resolves (the gate fails open while loading), so the conditional skip
    // saw no "Skip for now", then the gate redirected to onboarding and 5.4 A
    // could not find the "Assistant" tab. A fresh dev-auth tenant never has
    // setup complete, so onboarding is certain — wait for it, skip, then wait
    // for the tab bar.
    const { commands } = loadFlow('subflows/signed-in.yaml');
    const waits = commands
      .map((c, i) => ({ i, v: typeof c === 'object' ? (c.extendedWaitUntil as { visible?: string })?.visible : undefined }))
      .filter((w) => w.v !== undefined);
    const skipWait = waits.find((w) => w.v === 'Skip for now');
    const skipTap = commands.findIndex((c) => typeof c === 'object' && c.tapOn === 'Skip for now');
    const tabsWait = waits.find((w) => w.v === 'Assistant');
    expect(skipWait).toBeDefined();
    expect(skipTap).toBeGreaterThan(skipWait!.i);
    expect(tabsWait?.i).toBeGreaterThan(skipTap);
    // No alternation that a pre-gate tab bar can satisfy.
    expect(waits.some((w) => /\|/.test(w.v as string))).toBe(false);
  });

  it('3.3: reaches the manual-booking slot step signed in and asserts the defaults notice', () => {
    const { commands } = loadFlow('prd-3.3-defaults-notice.yaml');
    const keys = commands.map((c) => (typeof c === 'string' ? c : Object.keys(c)[0]));
    // Signed in via the dev-auth path, never through Clerk's sign-in screen.
    expect(commands).toContainEqual({ runFlow: 'subflows/signed-in.yaml' });
    expect(commands).toContainEqual({ openLink: 'serviceos://appointments/new' });
    // The notice heading from PRD 3.3 / #1243, waited for AFTER the slot step opens.
    const noticeAt = commands.findIndex(
      (c) =>
        typeof c === 'object' &&
        (c.extendedWaitUntil as { visible?: string } | undefined)?.visible ===
          'These times use default settings',
    );
    const slotStepAt = commands.findIndex((c) => typeof c === 'object' && c.tapOn === 'Next: time');
    expect(slotStepAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(slotStepAt);
    expect(keys.slice(noticeAt)).toContain('takeScreenshot');
  });

  it('5.4: captures with airplane mode ON, survives a real process kill, and flushes only after airplane mode OFF', () => {
    const capture = loadFlow('prd-5.4-offline-capture.yaml').commands;
    const crash = loadFlow('prd-5.4-crash-relaunch.yaml').commands;
    const reconnect = loadFlow('prd-5.4-reconnect.yaml').commands;
    const at = (cmds: Command[], pred: (c: Record<string, unknown>) => boolean) =>
      cmds.findIndex((c) => typeof c === 'object' && pred(c));

    // A: offline BEFORE the hold-to-record capture, then the queued state.
    const offlineAt = at(capture, (c) => c.setAirplaneMode === 'enabled');
    const recordAt = at(capture, (c) => c.longPressOn === 'Hold to record');
    const queuedAt = at(capture, (c) => (c.extendedWaitUntil as { visible?: string })?.visible === 'Saved offline');
    expect(offlineAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(offlineAt);
    expect(queuedAt).toBeGreaterThan(recordAt);
    expect(capture.some((c) => typeof c === 'object' && c.setAirplaneMode === 'disabled')).toBe(false);

    // B: killApp first, relaunch WITHOUT clearing state, still offline.
    expect(crash[0]).toBe('killApp');
    expect(crash).toContainEqual({ launchApp: { clearState: false } });
    expect(crash.some((c) => typeof c === 'object' && 'setAirplaneMode' in c)).toBe(false);

    // C: reconnect is the first step, then the waiting banner must clear.
    expect(reconnect[0]).toEqual({ setAirplaneMode: 'disabled' });
    expect(at(reconnect, (c) => typeof (c.extendedWaitUntil as { notVisible?: string })?.notVisible === 'string')).toBe(1);
  });
});

describe('scripts/maestro-device-run.sh — the CI device harness', () => {
  const SCRIPT = path.resolve(__dirname, '../../scripts/maestro-device-run.sh');

  it('is valid bash', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it('runs 3.3, then 5.4 A → B → C, with an on-device journal/audio check after each 5.4 phase and a DB row check at the end', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Positions of the top-level INVOCATIONS (line-anchored), not mentions in comments.
    const pos = (line: string) => {
      const i = src.indexOf(`\n${line}`);
      expect(i, `script must invoke: ${line}`).toBeGreaterThan(-1);
      return i;
    };
    const flow33 = pos('run_flow prd-3.3-defaults-notice.yaml');
    const a = pos('run_flow prd-5.4-offline-capture.yaml');
    const checkA = pos('check_offline_queued "A"');
    const b = pos('run_flow prd-5.4-crash-relaunch.yaml');
    const checkB = pos('check_offline_queued "B"');
    const c = pos('run_flow prd-5.4-reconnect.yaml');
    const checkC = pos('check_flushed\n');
    expect([flow33, a, checkA, b, checkB, c, checkC]).toEqual(
      [flow33, a, checkA, b, checkB, c, checkC].slice().sort((x, y) => x - y),
    );
    // Fresh app state before 3.3 and before 5.4 A — done by the harness, not by
    // Maestro's clearState, because clearState would also wipe the
    // debug_http_host pref that points the app at Metro over `adb reverse`
    // (localhost:8081). The default emulator host 10.0.2.2 is cut by airplane
    // mode, so without it the phase-B relaunch could not even load its JS.
    const resets = [...src.matchAll(/\nreset_app\n/g)].map((m) => m.index ?? -1);
    expect(resets).toHaveLength(2);
    expect(resets[0]).toBeLessThan(flow33);
    expect(resets[1]).toBeGreaterThan(flow33);
    expect(resets[1]).toBeLessThan(a);
    expect(src).toContain('pm clear com.serviceos.app');
    expect(src).toContain('debug_http_host');
    // …so no flow may clear state itself.
    for (const f of allFlowFiles()) {
      for (const cmd of loadFlow(f).commands) {
        if (typeof cmd === 'object' && cmd.launchApp && typeof cmd.launchApp === 'object') {
          expect((cmd.launchApp as { clearState?: boolean }).clearState, f).not.toBe(true);
        }
      }
    }
    // The journal is read from the real app sandbox, not re-derived.
    expect(src).toContain('run-as com.serviceos.app cat files/offline-queue.json');
    expect(src).toContain('run-as com.serviceos.app ls files/offline-audio/');
    // "one row" is read from the real Postgres the API wrote to.
    expect(src).toMatch(/FROM voice_recordings WHERE idempotency_key/);
  });

  it('fails fast on a broken Metro bundle and leaves debug evidence for any failure', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Run 36765536371: every flow burned 2 minutes on a red box because Metro
    // returned a 500 for the Android bundle. Fetch that bundle ONCE, before any
    // flow, and fail with Metro's own error body.
    const bundleCheck = src.indexOf('\ncheck_bundle\n');
    const firstFlow = src.indexOf('\nrun_flow ');
    expect(bundleCheck).toBeGreaterThan(-1);
    expect(bundleCheck).toBeLessThan(firstFlow);
    expect(src).toContain('localhost:8081/.expo/.virtual-metro-entry.bundle?platform=android');
    // Maestro's per-command screenshots + view hierarchy, per flow.
    expect(src).toMatch(/maestro test [^\n]*--debug-output "\$OUT\/debug\//);
    // A logcat tail is written whenever the script exits non-zero.
    expect(src).toMatch(/trap [^\n]*EXIT/);
    expect(src).toContain('adb logcat -d');
  });

  it('collects every takeScreenshot PNG into the uploaded output dir after each flow', () => {
    // Run 36767934585: 3.3 passed and took its screenshot, but the PNG was not
    // in the uploaded evidence — Maestro writes takeScreenshot files relative
    // to the flow, not to the harness's output dir.
    const src = readFileSync(SCRIPT, 'utf8');
    const runFlow = src.slice(src.indexOf('run_flow() {'), src.indexOf('\n}\n', src.indexOf('run_flow() {')));
    expect(runFlow).toContain('collect_screenshots');
    expect(src).toMatch(/collect_screenshots\(\) \{[^}]*"\$FLOWS"[^}]*\.png[^}]*"\$OUT\/screenshots/);
  });
});
