import type { APIRequestContext, APIResponse } from '@playwright/test';
import { basename } from 'node:path';
import { RowEvidence, writeJsonArtifact } from './evidence';

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
        request: { method: opts.method, url, headers: redact(headers), body: opts.body },
        response: {
          status: 0,
          ok: false,
          body: { networkError: (err as Error).message },
          durationMs: Date.now() - started,
          timestamp: new Date().toISOString(),
        },
        artifactPath: '',
      };
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
      request: { method: opts.method, url, headers: redact(headers), body: opts.body },
      response: {
        status,
        ok: res.ok(),
        body: parsedBody,
        durationMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      },
      artifactPath: '',
    };
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

function redact(headers: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    copy[k] = k.toLowerCase() === 'authorization' ? 'Bearer <redacted>' : v;
  }
  return copy;
}
