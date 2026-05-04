/**
 * VQ-025 — PR comment integration tests.
 *
 * Pins the contract for `.github/scripts/post-voice-quality-pr-comment.ts`:
 *
 *   - extracts the PR number from `GITHUB_REF` (`refs/pull/<n>/merge`)
 *   - reads the report JSON from `REPORT_PATH`
 *   - generates a sticky-comment body containing the marker
 *   - handles a missing report file gracefully (logs a warning, exits 0,
 *     posts a fallback message)
 *   - exits 0 without posting on non-PR runs (e.g., push to main)
 *
 * The script's network surface (GitHub REST API) is mocked via a fake
 * fetch implementation so tests stay hermetic. We intentionally test the
 * helper functions exposed by the script rather than spawning a child
 * `ts-node` process — direct import keeps the tests fast and deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  STICKY_MARKER,
  extractPrNumber,
  buildCommentBody,
  loadReport,
  postOrUpdateComment,
  run,
} from '../../../../.github/scripts/post-voice-quality-pr-comment';

describe('VQ-025 — PR comment integration', () => {
  it('VQ-025 — extracts PR number from GITHUB_REF', () => {
    expect(extractPrNumber('refs/pull/265/merge')).toBe(265);
    expect(extractPrNumber('refs/pull/1/head')).toBe(1);
    expect(extractPrNumber('refs/heads/main')).toBeNull();
    expect(extractPrNumber(undefined)).toBeNull();
    expect(extractPrNumber('')).toBeNull();
  });

  it('VQ-025 — reads the report JSON from REPORT_PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-025-'));
    const reportPath = path.join(tmp, 'voice-quality-report.json');
    const sample = {
      rubricVersion: 'v1',
      generatedAt: '2026-05-04T00:00:00.000Z',
      totalScripts: 2,
      totalPassed: 2,
      overallPassRate: 1,
      overallThreshold: 0.9,
      meetsOverallThreshold: true,
      perBucket: [],
      perScript: [],
      costSummary: { totalCents: 0, perBucketAverageCents: {} },
      latencySummary: { p50Ms: 0, p95Ms: 0, perBucketP95Ms: {} },
      launchGate: { pass: true, blockers: [] },
    };
    fs.writeFileSync(reportPath, JSON.stringify(sample), 'utf-8');

    const loaded = loadReport(reportPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.rubricVersion).toBe('v1');
    expect(loaded!.totalScripts).toBe(2);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('VQ-025 — loadReport returns null when the file is missing', () => {
    const missing = path.join(os.tmpdir(), 'definitely-missing-vq-report.json');
    expect(loadReport(missing)).toBeNull();
  });

  it('VQ-025 — loadReport returns null when JSON has wrong shape (e.g. vitest reporter output)', () => {
    // The CI workflow currently shares the report path with vitest's JSON
    // reporter, which writes a different schema. Guard structurally so the
    // post-comment script falls back to the no-report message instead of
    // crashing in formatReportMarkdown.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-025-bad-'));
    const reportPath = path.join(tmp, 'voice-quality-report.json');
    const vitestShape = {
      numTotalTests: 10,
      numPassedTests: 10,
      testResults: [{ name: 'corpus.test.ts', status: 'passed' }],
    };
    fs.writeFileSync(reportPath, JSON.stringify(vitestShape), 'utf-8');
    expect(loadReport(reportPath)).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('VQ-025 — generates a sticky-comment body containing the marker', () => {
    const sample = {
      rubricVersion: 'v1',
      generatedAt: '2026-05-04T00:00:00.000Z',
      totalScripts: 1,
      totalPassed: 1,
      overallPassRate: 1,
      overallThreshold: 0.9,
      meetsOverallThreshold: true,
      perBucket: [],
      perScript: [],
      costSummary: { totalCents: 0, perBucketAverageCents: {} },
      latencySummary: { p50Ms: 0, p95Ms: 0, perBucketP95Ms: {} },
      launchGate: { pass: true, blockers: [] },
    };
    const body = buildCommentBody(sample);
    expect(body.startsWith(STICKY_MARKER)).toBe(true);
    expect(body).toContain('Voice Quality Report');
    expect(STICKY_MARKER).toBe('<!-- voice-quality-report -->');
  });

  it('VQ-025 — buildCommentBody handles a missing report with a fallback message', () => {
    const body = buildCommentBody(null);
    expect(body.startsWith(STICKY_MARKER)).toBe(true);
    expect(body).toContain('did not produce a report');
  });

  it('VQ-025 — posts a new comment when none with the marker exists', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if ((init?.method ?? 'GET') === 'GET') {
        // No existing sticky comment.
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 999 }), { status: 201 });
    });

    await postOrUpdateComment({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      owner: 'foo',
      repo: 'bar',
      prNumber: 7,
      token: 'tok',
      body: `${STICKY_MARKER}\nhello`,
    });

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/repos/foo/bar/issues/7/comments');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/repos/foo/bar/issues/7/comments');
  });

  it('VQ-025 — updates an existing comment when one with the marker is found', async () => {
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const existing = [
          { id: 42, body: 'unrelated comment' },
          { id: 100, body: `${STICKY_MARKER}\nold report` },
        ];
        return new Response(JSON.stringify(existing), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 100 }), { status: 200 });
    });

    await postOrUpdateComment({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      owner: 'foo',
      repo: 'bar',
      prNumber: 9,
      token: 'tok',
      body: `${STICKY_MARKER}\nfresh report`,
    });

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    const lastCallArgs = fakeFetch.mock.calls[1];
    const lastUrl = lastCallArgs[0] as string;
    const lastInit = lastCallArgs[1] as RequestInit;
    expect(lastInit.method).toBe('PATCH');
    expect(lastUrl).toContain('/repos/foo/bar/issues/comments/100');
  });

  describe('VQ-025 — run() entry point', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let tmp: string;

    beforeEach(() => {
      originalEnv = { ...process.env };
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-025-run-'));
    });

    afterEach(() => {
      process.env = originalEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('VQ-025 — handles non-PR runs by exiting 0 without posting', async () => {
      const fakeFetch = vi.fn();
      const exitCode = await run({
        fetchImpl: fakeFetch as unknown as typeof fetch,
        env: {
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'foo/bar',
          GITHUB_TOKEN: 'tok',
          REPORT_PATH: path.join(tmp, 'report.json'),
        },
      });
      expect(exitCode).toBe(0);
      expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('VQ-025 — handles missing report file gracefully (exits 0, posts fallback)', async () => {
      const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      });
      const exitCode = await run({
        fetchImpl: fakeFetch as unknown as typeof fetch,
        env: {
          GITHUB_REF: 'refs/pull/12/merge',
          GITHUB_REPOSITORY: 'foo/bar',
          GITHUB_TOKEN: 'tok',
          REPORT_PATH: path.join(tmp, 'definitely-missing.json'),
        },
      });
      expect(exitCode).toBe(0);
      expect(fakeFetch).toHaveBeenCalled();
      const postCall = fakeFetch.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(
        (postCall![1] as RequestInit).body as string,
      ) as { body: string };
      expect(body.body).toContain('did not produce a report');
    });

    it('VQ-025 — exits 0 when no GITHUB_TOKEN is provided', async () => {
      const fakeFetch = vi.fn();
      const exitCode = await run({
        fetchImpl: fakeFetch as unknown as typeof fetch,
        env: {
          GITHUB_REF: 'refs/pull/1/merge',
          GITHUB_REPOSITORY: 'foo/bar',
          GITHUB_TOKEN: '',
          REPORT_PATH: path.join(tmp, 'report.json'),
        },
      });
      expect(exitCode).toBe(0);
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  });
});
