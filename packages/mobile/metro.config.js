// Expo + monorepo Metro config.
//
// packages/mobile is an isolated project (not a root npm workspace), so Metro
// must be told to (1) watch the repo root for changes to packages/shared, and
// (2) resolve the pure-Zod @ai-service-os/shared package from its built `dist`.
// shared ships ESM whose re-exports use explicit `.js` specifiers; only the
// compiled `dist` has real `.js` files (src has only `.ts`, which neither Metro
// nor tsc maps from a `.js` specifier under node resolution). web/api consume
// `dist` the same way via package.json `main`. Rebuild shared after changing it.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  // Point at the package root so Metro honors package.json `main` → dist/index.js.
  '@ai-service-os/shared': path.resolve(workspaceRoot, 'packages/shared'),
};

module.exports = withNativeWind(config, { input: './global.css' });
