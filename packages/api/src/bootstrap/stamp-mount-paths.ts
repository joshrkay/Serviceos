/**
 * Records each router layer's mount path at registration (#1555).
 *
 * Express 4 kept a decodable regexp on every layer, so the route manifest
 * (src/app-route-manifest.ts) and the I18 owner-route contract could read a
 * mount path straight off `layer.regexp`. Express 5's router compiles paths
 * with path-to-regexp v8 into matcher closures and keeps nothing readable,
 * so the path is unrecoverable after the fact. This wraps
 * `Router.prototype.use` — the single funnel both `app.use()` and
 * `router.use()` go through — to stamp the literal path it was given onto
 * every layer it adds. Behaviour is unchanged; the stamp is read-only
 * metadata for introspection.
 *
 * Side-effect module: import it before any `.use()` call (app.ts imports it
 * first). Idempotent, so repeated imports or a hot-reloaded module never
 * double-wrap.
 */
import express from 'express';

export const MOUNT_PATH = Symbol.for('serviceos.layerMountPath');

type MountPath = string | string[];
interface RouterProto {
  use: (this: { stack: Array<Record<PropertyKey, unknown>> }, ...args: unknown[]) => unknown;
  [MOUNT_PATH]?: true;
}

const proto = (express.Router as unknown as { prototype: RouterProto }).prototype;

if (!proto[MOUNT_PATH]) {
  const originalUse = proto.use;
  proto.use = function stampedUse(this, ...args: unknown[]) {
    // Same path resolution as router's own use(): a leading non-function
    // argument (after unwrapping nested arrays) is the path; default '/'.
    let path: MountPath = '/';
    let first: unknown = args[0];
    while (Array.isArray(first) && first.length !== 0) first = first[0];
    if (typeof args[0] !== 'function' && typeof first !== 'function') {
      path = args[0] as MountPath;
    }
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    for (let i = before; i < this.stack.length; i++) this.stack[i][MOUNT_PATH] = path;
    return result;
  };
  proto[MOUNT_PATH] = true;
}
