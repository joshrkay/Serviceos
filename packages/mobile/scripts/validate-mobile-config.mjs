#!/usr/bin/env node
/**
 * Validates packages/mobile store/release config before EAS build.
 *
 * Exit 1 — missing referenced asset files, or permission strings still say "ServiceOS".
 * Exit 0 — OK. Prints WARN lines (still exit 0) when REPLACE_WITH_* placeholders
 *          or empty extra.eas.projectId remain (expected until eas init / submit creds).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(__dirname, '..');
const appJsonPath = join(mobileRoot, 'app.json');
const easJsonPath = join(mobileRoot, 'eas.json');

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function collectStringLeaves(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStringLeaves(child, out);
  }
  return out;
}

function referencedAssetPaths(app) {
  /** @type {string[]} */
  const paths = [];
  if (typeof app.icon === 'string') paths.push(app.icon);
  if (app.splash && typeof app.splash.image === 'string') paths.push(app.splash.image);
  if (app.android?.adaptiveIcon?.foregroundImage) {
    paths.push(app.android.adaptiveIcon.foregroundImage);
  }
  for (const plugin of app.plugins ?? []) {
    if (!Array.isArray(plugin) || plugin.length < 2) continue;
    const [name, opts] = plugin;
    if (name === 'expo-notifications' && opts && typeof opts.icon === 'string') {
      paths.push(opts.icon);
    }
  }
  return [...new Set(paths)];
}

function main() {
  if (!existsSync(appJsonPath)) {
    fail(`Missing ${appJsonPath}`);
    return finish();
  }
  if (!existsSync(easJsonPath)) {
    fail(`Missing ${easJsonPath}`);
    return finish();
  }

  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
  const easJson = JSON.parse(readFileSync(easJsonPath, 'utf8'));
  const app = appJson.expo;
  if (!app) {
    fail('app.json missing expo root');
    return finish();
  }

  for (const rel of referencedAssetPaths(app)) {
    const abs = resolve(mobileRoot, rel);
    if (!existsSync(abs)) {
      fail(`Referenced asset missing: ${rel}`);
    }
  }

  const permissionish = collectStringLeaves({
    plugins: app.plugins,
    infoPlist: app.ios?.infoPlist,
  });
  for (const s of permissionish) {
    if (/ServiceOS/i.test(s)) {
      fail(`Permission/config string still mentions ServiceOS: ${JSON.stringify(s)}`);
    }
  }

  const projectId = app.extra?.eas?.projectId;
  if (projectId === '' || projectId == null) {
    warn(
      'extra.eas.projectId is empty — run `npx eas-cli init` before production push builds (placeholder is intentional in repo).',
    );
  }

  const easText = JSON.stringify(easJson);
  const replaceMatches = easText.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? [];
  if (replaceMatches.length > 0) {
    warn(
      `eas.json still has submit placeholders: ${[...new Set(replaceMatches)].join(', ')}`,
    );
  }

  finish();
}

function finish() {
  for (const w of warnings) {
    console.warn(`WARN: ${w}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`ERROR: ${e}`);
    }
    console.error(`validate-mobile-config: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(
    `validate-mobile-config: OK (${warnings.length} warning(s); placeholders/empty projectId warn-only)`,
  );
  process.exit(0);
}

main();
