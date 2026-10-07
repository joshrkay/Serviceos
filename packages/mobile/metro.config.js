// Expo + monorepo Metro config.
//
// packages/mobile is an isolated project (not a root npm workspace). Metro
// (1) watches the repo root so packages/shared changes are picked up, and
// (2) resolves @ai-service-os/shared straight from its TypeScript source — no
// built `dist` is required, so fresh checkouts and EAS workers (which never
// build shared) Just Work. shared ships ESM whose re-exports use explicit
// `.js` specifiers; Metro doesn't map `.js`→`.ts` on its own, so resolveRequest
// rewrites shared's internal `.js` specifiers to their `.ts` source.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');
const fs = require('fs');
const { resolveDevAuth } = require('./scripts/dev-auth-guard.cjs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const sharedSrc = path.resolve(workspaceRoot, 'packages/shared/src');

const config = getDefaultConfig(projectRoot);

// DEV/TEST-ONLY (PRD 3.3, #1015): EXPO_PUBLIC_AUTH_MODE=dev swaps the Clerk SDK
// for src/dev/clerk-expo-dev-shim.tsx so the Maestro device harness reaches
// signed-in screens against an API in DEV_AUTH_BYPASS mode. resolveDevAuth
// THROWS here for a production build (EAS profile other than `development`,
// or NODE_ENV=production) — see scripts/dev-auth-guard.cjs.
const devAuth = resolveDevAuth(process.env);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'query-string' &&
    context.originModulePath.includes(`${path.sep}expo-router${path.sep}`)
  ) {
    return { type: 'sourceFile', filePath: path.join(projectRoot, 'src/lib/queryStringCompat.ts') };
  }
  if (devAuth.shimPath && moduleName === '@clerk/clerk-expo') {
    return { type: 'sourceFile', filePath: devAuth.shimPath };
  }
  // Stripe Terminal is native-only; web e2e export must not load NativeModules.
  if (
    platform === 'web' &&
    (moduleName === '@stripe/stripe-terminal-react-native' ||
      moduleName.startsWith('@stripe/stripe-terminal-react-native/'))
  ) {
    return {
      type: 'sourceFile',
      filePath: path.join(projectRoot, 'src/payments/stripeTerminal.web-stub.js'),
    };
  }
  // Bare package → its TypeScript entry.
  if (moduleName === '@ai-service-os/shared') {
    return { type: 'sourceFile', filePath: path.join(sharedSrc, 'index.ts') };
  }
  // shared's internal `./foo.js` ESM specifiers → the `.ts` source sibling.
  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    typeof context.originModulePath === 'string' &&
    context.originModulePath.startsWith(sharedSrc)
  ) {
    const base = path.resolve(path.dirname(context.originModulePath), moduleName.slice(0, -3));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate)) {
        return { type: 'sourceFile', filePath: candidate };
      }
    }
  }
  return (baseResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
