import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MatrixRow } from '../matrix';

const ARTIFACT_ROOT = process.env.ARTIFACT_ROOT ?? 'qa/artifacts';
const REPORT_DIR = process.env.REPORT_DIR ?? 'qa/reports';

export function runRoot(): string {
  const runId = process.env.QA_RUN_ID ?? new Date().toISOString().slice(0, 10);
  return join(REPORT_DIR, runId);
}

export function artifactRoot(): string {
  return join(runRoot(), 'artifacts');
}

export type Verdict = 'pass' | 'fail' | 'partial' | 'na';

export interface ArtifactRef {
  kind: 'api' | 'ui' | 'db' | 'note';
  path: string;
  label: string;
}

export interface RowManifest {
  id: string;
  feature: string;
  module: string;
  verdict: Verdict;
  passCriteria: string;
  failureReason?: string;
  notes?: string[];
  artifacts: ArtifactRef[];
  startedAt: string;
  finishedAt: string;
  expected?: string;
}

export class RowEvidence {
  private artifacts: ArtifactRef[] = [];
  private notes: string[] = [];
  private startedAt = new Date().toISOString();
  public verdict: Verdict = 'fail';
  public failureReason?: string;
  private rowDir: string;

  constructor(public readonly row: MatrixRow) {
    this.rowDir = join(artifactRoot(), row.id);
    mkdirSync(join(this.rowDir, 'api'), { recursive: true });
    mkdirSync(join(this.rowDir, 'ui'), { recursive: true });
    mkdirSync(join(this.rowDir, 'db'), { recursive: true });
  }

  get dir(): string {
    return this.rowDir;
  }

  apiDir(): string {
    return join(this.rowDir, 'api');
  }

  uiDir(): string {
    return join(this.rowDir, 'ui');
  }

  dbDir(): string {
    return join(this.rowDir, 'db');
  }

  addArtifact(ref: ArtifactRef): void {
    this.artifacts.push(ref);
  }

  note(msg: string): void {
    this.notes.push(msg);
  }

  pass(note?: string): void {
    this.verdict = 'pass';
    if (note) this.notes.push(note);
  }

  partial(reason: string): void {
    this.verdict = 'partial';
    this.failureReason = reason;
  }

  fail(reason: string): void {
    this.verdict = 'fail';
    this.failureReason = reason;
  }

  na(reason: string): void {
    this.verdict = 'na';
    this.failureReason = reason;
  }

  finalize(): void {
    const manifest: RowManifest = {
      id: this.row.id,
      feature: this.row.feature,
      module: this.row.module,
      verdict: this.verdict,
      passCriteria: this.row.passCriteria,
      failureReason: this.failureReason,
      notes: this.notes.length ? this.notes : undefined,
      artifacts: this.artifacts,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      expected: this.row.expected,
    };
    writeFileSync(join(this.rowDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
}

export function writeJsonArtifact(dir: string, name: string, payload: unknown): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export function writeTextArtifact(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

export const paths = {
  runRoot,
  artifactRoot,
  ARTIFACT_ROOT,
  REPORT_DIR,
};
