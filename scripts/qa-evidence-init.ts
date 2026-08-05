/**
 * Initialize qa-evidence/<QA-ID>/ scaffolding and update evidence manifest.
 *
 * Usage:
 *   npx tsx scripts/qa-evidence-init.ts QA-001
 *   npx tsx scripts/qa-evidence-init.ts --all
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'qa-evidence');
const CATALOG = resolve(process.cwd(), 'qa/manual-107/catalog.json');
const MANIFEST = join(ROOT, 'manifest.json');

interface CatalogItem {
  id: string;
  name: string;
  section: number;
  sectionName: string;
  tenant: string;
  role: string;
}

interface EvidenceEntry {
  qaId: string;
  testName: string;
  status: 'PASS' | 'FAIL' | 'NOT_RUN' | 'BLOCKED';
  environment: string;
  tenant: string;
  userRole: string;
  startTimestamp: string | null;
  endTimestamp: string | null;
  recordingPath: string | null;
  supplementalEvidencePaths: string[];
  relatedEntityIds: Record<string, string>;
  correlationIds: string[];
  commitSha: string | null;
  railwayDeploymentId: string | null;
  verificationNotes: string;
}

function loadCatalog(): CatalogItem[] {
  return JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogItem[];
}

function loadManifest(): { entries: EvidenceEntry[] } {
  if (!existsSync(MANIFEST)) {
    return { entries: [] };
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as { entries: EvidenceEntry[] };
}

function initOne(item: CatalogItem): void {
  const dir = join(ROOT, item.id);
  mkdirSync(dir, { recursive: true });
  const notes = join(dir, 'notes.md');
  if (!existsSync(notes)) {
    writeFileSync(
      notes,
      `# ${item.id} — ${item.name}\n\n` +
        `- Section: ${item.section}. ${item.sectionName}\n` +
        `- Tenant: ${item.tenant}\n` +
        `- Role: ${item.role}\n` +
        `- Status: NOT_RUN\n\n` +
        `## Verification notes\n\n(pending)\n`,
    );
  }
  // placeholders for required artifacts (empty files not created — recordings added at run time)
  writeFileSync(join(dir, '.gitkeep'), '');
}

function main(): void {
  const catalog = loadCatalog();
  const arg = process.argv[2];
  const selected =
    arg === '--all' || !arg
      ? catalog
      : catalog.filter((c) => c.id === arg.toUpperCase());
  if (selected.length === 0) {
    console.error(`No catalog match for ${arg}`);
    process.exit(1);
  }

  mkdirSync(ROOT, { recursive: true });
  const manifest = loadManifest();
  const byId = new Map(manifest.entries.map((e) => [e.qaId, e]));

  for (const item of selected) {
    initOne(item);
    if (!byId.has(item.id)) {
      byId.set(item.id, {
        qaId: item.id,
        testName: item.name,
        status: 'NOT_RUN',
        environment: process.env.QA_TARGET_ENV ?? 'development',
        tenant: item.tenant,
        userRole: item.role,
        startTimestamp: null,
        endTimestamp: null,
        recordingPath: null,
        supplementalEvidencePaths: [],
        relatedEntityIds: {},
        correlationIds: [],
        commitSha: process.env.GITHUB_SHA ?? null,
        railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
        verificationNotes: '',
      });
    }
  }

  const entries = catalog.map(
    (c) =>
      byId.get(c.id) ?? {
        qaId: c.id,
        testName: c.name,
        status: 'NOT_RUN' as const,
        environment: process.env.QA_TARGET_ENV ?? 'development',
        tenant: c.tenant,
        userRole: c.role,
        startTimestamp: null,
        endTimestamp: null,
        recordingPath: null,
        supplementalEvidencePaths: [],
        relatedEntityIds: {},
        correlationIds: [],
        commitSha: null,
        railwayDeploymentId: null,
        verificationNotes: '',
      },
  );

  const counts = {
    PASS: entries.filter((e) => e.status === 'PASS').length,
    FAIL: entries.filter((e) => e.status === 'FAIL').length,
    NOT_RUN: entries.filter((e) => e.status === 'NOT_RUN').length,
    BLOCKED: entries.filter((e) => e.status === 'BLOCKED').length,
  };

  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        title: 'ServiceOS QA Evidence Manifest',
        updatedAt: new Date().toISOString(),
        counts,
        entries,
      },
      null,
      2,
    ),
  );
  console.log(`Initialized ${selected.length} evidence dirs under ${ROOT}`);
  console.log(`Manifest counts: ${JSON.stringify(counts)}`);
}

main();
