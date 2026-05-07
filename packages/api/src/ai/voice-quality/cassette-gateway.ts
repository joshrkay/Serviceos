/**
 * VQ-005 — CassetteLLMGateway: record + replay LLM exchanges per script.
 *
 * Subclasses the production `LLMGateway` and overrides `complete()` so the
 * voice-quality runner can drive the agent through the same interface used
 * in production while routing each LLM call through a versioned cassette
 * file (one per script).
 *
 * Modes (selected explicitly via constructor or env var
 * `VOICE_QUALITY_CASSETTE_MODE` — default `replay`):
 *   - `replay`: read cassette from disk, match request by hash, return the
 *     recorded response. Cache miss throws a clear error
 *     (`cassette stale, refresh needed for scriptId=X requestHash=Y`).
 *   - `record`: pass through to a real LLM gateway and append the response
 *     to the cassette. Idempotent: if an entry with the matching hash
 *     already exists, the write is skipped.
 *   - `refresh`: pass through and overwrite any existing entry with the
 *     same hash.
 *
 * # Cassette format
 * ```json
 * {
 *   "scriptId": "...",
 *   "version": 1,
 *   "rubricVersion": "v1",
 *   "entries": [
 *     {
 *       "requestHash": "sha256:...",
 *       "request": { "model": "...", "prompt": "...", "schema": "..." },
 *       "response": { ... },
 *       "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "costCents": 0 },
 *       "recordedAt": "2026-05-03T..."
 *     }
 *   ]
 * }
 * ```
 *
 * # Hashing
 * Request hash is `sha256` over a canonical JSON serialization of
 * `{ model, prompt, schema }` where:
 *   - `model` = `request.model ?? '(default)'`
 *   - `prompt` = the messages array, serialized canonically (object keys
 *     sorted)
 *   - `schema` = `request.responseFormat ?? 'text'`
 *
 * Object keys are sorted recursively (`canonicalize`) before serialization
 * so the same logical request produces the same hash regardless of
 * call-site key ordering.
 *
 * # Streaming
 * The production `LLMGateway` exposes only `complete()` (single-shot, not
 * a stream). If a future streaming method lands on `LLMGateway`, the
 * cassette format will need to materialize the stream as an array of
 * chunks; for now only `complete()` is implemented.
 *
 * # Locking
 * When writing (record / refresh), `acquireLock()` creates a per-cassette
 * `<scriptId>.lock` file using `fs.openSync(path, 'wx')`. If the lock
 * file already exists, we retry up to 3 times with 50ms backoff and then
 * throw. We do NOT block indefinitely. The runner's per-worker modulo
 * distribution (VQ-009) means each script is owned by exactly one worker
 * at a time, so contention is rare; this guard exists as a defense in
 * depth against a malformed runner config.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  LLMGateway,
  type LLMRequest,
  type LLMResponse,
} from '../gateway/gateway';

export type CassetteMode = 'replay' | 'record' | 'refresh';

export interface CassetteTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface CassetteEntry {
  requestHash: string;
  request: { model: string; prompt: string; schema: string };
  response: LLMResponse;
  tokenUsage: CassetteTokenUsage;
  recordedAt: string;
}

export interface CassetteFile {
  scriptId: string;
  version: number;
  rubricVersion: string;
  entries: CassetteEntry[];
}

export interface CassetteLLMGatewayOptions {
  scriptId: string;
  cassettesDir: string;
  mode: CassetteMode;
  /** Required when mode === 'record' or 'refresh'. */
  realGateway?: LLMGateway;
  /** Defaults to 'v1'. */
  rubricVersion?: string;
}

const CASSETTE_VERSION = 1;
const LOCK_RETRIES = 3;
const LOCK_BACKOFF_MS = 50;

/**
 * Returns the canonical default cassettes directory:
 * `<this-file>/corpus/cassettes`. Used by tests + the runner so we have a
 * single source of truth for "where cassettes live."
 */
export function defaultCassettesDir(): string {
  return path.resolve(__dirname, 'corpus', 'cassettes');
}

/**
 * Reads `VOICE_QUALITY_CASSETTE_MODE` from the environment, defaulting to
 * `replay`. Exposed for the runner so it doesn't duplicate this logic.
 */
export function cassetteModeFromEnv(): CassetteMode {
  const raw = process.env.VOICE_QUALITY_CASSETTE_MODE;
  if (raw === 'record' || raw === 'refresh' || raw === 'replay') {
    return raw;
  }
  return 'replay';
}

export class CassetteLLMGateway extends LLMGateway {
  private readonly scriptId: string;
  private readonly cassettesDir: string;
  private readonly mode: CassetteMode;
  private readonly realGateway?: LLMGateway;
  private readonly rubricVersion: string;

  constructor(opts: CassetteLLMGatewayOptions) {
    // We never call into the parent's provider machinery — `complete()` is
    // overridden — so we pass a minimal config.
    super(
      { defaultProvider: 'cassette' },
      new Map()
    );
    this.scriptId = opts.scriptId;
    this.cassettesDir = opts.cassettesDir;
    this.mode = opts.mode;
    this.realGateway = opts.realGateway;
    this.rubricVersion = opts.rubricVersion ?? 'v1';
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const hash = hashRequest(request);

    if (this.mode === 'replay') {
      return this.replay(request, hash);
    }

    if (!this.realGateway) {
      throw new Error(
        `CassetteLLMGateway: realGateway is required for mode='${this.mode}' (scriptId=${this.scriptId})`
      );
    }

    const overwrite = this.mode === 'refresh';
    return this.recordOrRefresh(request, hash, overwrite);
  }

  private async replay(
    request: LLMRequest,
    hash: string
  ): Promise<LLMResponse> {
    const cassette = this.loadCassetteOrEmpty();
    const entry = cassette.entries.find((e) => e.requestHash === hash);
    if (!entry) {
      throw new Error(
        `cassette stale, refresh needed for scriptId=${this.scriptId} requestHash=${hash} ` +
          `(re-run with VOICE_QUALITY_CASSETTE_MODE=record or refresh)`
      );
    }
    return entry.response;
  }

  private async recordOrRefresh(
    request: LLMRequest,
    hash: string,
    overwrite: boolean
  ): Promise<LLMResponse> {
    // Pass through first so we don't acquire the lock around a network call.
    const response = await this.realGateway!.complete(request);

    const lock = this.acquireLock();
    try {
      const cassette = this.loadCassetteOrEmpty();
      const existingIdx = cassette.entries.findIndex(
        (e) => e.requestHash === hash
      );

      if (existingIdx >= 0 && !overwrite) {
        // Idempotent record: entry already present, do not duplicate.
        return response;
      }

      const tokenUsage: CassetteTokenUsage = {
        inputTokens: response.tokenUsage?.input ?? 0,
        outputTokens: response.tokenUsage?.output ?? 0,
        costCents: 0,
      };

      const entry: CassetteEntry = {
        requestHash: hash,
        request: snapshotRequest(request),
        response,
        tokenUsage,
        recordedAt: new Date().toISOString(),
      };

      if (existingIdx >= 0) {
        cassette.entries[existingIdx] = entry;
      } else {
        cassette.entries.push(entry);
      }

      this.writeCassette(cassette);
      return response;
    } finally {
      lock.release();
    }
  }

  private cassettePath(): string {
    return path.join(this.cassettesDir, `${this.scriptId}.json`);
  }

  private lockPath(): string {
    return path.join(this.cassettesDir, `${this.scriptId}.lock`);
  }

  private loadCassetteOrEmpty(): CassetteFile {
    const file = this.cassettePath();
    if (!fs.existsSync(file)) {
      return {
        scriptId: this.scriptId,
        version: CASSETTE_VERSION,
        rubricVersion: this.rubricVersion,
        entries: [],
      };
    }
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as CassetteFile;
    return parsed;
  }

  private writeCassette(cassette: CassetteFile): void {
    fs.mkdirSync(this.cassettesDir, { recursive: true });
    fs.writeFileSync(
      this.cassettePath(),
      JSON.stringify(cassette, null, 2),
      'utf-8'
    );
  }

  /**
   * Best-effort per-cassette write lock. Uses `fs.openSync(path, 'wx')`
   * which atomically fails if the file already exists. Retries 3 times
   * with 50ms backoff before giving up. Non-blocking by design: parallel
   * vitest workers should never contend for the same script (one script
   * per worker via VQ-009's modulo distribution).
   */
  private acquireLock(): { release: () => void } {
    fs.mkdirSync(this.cassettesDir, { recursive: true });
    const lockFile = this.lockPath();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        return {
          release: () => {
            try {
              fs.closeSync(fd);
            } catch {
              // already closed
            }
            try {
              fs.unlinkSync(lockFile);
            } catch {
              // already gone
            }
          },
        };
      } catch (err) {
        lastErr = err;
        if (attempt < LOCK_RETRIES) {
          const start = Date.now();
          // Synchronous spin-wait — short (50ms) and only used in the
          // unlikely contention case. Async sleep would require making
          // acquireLock async, which complicates the call-site error
          // semantics; not worth it for the rare case.
          while (Date.now() - start < LOCK_BACKOFF_MS) {
            // spin
          }
        }
      }
    }
    throw new Error(
      `CassetteLLMGateway: could not acquire lock for scriptId=${this.scriptId} after ${LOCK_RETRIES + 1} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }
}

/**
 * Stable SHA-256 hash over the (model, prompt, schema) tuple. Object
 * keys are sorted recursively so reordering the input does not change
 * the hash.
 */
export function hashRequest(request: LLMRequest): string {
  const snapshot = snapshotRequest(request);
  const canonical = canonicalize(snapshot);
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return `sha256:${digest}`;
}

function snapshotRequest(
  request: LLMRequest
): { model: string; prompt: string; schema: string } {
  const model = request.model ?? '(default)';
  const messages = (request.messages ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const prompt = JSON.stringify(canonicalize(messages));
  const schema = request.responseFormat ?? 'text';
  return { model, prompt, schema };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
}
