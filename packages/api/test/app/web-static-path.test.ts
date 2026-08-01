import { describe, it, expect } from 'vitest';
import { join, sep } from 'node:path';
import { resolveWebDistDir } from '../../src/web-static-path';

// The Dockerfile `api` stage is the source of truth for these paths:
//   WORKDIR /app
//   COPY --from=api-build  /app/packages/api/dist  packages/api/dist
//   COPY --from=web-build  /app/packages/web/dist  packages/web/dist
//   CMD ["node", "packages/api/dist/src/index.js"]
// => at runtime __dirname === /app/packages/api/dist/src
//    and the SPA is served from /app/packages/web/dist
const containerDirname = join(sep, 'app', 'packages', 'api', 'dist', 'src');
const containerWebDist = join(sep, 'app', 'packages', 'web', 'dist');

describe('resolveWebDistDir', () => {
  it('resolves to where the Dockerfile COPYs web/dist in the built image', () => {
    expect(resolveWebDistDir(containerDirname)).toBe(containerWebDist);
  });

  it('does NOT resolve to the buggy packages/api/dist/web/dist path', () => {
    // The original code `join(__dirname, '../../web/dist')` from
    // /app/packages/api/dist/src drops `src` then `dist`, landing on the
    // non-existent /app/packages/api/web/dist.
    const buggy = join(containerDirname, '..', '..', 'web', 'dist');
    expect(buggy).toBe(join(sep, 'app', 'packages', 'api', 'web', 'dist'));
    expect(resolveWebDistDir(containerDirname)).not.toBe(buggy);
  });

  it('resolves correctly in dev where __dirname is packages/api/src', () => {
    const devDirname = join(sep, 'home', 'dev', 'serviceos', 'packages', 'api', 'src');
    expect(resolveWebDistDir(devDirname)).toBe(
      join(sep, 'home', 'dev', 'serviceos', 'packages', 'web', 'dist'),
    );
  });

  it('always targets <repoRoot>/packages/web/dist regardless of dist nesting', () => {
    for (const d of [
      join(sep, 'app', 'packages', 'api', 'src'),
      join(sep, 'app', 'packages', 'api', 'dist', 'src'),
    ]) {
      expect(resolveWebDistDir(d).endsWith(join('packages', 'web', 'dist'))).toBe(true);
    }
  });

  it('falls back to the working directory when the packages/api boundary is absent', () => {
    const cwd = join(sep, 'srv', 'bundle');
    expect(resolveWebDistDir(join(sep, 'weird', 'flattened', 'layout'), cwd)).toBe(
      join(cwd, 'packages', 'web', 'dist'),
    );
  });
});
