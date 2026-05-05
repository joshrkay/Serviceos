import type { APIRequestContext, APIResponse } from '@playwright/test';
import { basename } from 'node:path';
import { RowEvidence, writeJsonArtifact } from './evidence';
import { redactHeaders, redactUnknown, scanForSecrets, fingerprint } from './redaction';

export interface ApiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  label: string;
  expectStatus?: number | number[];
}

export interface CapturedCall {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    ok: boolean;
    body: unknown;
    durationMs: number;
    timestamp: string;
  };
  artifactPath: string;
}

export class ApiVerifier {
  constructor(
    private readonly ctx: APIRequestContext,
    private readonly apiBase: string,
    private readonly evidence: RowEvidence
  ) {}

  async call(opts: ApiCallOptions): Promise<CapturedCall> {
    const url = this.apiBase.replace(/\/$/, '') + opts.path;
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const started = Date.now();
    let res: APIResponse;
    try {
      res = await this.ctx.fetch(url, {
        method: opts.method,
        headers,
        data: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      const capture: CapturedCall = {
        request: { method: opts.method, url, headers: redactHeaders(headers), body: redactUnknown(opts.body) },
        response: {
          status: 0,
          ok: false,
          body: redactUnknown({ networkError: (err as Error).message }),
          durationMs: Date.now() - started,
          timestamp: new Date().toISOString(),
        },
        artifactPath: '',
      };
      const findings = scanForSecrets(capture);
    console.log('[qa-matrix:redaction]', { hasHeaders: !!capture.request.headers, hasRequestBody: capture.request.body !== undefined, hasResponseBody: capture.response.body !== undefined, fp: fingerprint(capture), findings: findings.length });
    if (findings.length) throw new Error(`${opts.label}: non-redacted secrets detected (${findings.map((f) => f.name).join(', ')})`);
    capture.artifactPath = writeJsonArtifact(this.evidence.apiDir(), opts.label, capture);
      this.evidence.addArtifact({
        kind: 'api',
        path: capture.artifactPath,
        label: `API ${opts.method} ${opts.path} → network error`,
      });
      throw err;
    }

    const status = res.status();
    const textBody = await res.text();
    let parsedBody: unknown = textBody;
    try {
      parsedBody = textBody ? JSON.parse(textBody) : null;
    } catch {
      // keep as text
    }

    const capture: CapturedCall = {
      request: { method: opts.method, url, headers: redactHeaders(headers), body: redactUnknown(opts.body) },
      response: {
        status,
        ok: res.ok(),
        body: redactUnknown(parsedBody),
        durationMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      },
      artifactPath: '',
    };
    const findings = scanForSecrets(capture);
    console.log('[qa-matrix:redaction]', { hasHeaders: !!capture.request.headers, hasRequestBody: capture.request.body !== undefined, hasResponseBody: capture.response.body !== undefined, fp: fingerprint(capture), findings: findings.length });
    if (findings.length) throw new Error(`${opts.label}: non-redacted secrets detected (${findings.map((f) => f.name).join(', ')})`);
    capture.artifactPath = writeJsonArtifact(this.evidence.apiDir(), opts.label, capture);
    this.evidence.addArtifact({
      kind: 'api',
      path: capture.artifactPath,
      label: `API ${opts.method} ${opts.path} → ${status}`,
    });

    if (opts.expectStatus !== undefined) {
      const allowed = Array.isArray(opts.expectStatus) ? opts.expectStatus : [opts.expectStatus];
      if (!allowed.includes(status)) {
        throw new Error(
          `${opts.label}: expected status in [${allowed.join(', ')}], got ${status}. Body: ${basename(
            capture.artifactPath
          )}`
        );
      }
    }
    return capture;
  }
}
