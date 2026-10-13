/**
 * H2 (2026-10-13 security audit) — the Whisper provider's audio GET is the
 * fetch boundary for every `transcription` job (in-app create, retry,
 * voicemail, and any job already sitting in the queue from before the route
 * fix). It only fetches URLs this deployment's storage provider mints, bounds
 * the GET in time and bytes, and never echoes the URL into the error that the
 * worker stores as the recording's user-visible errorMessage.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageProvider } from '../../src/files/storage-provider';
import { WhisperTranscriptionProvider } from '../../src/voice/transcription-providers';

const R2_ENDPOINT = 'https://acct123.r2.cloudflarestorage.com';

function prodStorage(extra: Record<string, string> = {}) {
  return createStorageProvider({
    NODE_ENV: 'production',
    STORAGE_BUCKET: 'serviceos-prod',
    STORAGE_ENDPOINT: R2_ENDPOINT,
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    STORAGE_SECRET_ACCESS_KEY: 'secret-example',
    ...extra,
  });
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function audioOk(sizeBytes = 64, type = 'audio/mp4'): Response {
  return new Response(new Blob([new Uint8Array(sizeBytes)], { type }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('H2 — Whisper audio fetch only reaches the configured storage origin', () => {
  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['localhost', 'http://localhost:3000/storage-dev/x.m4a'],
    ['private IP', 'http://10.0.0.7:5432/'],
    ['private network host', 'http://api.railway.internal:8080/health'],
    ['plain http to the storage host', `http://acct123.r2.cloudflarestorage.com/serviceos-prod/a.m4a`],
    ['userinfo on the storage host', `https://user:pass@acct123.r2.cloudflarestorage.com/serviceos-prod/a.m4a`],
    ['a non-default port on the storage host', `https://acct123.r2.cloudflarestorage.com:8443/serviceos-prod/a.m4a`],
    ['an https IP literal', 'https://127.0.0.1/serviceos-prod/a.m4a'],
    ['an IPv6 literal', 'https://[::1]/serviceos-prod/a.m4a'],
    ['a decimal-encoded IP', 'https://2130706433/serviceos-prod/a.m4a'],
    ['a different https host', 'https://attacker.example/huge.bin'],
    ['a look-alike suffix host', 'https://acct123.r2.cloudflarestorage.com.attacker.example/a.m4a'],
    ['an unparseable URL', 'not a url'],
  ])('refuses %s without fetching it', async (_label, audioUrl) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonRes({ text: 'should not happen' }));
    // Belt and braces for the red phase: whatever fetch the provider ends up
    // using, it is this mock — never the real network.
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new WhisperTranscriptionProvider({
      apiKey: 'sk_test',
      fetchImpl,
      audioUrlPolicy: prodStorage().downloadUrlPolicy,
    });

    const err = await provider.transcribe(audioUrl).then(
      () => null,
      (e: unknown) => e as Error & { retriable?: boolean },
    );

    expect(err).toBeInstanceOf(Error);
    expect(err?.retriable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['a presigned GET on the storage endpoint', {}],
    ['a STORAGE_PUBLIC_URL download', { STORAGE_PUBLIC_URL: 'https://media.example-cdn.test/voice/' }],
  ])('fetches %s minted by the configured storage provider', async (_label, extraEnv) => {
    const storage = prodStorage(extraEnv);
    const minted = await storage.provider.generateDownloadUrl(
      storage.bucket,
      'tenant-1/file-1/memo.m4a',
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(audioOk())
      .mockResolvedValueOnce(jsonRes({ text: 'replace the capacitor' }));
    const provider = new WhisperTranscriptionProvider({
      apiKey: 'sk_test',
      fetchImpl,
      audioUrlPolicy: storage.downloadUrlPolicy,
    });

    const result = await provider.transcribe(minted);

    expect(result.transcript).toBe('replace the capacitor');
    expect(fetchImpl.mock.calls[0][0]).toBe(minted);
  });
});

async function fetchesMinted(storage: ReturnType<typeof createStorageProvider>) {
  const minted = await storage.provider.generateDownloadUrl(storage.bucket, 'tenant-1/file-1/memo.m4a');
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(audioOk())
    .mockResolvedValueOnce(jsonRes({ text: 'ok' }));
  vi.stubGlobal('fetch', fetchImpl);
  const provider = new WhisperTranscriptionProvider({
    apiKey: 'sk_test',
    fetchImpl,
    audioUrlPolicy: storage.downloadUrlPolicy,
  });
  const outcome = await provider.transcribe(minted).then(
    () => 'fetched' as const,
    (e: Error) => e.name,
  );
  return { outcome, fetched: fetchImpl.mock.calls.some((c) => c[0] === minted) };
}

describe('H2 — dev/local storage origins are fetchable outside production only', () => {
  it.each([
    ['DevStorageProvider on localhost', { NODE_ENV: 'test' }],
    ['DevStorageProvider in development on API_PORT', { NODE_ENV: 'development', API_PORT: '4321' }],
    [
      'a local MinIO over http with a port',
      {
        NODE_ENV: 'development',
        STORAGE_BUCKET: 'dev',
        STORAGE_ENDPOINT: 'http://localhost:9000',
        STORAGE_REGION: 'us-east-1',
        STORAGE_ACCESS_KEY_ID: 'minio',
        STORAGE_SECRET_ACCESS_KEY: 'minio123',
      },
    ],
  ])('fetches %s', async (_label, env) => {
    expect(await fetchesMinted(createStorageProvider(env))).toEqual({
      outcome: 'fetched',
      fetched: true,
    });
  });

  const s3 = (endpoint: string, nodeEnv: string) => ({
    NODE_ENV: nodeEnv,
    STORAGE_BUCKET: 'b',
    STORAGE_ENDPOINT: endpoint,
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'k',
    STORAGE_SECRET_ACCESS_KEY: 's',
  });

  it.each([
    // STORAGE_ENABLED=false keeps DevStorageProvider in a prod-like env, but
    // its /storage-dev receiver is never mounted there: nothing to fetch.
    ['DevStorageProvider in production', { NODE_ENV: 'production', STORAGE_ENABLED: 'false', PUBLIC_API_URL: 'https://api.example.test' }],
    ['DevStorageProvider in staging', { NODE_ENV: 'staging', STORAGE_ENABLED: 'false' }],
    ['an http storage endpoint in prod', s3('http://minio.internal:9000', 'prod')],
    ['an IP-literal storage endpoint in production', s3('https://10.0.0.5', 'production')],
    ['a non-default-port storage endpoint in staging', s3('https://storage.example.test:8443', 'staging')],
  ])('refuses %s even though that storage minted it', async (_label, env) => {
    expect(await fetchesMinted(createStorageProvider(env))).toEqual({
      outcome: 'AudioUrlRejectedError',
      fetched: false,
    });
  });
});

const MINTED_KEY = 'tenant-1/file-1/memo.m4a';

/** Settles with the rejection, 'resolved', or 'still pending' after `ms`. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<unknown> {
  return Promise.race([
    p.then(() => 'resolved', (e: unknown) => e),
    new Promise((r) => setTimeout(() => r('still pending'), ms)),
  ]);
}

describe('H2 — audio fetch diagnostics go to the log, minus the signature', () => {
  it('logs a failed storage GET at warn with the status and the URL without its query', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));
    const storage = prodStorage();
    const url = await storage.provider.generateDownloadUrl(storage.bucket, MINTED_KEY);
    const provider = new WhisperTranscriptionProvider({
      apiKey: 'sk_test',
      fetchImpl,
      audioUrlPolicy: storage.downloadUrlPolicy,
      logger: { warn },
    });

    await provider.transcribe(url).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('403');
    expect(logged).toContain(`https://acct123.r2.cloudflarestorage.com/serviceos-prod/${MINTED_KEY}`);
    expect(logged).not.toContain('X-Amz-Signature');
    expect(logged).not.toContain('X-Amz-Credential');
  });

  it('logs a refused URL at warn with the rule it broke', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new WhisperTranscriptionProvider({
      apiKey: 'sk_test',
      fetchImpl,
      audioUrlPolicy: prodStorage().downloadUrlPolicy,
      logger: { warn },
    });

    await provider.transcribe('http://169.254.169.254/latest/meta-data/?x=1').catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('scheme');
    expect(logged).toContain('http://169.254.169.254/latest/meta-data/');
    expect(logged).not.toContain('x=1');
  });
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

describe('H2 — the audio GET does not follow redirects', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('a storage-origin redirect to another host is not followed', async () => {
    let elsewhereHits = 0;
    const elsewhere = await listen((_req, res) => {
      elsewhereHits += 1;
      res.writeHead(200, { 'content-type': 'audio/mp4' }).end('stolen');
    });
    const storageHost = await listen((_req, res) => {
      res.writeHead(302, { location: `${elsewhere.origin}/internal` }).end();
    });
    servers.push(elsewhere.server, storageHost.server);
    // Dev storage outside production: the configured origin is a local host.
    const storage = createStorageProvider({
      NODE_ENV: 'test',
      STORAGE_PUBLIC_URL: `${storageHost.origin}/storage-dev`,
    });
    const url = await storage.provider.generateDownloadUrl(storage.bucket, MINTED_KEY);
    // Real fetch for the local servers only — never the real Whisper API.
    const fetchImpl = vi.fn<typeof fetch>((input, init) =>
      String(input).startsWith('http://127.0.0.1')
        ? fetch(input, init)
        : Promise.reject(new Error('test: off-box fetch blocked')),
    );
    const provider = new WhisperTranscriptionProvider({
      apiKey: 'sk_test',
      fetchImpl,
      audioUrlPolicy: storage.downloadUrlPolicy,
      logger: { warn: vi.fn() },
    });

    const outcome = await settleWithin(provider.transcribe(url), 2_000);

    expect(outcome).toBeInstanceOf(Error);
    expect(elsewhereHits).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
