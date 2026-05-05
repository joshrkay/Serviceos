#!/usr/bin/env node
const { execSync } = require('child_process');

const banned = [
  String.raw`logger\.(debug|info|warn|error)\([^\n]*req\.body`,
  String.raw`logger\.(debug|info|warn|error)\([^\n]*req\.headers\.(authorization|cookie)`,
  String.raw`logger\.(debug|info|warn|error)\([^\n]*['\"](authorization|cookie|token)['\"]\s*:`,
];

for (const pattern of banned) {
  const cmd = `rg -n --glob '*.ts' --glob '*.tsx' --glob '*.js' "${pattern}" src`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (out.trim()) {
      console.error(`\n[log-safety] Banned logging pattern found: ${pattern}`);
      console.error(out);
      process.exit(1);
    }
  } catch (err) {
    if (err.status === 1) continue;
    throw err;
  }
}

console.log('[log-safety] OK');
