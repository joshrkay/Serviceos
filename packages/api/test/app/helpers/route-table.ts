/**
 * Route-table introspection for the Express app built by createApp().
 *
 * Walks `app._router.stack` (Express 4) and renders every mounted route and
 * middleware layer, in registration order, as stable text. This is the
 * behavioural gate for the app.ts decomposition: a refactor that only MOVES
 * code cannot change the route table or the middleware order, so a byte-
 * identical table before/after is evidence the move was behaviour-neutral.
 *
 * It is deliberately reusable (not inlined in the test) because the auth-
 * boundary assertions need the same walk with layer depth retained.
 */

/** One layer of the walked router stack. */
export interface RouteLayer {
  /** 'route' for an endpoint (app.get/post/...), 'use' for middleware. */
  kind: 'route' | 'use';
  /** Nesting depth; 0 = registered directly on the app. */
  depth: number;
  /** Registration index within the top-level stack (shared by nested layers). */
  topLevelIndex: number;
  /** Full mount path(s). Multiple when one app.use() took an array of paths. */
  paths: string[];
  /** Uppercased HTTP methods, for `kind === 'route'`. */
  methods: string[];
  /** Handler function name — 'helmetMiddleware', 'requireAuth', '<anonymous>'. */
  name: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Turn one path-to-regexp source into a readable path.
 *
 * Express 4 compiles `app.use('/foo')` to `/^\/foo\/?(?=\/|$)/i` and
 * `app.get('/x/:id')` to `/^\/x\/(?:([^\/]+?))\/?$/i`. We undo just enough of
 * that to get `/foo` and `/x/:id` back.
 */
function decodeOne(source: string, keys: ReadonlyArray<{ name: string | number }>): string {
  let s = source.replace(/^\^/, '');
  // Trailing mount/route terminators.
  s = s
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\/\?\$$/, '')
    .replace(/\$$/, '');
  // Named params, in the order path-to-regexp recorded them. Two shapes occur:
  // a param in a *mount* path carries its own leading separator and an
  // unescaped class — `(?:\/([^/]+?))` — while one in a route path has neither
  // — `(?:([^\/]+?))`. Match both: optional separator (preserved for the
  // unescaping step below) and optional backslash inside the class.
  let ki = 0;
  s = s.replace(
    /\(\?:(\\\/)?\(\[\^\\?\/\]\+\?\)\)/g,
    (_m, slash: string | undefined) => `${slash ?? ''}:${keys[ki++]?.name ?? 'param'}`,
  );
  // Wildcards and escapes.
  s = s.replace(/\(\.\*\)/g, '*').replace(/\\\//g, '/').replace(/\\\./g, '.');
  // Normalise `//` and a trailing slash introduced by nested mounts.
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** All mount paths for a layer ('' = mounted at the root / applies globally). */
function layerPaths(layer: any): string[] {
  if (!layer.regexp || layer.regexp.fast_slash) return [''];
  // One app.use([...]) compiles to a single alternated regexp.
  return String(layer.regexp.source)
    .split(/\|(?=\^)/)
    .map((part) => decodeOne(part, layer.keys ?? []));
}

/** Walk the app's router stack into a flat, ordered list of layers. */
export function collectRouteLayers(app: unknown): RouteLayer[] {
  const stack: any[] = (app as any)._router?.stack ?? [];
  const out: RouteLayer[] = [];

  const walk = (layers: any[], prefix: string, depth: number, topLevelIndex: number): void => {
    layers.forEach((layer, i) => {
      const idx = depth === 0 ? i : topLevelIndex;
      const paths = layerPaths(layer);

      if (layer.route) {
        const routePaths: string[] = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        out.push({
          kind: 'route',
          depth,
          topLevelIndex: idx,
          // A sub-router's own root route is '/', which would render as
          // '/api/foo/'. Express is non-strict by default, so the two are the
          // same route — normalise so the table reads cleanly.
          paths: routePaths.map((p) => {
            const joined = `${prefix}${p}`.replace(/\/{2,}/g, '/');
            return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
          }),
          methods: Object.keys(layer.route.methods)
            .map((m) => m.toUpperCase())
            .sort(),
          name: layer.name,
        });
        return;
      }

      if (layer.handle?.stack) {
        // A nested Router — recurse once per mount path.
        for (const p of paths) walk(layer.handle.stack, `${prefix}${p}`, depth + 1, idx);
        return;
      }

      out.push({
        kind: 'use',
        depth,
        topLevelIndex: idx,
        paths: paths.map((p) => `${prefix}${p}` || '/'),
        methods: [],
        name: layer.name || '<anonymous>',
      });
    });
  };

  walk(stack, '', 0, 0);
  return out;
}

/**
 * Render layers as stable snapshot text.
 *
 * Registration indices are deliberately omitted: inserting one route would
 * otherwise renumber every following line and bury the real change in noise.
 * Order is carried by line order alone.
 */
export function renderRouteTable(layers: readonly RouteLayer[]): string {
  return layers
    .map((l) =>
      l.kind === 'route'
        ? `${l.methods.join(',')} ${l.paths.join(' , ')}`
        : `${'  '.repeat(l.depth)}USE ${l.paths.map((p) => p || '/').join(' , ')}  [${l.name}]`,
    )
    .join('\n');
}

/** Convenience: the full route table for an app, as text. */
export function renderAppRouteTable(app: unknown): string {
  return renderRouteTable(collectRouteLayers(app));
}
