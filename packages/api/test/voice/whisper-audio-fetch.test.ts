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

describe('H2 review M1 — the minting process and the fetching worker may not share every env var', () => {
  it('a worker that also has STORAGE_PUBLIC_URL still fetches an endpoint presign minted where it is unset', async () => {
    const web = prodStorage();
    const worker = prodStorage({ STORAGE_PUBLIC_URL: 'https://media.example-cdn.test/voice/' });

    expect(await fetchesMinted(web, worker.downloadUrlPolicy)).toEqual({
      outcome: 'fetched',
      fetched: true,
    });
  });
});

async function fetchesMinted(
  storage: ReturnType<typeof createStorageProvider>,
  policy = storage.downloadUrlPolicy,
) {
  const minted = await storage.provider.generateDownloadUrl(storage.bucket, 'tenant-1/file-1/memo.m4a');
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(audioOk())
    .mockResolvedValueOnce(jsonRes({ text: 'ok' }));
  vi.stubGlobal('fetch', fetchImpl);
  const provider = new WhisperTranscriptionProvider({
    apiKey: 'sk_test',
    fetchImpl,
    audioUrlPolicy: policy,
    logger: { warn: vi.fn() },
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
  ])('refuses %s even though that storage minted it', async (_label, env) => {
    expect(await fetchesMinted(createStorageProvider(env))).toEqual({
      outcome: 'AudioUrlRejectedError',
      fetched: false,
    });
  });

  // H2 review M1 — an operator-configured storage origin is never refused
  // (that would silently fail every transcription); boot warns instead.
  it.each([
    ['an http storage endpoint in prod', s3('http://bucket.railway.internal:9000', 'prod')],
    ['an IP-literal storage endpoint in production', s3('https://10.0.0.5', 'production')],
    ['a non-default-port storage endpoint in staging', s3('https://storage.example.test:8443', 'staging')],
    [
      'a non-default-port STORAGE_PUBLIC_URL in production',
      { ...s3('https://acct123.r2.cloudflarestorage.com', 'production'), STORAGE_PUBLIC_URL: 'https://cdn.example.com:8443/media' },
    ],
  ])('fetches its own minted URL from %s', async (_label, env) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await fetchesMinted(createStorageProvider(env))).toEqual({
      outcome: 'fetched',
      fetched: true,
    });
  });

  it.each([
    'http://bucket.railway.internal:9001/b/x.m4a',
    'http://api.railway.internal:8080/health',
    'http://10.0.0.5:9000/b/x.m4a',
    'https://bucket.railway.internal:9000/b/x.m4a',
  ])('still refuses the non-configured origin %s next to an http endpoint in prod', async (url) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { downloadUrlPolicy } = createStorageProvider(s3('http://bucket.railway.internal:9000', 'prod'));
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new WhisperTranscriptionProvider({
      apiKey: 'sk_test',
      fetchImpl,
      audioUrlPolicy: downloadUrlPolicy,
      logger: { warn: vi.fn() },
    });

    await expect(provider.transcribe(url)).rejects.toMatchObject({ name: 'AudioUrlRejectedError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const MINTED_KEY = 'tenant-1/file-1/memo.m4a';

async function prodProvider(opts: { fetchImpl: typeof fetch; timeoutMs?: number; maxBytes?: number }) {
  const storage = prodStorage();
  const url = await storage.provider.generateDownloadUrl(storage.bucket, MINTED_KEY);
  vi.stubGlobal('fetch', opts.fetchImpl);
  const provider = new WhisperTranscriptionProvider({
    apiKey: 'sk_test',
    audioUrlPolicy: storage.downloadUrlPolicy,
    ...opts,
  });
  return { provider, url };
}

/** Settles with the rejection, 'resolved', or 'still pending' after `ms`. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<unknown> {
  return Promise.race([
    p.then(() => 'resolved', (e: unknown) => e),
    new Promise((r) => setTimeout(() => r('still pending'), ms)),
  ]);
}

describe('H2 — the audio GET is bounded in time', () => {
  it('aborts a storage GET that never answers and fails retriably', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    const { provider, url } = await prodProvider({ fetchImpl, timeoutMs: 30 });

    const outcome = await settleWithin(provider.transcribe(url), 1_000);

    expect(outcome).toMatchObject({ name: 'WhisperTimeoutError', retriable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/** An audio body that counts how much of it was ever pulled, and whether it was cancelled. */
function countingAudioBody(chunkBytes: number, chunks: number, headers: Record<string, string> = {}) {
  const meter = { pulledBytes: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent += 1;
        meter.pulledBytes += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        meter.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'audio/mp4', ...headers },
  });
  return { response, meter };
}

describe('H2 — the audio GET is bounded in bytes', () => {
  it('refuses a declared content-length over the cap without reading the body', async () => {
    const { response, meter } = countingAudioBody(512, 4, { 'content-length': '2048' });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const { provider, url } = await prodProvider({ fetchImpl, maxBytes: 1024 });

    const outcome = await settleWithin(provider.transcribe(url), 1_000);

    expect(outcome).toMatchObject({ name: 'WhisperFileTooLargeError', retriable: false });
    expect(meter.pulledBytes).toBe(0);
    expect(meter.cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops reading an undeclared-length body as soon as it passes the cap', async () => {
    // 100 x 512 B = 50 KiB on offer against a 1 KiB cap: the provider must
    // give up after the chunk that crosses the cap, not buffer the rest.
    const { response, meter } = countingAudioBody(512, 100);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const { provider, url } = await prodProvider({ fetchImpl, maxBytes: 1024 });

    const outcome = await settleWithin(provider.transcribe(url), 1_000);

    expect(outcome).toMatchObject({ name: 'WhisperFileTooLargeError', retriable: false });
    expect(meter.pulledBytes).toBeLessThanOrEqual(1024 + 512);
    expect(meter.cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still uploads a body exactly at the cap, typed by its Content-Type', async () => {
    const { response } = countingAudioBody(512, 2);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(jsonRes({ text: 'at the cap' }));
    const { provider, url } = await prodProvider({ fetchImpl, maxBytes: 1024 });

    const result = await provider.transcribe(url);

    expect(result.transcript).toBe('at the cap');
    const upload = (fetchImpl.mock.calls[1][1] as RequestInit).body as FormData;
    const file = upload.get('file') as File;
    expect(file.size).toBe(1024);
    expect(file.name).toBe('audio.m4a');
  });
});

describe('H2 review — a failed storage GET is retriable only when storage says so', () => {
  it.each([
    [503, true],
    [500, true],
    [429, true],
    [403, false],
    [404, false],
  ])('storage answering %i fails with retriable=%s', async (status, retriable) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x', { status }));
    const { provider, url } = await prodProvider({ fetchImpl });

    const err = (await provider.transcribe(url).catch((e: unknown) => e)) as Error & {
      retriable?: boolean;
    };

    expect(err).toBeInstanceOf(Error);
    expect(err.retriable).toBe(retriable);
    expect(err.message).toContain(String(status));
    expect(err.message).not.toContain(url);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

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
    expect(logged).toContain('origin');
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
