import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditDockerfileBaseImages } from '../../../../scripts/collect-quality-metrics';

// Matches the resolution used by test/helpers/workflow-node-version.ts.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * These pin the Dockerfile base-image audit that backs
 * `reproducibility.allExact` in the quality-metrics artifact.
 *
 * The bug being pinned against: the original implementation matched
 * `/^FROM (node:[^\s]+)/` and computed exactness from that subset, so it
 * reported `allExact: true` while `nginx:alpine` — the image serving the web
 * SPA — floated. The regression to guard is not "does it parse a Dockerfile"
 * but "can a floating non-node base image hide from it".
 */
describe('auditDockerfileBaseImages', () => {
  it('sees non-node base images, not just node ones', () => {
    const result = auditDockerfileBaseImages(
      ['FROM node:20.20.2-alpine AS base', 'FROM nginx:alpine AS web'].join('\n'),
    );

    expect(result.map((b) => b.image)).toEqual(['node:20.20.2-alpine', 'nginx:alpine']);
    // The whole point: a floating nginx must drag exactness down.
    expect(result.every((b) => b.exact)).toBe(false);
    expect(result.filter((b) => !b.exact).map((b) => b.image)).toEqual(['nginx:alpine']);
  });

  it('treats a digest pin as exact even when the tag is floating', () => {
    const [image] = auditDockerfileBaseImages(
      'FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 AS web',
    );

    expect(image.exact).toBe(true);
    expect(image.reason).toBe('digest');
  });

  it('classifies exact tags, floating tags, and missing tags distinctly', () => {
    const result = auditDockerfileBaseImages(
      ['FROM node:20.20.2-alpine', 'FROM nginx:alpine', 'FROM scratch'].join('\n'),
    );

    expect(result.map((b) => b.reason)).toEqual(['exact-tag', 'floating-tag', 'no-tag']);
    expect(result.map((b) => b.exact)).toEqual([true, false, false]);
  });

  it('skips intra-file stage references so they cannot dilute the audit', () => {
    const result = auditDockerfileBaseImages(
      [
        'FROM node:20.20.2-alpine AS base',
        'FROM base AS shared-build',
        'FROM shared-build AS web-build',
        'FROM node:20.20.2-alpine AS api',
      ].join('\n'),
    );

    // `base` and `shared-build` are stages, not images pulled from a registry.
    expect(result.map((b) => b.image)).toEqual([
      'node:20.20.2-alpine',
      'node:20.20.2-alpine',
    ]);
  });

  it('treats a forward stage reference as external rather than ignoring it', () => {
    // Docker resolves stages declared EARLIER. A `FROM` naming a stage that does
    // not exist yet is a registry pull (and almost certainly a bug), so it must
    // stay visible to the audit instead of being silently dropped.
    const result = auditDockerfileBaseImages(
      ['FROM notyetdeclared AS first', 'FROM node:20.20.2-alpine AS notyetdeclared'].join(
        '\n',
      ),
    );

    expect(result.map((b) => b.image)).toEqual([
      'notyetdeclared',
      'node:20.20.2-alpine',
    ]);
  });

  it('is case-insensitive on FROM and AS', () => {
    const result = auditDockerfileBaseImages(
      ['from node:20.20.2-alpine as Base', 'FROM BASE AS web'].join('\n'),
    );

    expect(result.map((b) => b.image)).toEqual(['node:20.20.2-alpine']);
  });

  it('ignores FROM inside comments and unrelated instructions', () => {
    const result = auditDockerfileBaseImages(
      [
        '# FROM nginx:alpine AS web  (old, replaced)',
        'FROM node:20.20.2-alpine AS api',
        'COPY --from=web-build /app/dist /srv',
      ].join('\n'),
    );

    expect(result.map((b) => b.image)).toEqual(['node:20.20.2-alpine']);
  });

  it('reports the real Dockerfile as fully pinned', () => {
    // Guards the actual repo state: if someone reintroduces a floating base
    // image, this fails rather than quietly flipping allExact in the artifact.
    const contents = readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const result = auditDockerfileBaseImages(contents);

    expect(result.length).toBeGreaterThan(0);
    expect(result.filter((b) => !b.exact)).toEqual([]);
  });
});
