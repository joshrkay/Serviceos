import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('generate-qa-107-ledger emits exactly 107 items', () => {
  const res = spawnSync(process.execPath, ['scripts/generate-qa-107-ledger.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const catalog = JSON.parse(readFileSync(resolve(root, 'qa/manual-107/catalog.json'), 'utf8'));
  assert.equal(catalog.length, 107);
  assert.equal(catalog[0].id, 'QA-001');
  assert.equal(catalog[106].id, 'QA-107');
  const ids = new Set(catalog.map((c) => c.id));
  assert.equal(ids.size, 107);
});

test('acceptance criteria ledger has binary pass/fail arrays', () => {
  const ledger = JSON.parse(
    readFileSync(resolve(root, 'qa/manual-107/acceptance-criteria-ledger.json'), 'utf8'),
  );
  assert.equal(ledger.items.length, 107);
  for (const item of ledger.items) {
    assert.ok(item.passCriteria?.length >= 1, `${item.id} missing passCriteria`);
    assert.ok(item.failCriteria?.length >= 1, `${item.id} missing failCriteria`);
    assert.ok(item.manualSteps?.length >= 1, `${item.id} missing manualSteps`);
    assert.ok(item.requiredEvidence?.length >= 1, `${item.id} missing requiredEvidence`);
  }
});

test('section coverage includes all 22 goal sections', () => {
  const catalog = JSON.parse(readFileSync(resolve(root, 'qa/manual-107/catalog.json'), 'utf8'));
  const sections = new Set(catalog.map((c) => c.section));
  for (let s = 1; s <= 22; s += 1) {
    assert.ok(sections.has(s), `missing section ${s}`);
  }
});

test('documentation deliverables exist', () => {
  for (const f of [
    'qa/manual-107/README.md',
    'qa/manual-107/REPRODUCTION.md',
    'qa/manual-107/DEFECT-LOG.md',
    'qa/manual-107/DEPLOYMENT-MANIFEST.md',
    'qa/manual-107/FINAL-REPORT.md',
    'qa/manual-107/ACCEPTANCE-CRITERIA.md',
  ]) {
    assert.ok(existsSync(resolve(root, f)), f);
  }
});
