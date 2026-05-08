import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { redactHeaders, redactUnknown, scanForSecrets, fingerprint } from './redaction.mjs';

const execAsync = promisify(exec);

export function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function templateString(value) {
  const timestamp = Date.now();
  const rand4 = Math.floor(1000 + Math.random() * 9000);
  return String(value)
    .replaceAll('{{timestamp}}', String(timestamp))
    .replaceAll('{{rand4}}', String(rand4))
    .replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => process.env[name] ?? `{{${name}}}`);
}

function templateObject(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return templateString(value);
  if (Array.isArray(value)) return value.map(templateObject);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templateObject(v)]));
  }
  return value;
}

export function missingEnvVars(required = []) {
  return required.filter((name) => !process.env[name]);
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function runApiCheck({ apiUrl, testId, check, artifactDir }) {
  const url = templateString(`${apiUrl}${check.endpoint}`);
  const method = check.method || 'GET';
  const headers = { ...templateObject(check.headers || {}) };
  // Inject global auth unless the check opts out (no_auth: true) or supplies its own Authorization.
  if (!check.no_auth && !headers.Authorization && process.env.AUTH_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.AUTH_BEARER_TOKEN}`;
  }

  const requestBody = check.body ? templateObject(check.body) : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    });
    const text = await res.text();
    const artifactPath = path.join(artifactDir, `${testId}-${ts()}.json`);
    await writeJson(artifactPath, {
      url,
      method,
      headers: redactHeaders(headers),
      requestBody: redactUnknown(requestBody),
      status: res.status,
      body: redactUnknown(text),
    });

    const findings = scanForSecrets({ url, method, headers: redactHeaders(headers), requestBody: redactUnknown(requestBody), body: redactUnknown(text) });
    console.log('[qa-runner:redaction]', { hasHeaders: Object.keys(headers).length > 0, hasRequestBody: requestBody !== undefined, hasResponseBody: text.length > 0, fp: fingerprint({ url, method, status: res.status }), findings: findings.length });
    if (findings.length) throw new Error(`Non-redacted secrets detected in API artifact: ${findings.map((f) => f.name).join(', ')}`);

    const expected = check.expect_statuses || (check.expect_status ? [check.expect_status] : [200]);

    return {
      status: expected.includes(res.status) ? 'pass' : 'fail',
      status_code: res.status,
      response_excerpt: text.slice(0, 1200),
      evidence_path: artifactPath,
      entity_ids: {},
    };
  } catch (error) {
    const artifactPath = path.join(artifactDir, `${testId}-${ts()}-error.json`);
    await writeJson(artifactPath, { url, method, headers: redactHeaders(headers), requestBody: redactUnknown(requestBody), error: redactUnknown(String(error)) });
    return {
      status: 'blocked',
      status_code: null,
      response_excerpt: String(error),
      evidence_path: artifactPath,
      entity_ids: {},
    };
  }
}

async function runUiWithPlaywright({ url, artifactPath }) {
  const module = await import('playwright');
  const browser = await module.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: artifactPath, fullPage: true });
  const html = await page.content();
  await browser.close();
  return html;
}

export async function runUiCheck({ baseUrl, testId, check, artifactDir }) {
  const url = `${baseUrl}${check.path}`;
  try {
    const pngPath = path.join(artifactDir, `${testId}-${ts()}.png`);
    let html;

    try {
      html = await runUiWithPlaywright({ url, artifactPath: pngPath });
    } catch {
      const res = await fetch(url, { method: 'GET' });
      html = await res.text();
      const fallbackPath = path.join(artifactDir, `${testId}-${ts()}.html`);
      await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
      await fs.writeFile(fallbackPath, html);
      const hasTextFallback = check.expect_text
        ? html.toLowerCase().includes(String(check.expect_text).toLowerCase())
        : true;

      return {
        status: res.ok && hasTextFallback ? 'pass' : 'fail',
        url,
        evidence_path: fallbackPath,
        entity_ids: {},
        notes: 'Playwright unavailable; captured HTML fallback',
      };
    }

    const hasText = check.expect_text
      ? html.toLowerCase().includes(String(check.expect_text).toLowerCase())
      : true;

    return {
      status: hasText ? 'pass' : 'fail',
      url,
      evidence_path: pngPath,
      entity_ids: {},
    };
  } catch (error) {
    const artifactPath = path.join(artifactDir, `${testId}-${ts()}-error.txt`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, String(error));
    return {
      status: 'blocked',
      url,
      evidence_path: artifactPath,
      entity_ids: {},
      notes: String(error),
    };
  }
}

export async function runDbCheck({ testId, check, artifactDir }) {
  const cmd = process.env.DB_CHECK_COMMAND;
  if (!cmd) {
    return {
      status: check.required ? 'fail' : 'blocked',
      evidence_path: null,
      notes: 'DB_CHECK_COMMAND not set',
    };
  }

  const finalCmd = `${cmd} "${check.query.replace(/"/g, '\\"')}"`;
  try {
    const { stdout, stderr } = await execAsync(finalCmd);
    const artifactPath = path.join(artifactDir, `${testId}-${ts()}.txt`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, `CMD: ${finalCmd}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n`);
    return {
      status: 'pass',
      evidence_path: artifactPath,
      notes: '',
    };
  } catch (error) {
    const artifactPath = path.join(artifactDir, `${testId}-${ts()}-error.txt`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, String(error));
    return {
      status: check.required ? 'fail' : 'blocked',
      evidence_path: artifactPath,
      notes: 'DB command failed',
    };
  }
}
