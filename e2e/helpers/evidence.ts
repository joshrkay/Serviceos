import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Artifact {
  kind: 'api' | 'screenshot' | 'har';
  path: string;
  label: string;
}

export class RowEvidence {
  private readonly base: string;
  private readonly collected: Artifact[] = [];

  constructor(base: string) {
    this.base = base;
    mkdirSync(base, { recursive: true });
  }

  apiDir(): string {
    const dir = join(this.base, 'api');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  addArtifact(artifact: Artifact): void {
    this.collected.push(artifact);
  }

  artifacts(): Artifact[] {
    return this.collected;
  }
}

export function writeJsonArtifact(dir: string, label: string, data: unknown): string {
  const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
  const filePath = join(dir, `${safe}-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}
