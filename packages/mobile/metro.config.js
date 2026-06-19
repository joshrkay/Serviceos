// Expo + monorepo Metro config.
//
// packages/mobile is an isolated project (not a root npm workspace), so Metro
// must be told to (1) watch the repo root for changes to packages/shared, and
// (2) resolve the pure-Zod @ai-service-os/shared contracts straight from source
// — shared ships ESM with an unbuilt `dist`, so we point at ../shared/src and
// let Metro transpile the TS, avoiding a build step in the inner loop.
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
  '@ai-service-os/shared': path.resolve(workspaceRoot, 'packages/shared/src'),
};

module.exports = withNativeWind(config, { input: './global.css' });
