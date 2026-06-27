import { join, sep } from 'node:path';

/**
 * Resolve the directory that holds the built web SPA (`packages/web/dist`).
 *
 * The SPA always lives at `<repoRoot>/packages/web/dist`, but the API's
 * compiled entrypoint runs from different depths depending on environment:
 *
 *   - dev  (ts-node):     __dirname = <repoRoot>/packages/api/src
 *   - prod (built image): __dirname = <repoRoot>/packages/api/dist/src
 *
 * A fixed relative hop (`../../web/dist`) therefore resolves correctly in dev
 * but (dropping `src` then `dist`) points at a non-existent
 * `packages/api/web/dist` inside the built image. Anchoring on the
 * `packages/api` path boundary makes the extra
 * `dist/` segment irrelevant, so the same code resolves in both.
 *
 * In the Docker `api` stage (WORKDIR=/app; web/dist COPYed to
 * `/app/packages/web/dist`; CMD `node packages/api/dist/src/index.js`) this
 * returns `/app/packages/web/dist`.
 *
 * @param baseDir Directory of the calling module — pass `__dirname`.
 * @param cwd     Working-directory fallback anchor (defaults to process.cwd()).
 */
export function resolveWebDistDir(baseDir: string, cwd: string = process.cwd()): string {
  const marker = `${sep}packages${sep}api${sep}`;
  const boundary = baseDir.lastIndexOf(marker);
  if (boundary !== -1) {
    const repoRoot = baseDir.slice(0, boundary);
    return join(repoRoot, 'packages', 'web', 'dist');
  }
  // Fallback for unusual layouts (e.g. a flattened bundle): resolve relative
  // to the working directory, which is the container WORKDIR (/app).
  return join(cwd, 'packages', 'web', 'dist');
}
