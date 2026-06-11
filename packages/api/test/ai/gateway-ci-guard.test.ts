/**
 * P2-027 Gap 3 — CI guard demonstrably fails on planted direct provider call
 *
 * Tests that check-ai-gateway-guard.sh:
 *   - exits 0 when no direct calls exist
 *   - exits non-zero when a direct `new OpenAI(` or
 *     `client.chat.completions.create` call is planted
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const GUARD_SCRIPT = path.resolve(
  __dirname,
  '../../scripts/check-ai-gateway-guard.sh'
);

const API_SRC = path.resolve(__dirname, '../../src');

describe('P2-027 Gap 3 — AI gateway guard', () => {
  it('script exists and is executable', () => {
    expect(fs.existsSync(GUARD_SCRIPT)).toBe(true);
    const stat = fs.statSync(GUARD_SCRIPT);
    // owner-execute bit
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  it('exits 0 on clean codebase (no direct OpenAI calls outside gateway/providers)', () => {
    expect(() => {
      execSync(`bash "${GUARD_SCRIPT}"`, {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'pipe',
      });
    }).not.toThrow();
  });

  it('exits non-zero when a planted direct `new OpenAI(` call is detected', () => {
    const tmpFile = path.join(os.tmpdir(), `planted-openai-${Date.now()}.ts`);
    try {
      // Plant a direct OpenAI call in a temp file that looks like it's in src/
      fs.writeFileSync(tmpFile, `import OpenAI from 'openai';\nconst client = new OpenAI({ apiKey: 'x' });\n`);

      // Run the guard with the planted file path injected as an extra search target
      // by temporarily symlinking it into a non-gateway src location.
      // Simpler: just run the guard against a temp directory with the planted file.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-guard-test-'));
      const plantedPath = path.join(tmpDir, 'planted.ts');
      fs.writeFileSync(plantedPath, `import OpenAI from 'openai';\nconst client = new OpenAI({ apiKey: 'x' });\n`);

      let threw = false;
      try {
        execSync(`bash "${GUARD_SCRIPT}" "${tmpDir}"`, {
          cwd: path.resolve(__dirname, '../..'),
          stdio: 'pipe',
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('exits non-zero when a planted `client.chat.completions.create` call is detected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-guard-test-'));
    const plantedPath = path.join(tmpDir, 'planted.ts');
    fs.writeFileSync(
      plantedPath,
      `const result = await client.chat.completions.create({ model: 'gpt-4', messages: [] });\n`
    );

    let threw = false;
    try {
      execSync(`bash "${GUARD_SCRIPT}" "${tmpDir}"`, {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'pipe',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
