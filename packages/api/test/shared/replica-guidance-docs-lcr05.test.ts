/**
 * LCR-05 — docs pin for the replica-count guidance.
 *
 * A live call's session lives in the memory of the process that answered it
 * (VoiceSessionStore is a per-process Map), so every process that answers
 * calls — every PROCESS_ROLE except `worker` — runs ONE replica until session
 * state is externalized. The boot guard (validateFeatureRequiredConfig in
 * src/shared/config.ts, pinned by test/shared/config.test.ts) refuses
 * NUM_REPLICAS > 1 on those roles, but it only sees NUM_REPLICAS: a replica
 * count raised in railway.toml or the Railway autoscaler without it reads as
 * one replica. So the places an operator reads before changing a replica
 * count must say both things, and must not offer Redis + PgBouncer as the
 * prerequisites that make a second call-answering replica safe: railway.toml,
 * railway.voice.toml, scaling.md, deployment.md, the secret manifest, the Phase 5
 * handoff and the CI gating matrix.
 *
 * Same string-assertion approach as the ci-workflow*.test.ts pins.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

/** The run of `#` comment lines directly above the `numReplicas = …` line. */
function numReplicasComment(toml: string): string {
  const lines = toml.split('\n');
  const at = lines.findIndex((l) => /^numReplicas\s*=/.test(l));
  expect(at, 'numReplicas line').toBeGreaterThan(0);
  const comment: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].startsWith('#'); i--) comment.unshift(lines[i].replace(/^#\s?/, ''));
  return comment.join(' ').replace(/\s+/g, ' ');
}

/** `md` from the line starting with `start` up to (not including) the line starting with `end`. */
function section(md: string, start: RegExp, end: RegExp): string {
  const lines = md.split('\n');
  const from = lines.findIndex((l) => start.test(l));
  expect(from, `section ${start}`).toBeGreaterThanOrEqual(0);
  const to = lines.findIndex((l, i) => i > from && end.test(l));
  return lines.slice(from, to < 0 ? undefined : to).join(' ').replace(/\s+/g, ' ');
}

/** Call-answering processes stay at one replica, and which ones those are. */
function expectOneReplicaRule(text: string): void {
  expect(text).toMatch(/\bone replica\b/i);
  expect(text).toMatch(/every `?PROCESS_ROLE`? except `?worker`?/i);
  expect(text).toMatch(/until session state is externalized/i);
}

/** Both halves of the guidance, in whatever words each file uses around them. */
function expectReplicaGuidance(text: string): void {
  expectOneReplicaRule(text);
  // NUM_REPLICAS is the only count the boot guard sees.
  expect(text).toMatch(/NUM_REPLICAS`? to the real replica count/i);
  expect(text).toMatch(/validateFeatureRequiredConfig/);
}

describe('LCR-05 — call-answering processes stay at one replica, and NUM_REPLICAS tells the boot guard', () => {
  it('railway.toml (web): one replica, NUM_REPLICAS = the real count, and Redis/PgBouncer are not the unlock', () => {
    const src = read('railway.toml');
    expect(src).toMatch(/^numReplicas = 1$/m);
    const comment = numReplicasComment(src);
    expectReplicaGuidance(comment);
    expect(comment).not.toMatch(/Raising this past 1 REQUIRES setting both REDIS_URL/i);
  });

  it('railway.voice.toml: one replica, NUM_REPLICAS = the real count, and Redis/PgBouncer are not the unlock', () => {
    const src = read('railway.voice.toml');
    expect(src).toMatch(/^numReplicas = 1$/m);
    const comment = numReplicasComment(src);
    expectReplicaGuidance(comment);
    expect(comment).not.toMatch(/scale it up only alongside the same Redis\/PgBouncer prerequisites/i);
  });

  it('scaling.md Provisioning & rollout step 3 scales only the worker and names NUM_REPLICAS', () => {
    const step3 = section(read('docs/runbooks/scaling.md'), /^3\. \*\*Replicas/, /^4\. \*\*Graceful drain/);
    expectReplicaGuidance(step3);
    expect(step3).toMatch(/PROCESS_ROLE=worker/);
  });

  it('scaling.md go-live checklist step 3 says the same', () => {
    const step3 = section(read('docs/runbooks/scaling.md'), /^3\. \*\*Raise replicas/, /^4\. \*\*Measure/);
    expectReplicaGuidance(step3);
  });

  it('deployment.md horizontal scaling note says the same, and its Redis step no longer cites railway.toml as the unlock', () => {
    const note = section(read('docs/deployment.md'), /^## Horizontal scaling note/, /^## /);
    expectReplicaGuidance(note);
    expect(note).not.toMatch(/in-memory state without it — see `railway\.toml`/);
    expect(note).toMatch(/the gate for the worker's `numReplicas > 1`/);
  });

  it("secret-manifest.md: the redis-multi-instance gate is the worker's, not a call-answering unlock", () => {
    const gate = section(read('docs/launch/secret-manifest.md'), /^### `redis-multi-instance\.yml`/, /^(---|#)/);
    expectOneReplicaRule(gate);
    expect(gate).toMatch(/before the worker service runs more than one replica/);
    expect(gate).not.toMatch(/before `numReplicas > 1` ships in `railway\.toml`/);
  });

  it('secret-manifest.md Railway operator cutover says the same, and Redis/PgBouncer are not the unlock', () => {
    const cutover = section(read('docs/launch/secret-manifest.md'), /^## Railway operator cutover/, /^## /);
    expectReplicaGuidance(cutover);
    expect(cutover).not.toMatch(/Scaling past one replica additionally requires `REDIS_URL` \+ `NUM_REPLICAS` \+ PgBouncer/);
  });

  it('phase5-validation-handoff.md prerequisites say the same, with no N web replicas', () => {
    const doc = read('docs/runbooks/phase5-validation-handoff.md');
    const prereqs = section(doc, /^## Prerequisites/, /^## /);
    expectReplicaGuidance(prereqs);
    expect(prereqs).not.toMatch(/`numReplicas` ≥ 2 in `railway\.toml`/);
    expect(prereqs).not.toMatch(/staging with N replicas|API×N/);
    expect(doc).not.toMatch(/ceil\(1000 \/ per-instance-ceiling\)/);
  });

  it("ci-gating.md: the redis-multi-instance row is the gate for the worker's replicas", () => {
    const row = read('docs/launch/ci-gating.md')
      .split('\n')
      .find((l) => l.startsWith('| Redis multi-instance correctness |'));
    expect(row, 'redis-multi-instance row').toBeDefined();
    expect(row).toMatch(/the gate for the worker's `numReplicas > 1`/);
    expect(row).toMatch(/call-answering services stay at one replica, LCR-05/);
  });
});
