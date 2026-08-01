import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression: ISSUE-003 — Railway expanded a provider credential in Docker
// build logs, and nginx logged websocket query-string bearer tokens.
// Found by /qa on 2026-07-25
// Report: .gstack/qa-reports/qa-report-app-therivetapp-com-2026-07-25.md
describe('deployment secret hygiene', () => {
  const root = resolve(__dirname, '../../../..');

  it('does not accept provider credentials as Docker build arguments', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/^ARG ELEVENLABS_API_KEY/m);
    expect(dockerfile).not.toMatch(/ELEVENLABS_API_KEY=.*render-fillers/m);
  });

  it('suppresses access logging on the websocket token endpoint', () => {
    const template = readFileSync(
      resolve(root, 'packages/web/nginx.conf.template'),
      'utf8',
    );
    expect(template).toMatch(
      /location = \/api\/ws\s*\{[\s\S]*?access_log off;/,
    );
  });
});
