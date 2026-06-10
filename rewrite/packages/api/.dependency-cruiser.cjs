/**
 * Enforced architectural boundaries (the rewrite's answer to the old
 * 3,200-line app.ts): the core may not know about modules or HTTP, modules
 * may not reach into the HTTP layer, and nothing imports the composition
 * root. Run via `npm run lint:boundaries`.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-stays-pure',
      comment: 'core (db, commands, jobs, outbox) must not depend on modules or http',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '^src/(modules|http)' },
    },
    {
      name: 'modules-no-http',
      comment: 'domain modules must not depend on the http layer',
      severity: 'error',
      from: { path: '^src/modules' },
      to: { path: '^src/http' },
    },
    {
      name: 'nothing-imports-composition-root',
      comment: 'bootstrap/index are the top of the graph',
      severity: 'error',
      from: { path: '^src', pathNot: '^src/(index|bootstrap)\\.ts$' },
      to: { path: '^src/(bootstrap|index)\\.ts$' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.build.json' },
  },
};
