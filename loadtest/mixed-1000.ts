/**
 * Mixed 1000-concurrent-user load harness (U6 — scale-to-1000 plan).
 *
 * Dependency-free (Node built-ins + tsx only), matching loadtest/http-load.ts.
 * Where http-load.ts drives a raw request firehose, this harness simulates the
 * measured dashboard-user footprint — each virtual user is one browser tab:
 *
 *   - one authenticated GET /api/proposals?status=ready_for_review&limit=100
 *     every 30 s (the usePendingProposals poll);
 *   - one client-gateway WebSocket held open — same handshake as the web
 *     client (packages/web/src/hooks/useResilientStream.ts): plain upgrade on
 *     /api/ws with the bearer token in the `?token=` query param; the
 *     gateway's `hello` frame confirms auth + registry lease succeeded;
 *   - a configurable fraction (default 20%) are dispatch-board users: + one
 *     SSE stream on /api/dispatch/board/events?date=… and one
 *     PUT /api/dispatch/presence every 5 s. `--presence-interval 0` disables
 *     the PUTs to model the post-UC-3 topology where presence rides the WS;
 *   - a configurable fraction (default 10%) also hold an escalations SSE
 *     stream (/api/escalations/events).
 *
 * SSE auth matches the web clients (fetch + `Authorization: Bearer …`, not
 * EventSource). The WebSocket client is implemented raw over node:http
 * upgrade + RFC6455 framing so the harness stays dependency-free on Node 20
 * (no global WebSocket, no `ws` package).
 *
 * Optional voice slice: `--voice N` shells out to the existing voice harness
 * (packages/api/scripts/voice-load-test.ts) for N concurrent synthetic calls
 * rather than duplicating its logic. Requires `--voice-url` (or STAGING_WS_URL).
 *
 * Ramp/hold/report structure mirrors http-load.ts. The CLI exits non-zero
 * when the HTTP error rate is ≥ 1% or any connection class (WS, dispatch SSE,
 * escalations SSE) fails > 5% of attempts — disable with --no-assert.
 *
 * Usage (see loadtest/README.md for topology + token minting):
 *   tsx loadtest/mixed-1000.ts --url http://localhost:3000 --token <jwt> \
 *     --users 1000 --ramp 120 --hold 300 --rampdown 30 \
 *     --out loadtest/mixed-report.json
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { percentile, targetConcurrency, type Schedule } from './http-load';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface MixedOptions extends Schedule {
  /** Target API base URL (http/https). WS derives ws/wss from it. */
  url: string;
  token?: string;
  /** Fraction of users that are dispatch-board users (SSE + presence). */
  dispatchFraction: number;
  /** Fraction of users that also hold an escalations SSE stream. */
  escalationsFraction: number;
  /**
   * PUT /api/dispatch/presence interval in seconds. 0 disables the HTTP
   * presence writes — models the post-UC-3 topology (presence over WS).
   */
  presenceIntervalS: number;
  /** Proposals poll interval in seconds (usePendingProposals default: 30). */
  proposalIntervalS: number;
  /**
   * Client keepalive `{kind:'ping'}` interval — must stay under the
   * gateway's 90 s idle timeout (packages/api/src/ws/protocol.ts).
   */
  wsPingIntervalS: number;
  /** Dispatch-board date (YYYY-MM-DD), sent on the SSE query + presence body. */
  date: string;
  /** Per-request / per-connect timeout (ms). */
  timeoutMs: number;
  out?: string;
  /** When true (default), exit non-zero on threshold failure. */
  assert: boolean;
  /** Concurrent synthetic voice calls (0 = none). Delegates to voice-load-test.ts. */
  voice: number;
  /** Twilio media-stream WS URL for the voice slice (or env STAGING_WS_URL). */
  voiceUrl?: string;
}

const PROPOSALS_PATH = '/api/proposals?status=ready_for_review&limit=100';
const PRESENCE_PATH = '/api/dispatch/presence';
const ESCALATIONS_SSE_PATH = '/api/escalations/events';
const WS_PATH = '/api/ws';

// ─── Raw WebSocket framing (RFC 6455) ────────────────────────────────────────
// Shared with the self-check's stub server, which uses the same helpers for
// the server side of the handshake (mask=false).

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_OPCODE = {
  TEXT: 0x1,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** Sec-WebSocket-Accept value for a given Sec-WebSocket-Key. */
export function wsAcceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_MAGIC_GUID).digest('base64');
}

/** Encode a single unfragmented frame. Client→server frames must be masked. */
export function encodeWsFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i & 3];
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * Decode all complete frames in `buf`, invoking `onFrame` per frame, and
 * return the unconsumed remainder. Handles masked and unmasked frames;
 * fragmentation is not supported (the gateway sends single text frames).
 */
export function decodeWsFrames(
  buf: Buffer,
  onFrame: (opcode: number, payload: Buffer) => void,
): Buffer {
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hdr = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      hdr = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      hdr = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - off < hdr + maskLen + len) break;
    let payload = buf.subarray(off + hdr + maskLen, off + hdr + maskLen + len);
    if (masked) {
      const maskKey = buf.subarray(off + hdr, off + hdr + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    onFrame(opcode, payload);
    off += hdr + maskLen + len;
  }
  return buf.subarray(off);
}

// ─── Connection clients ──────────────────────────────────────────────────────

interface WsHandle {
  sendText(text: string): void;
  /** Graceful client-initiated close — suppresses onClose accounting. */
  close(): void;
  onClose: (() => void) | null;
}

interface OpenWsOpts {
  base: URL;
  token?: string;
  timeoutMs: number;
  /** Invoked for every server text frame, including the hello. */
  onText?: (text: string) => void;
}

/**
 * Open a client-gateway WebSocket the way the web client does
 * (`?token=` query param). Resolves once the gateway's `hello` frame
 * arrives — i.e. auth + registry lease succeeded — so "connected" means the
 * server actually constructed the connection, not just TCP/101.
 */
function openWs(opts: OpenWsOpts): Promise<WsHandle> {
  const { base } = opts;
  const isHttps = base.protocol === 'https:';
  const lib = isHttps ? https : http;
  const key = crypto.randomBytes(16).toString('base64');
  const search = opts.token ? `?token=${encodeURIComponent(opts.token)}` : '';
  return new Promise<WsHandle>((resolve, reject) => {
    let settled = false;
    const req = lib.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: `${WS_PATH}${search}`,
      method: 'GET',
      agent: false, // dedicated socket per connection — never pooled
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
      timeout: opts.timeoutMs,
    });
    const fail = (msg: string): void => {
      if (!settled) {
        settled = true;
        reject(new Error(msg));
      }
      req.destroy();
    };
    req.on('response', (res) => {
      res.resume();
      fail(`upgrade rejected: HTTP ${res.statusCode}`);
    });
    req.on('timeout', () => fail('ws connect timeout'));
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== wsAcceptKey(key)) {
        socket.destroy();
        fail('bad Sec-WebSocket-Accept');
        return;
      }
      socket.setTimeout(0); // long-lived — request timeout applied to connect only
      socket.setNoDelay(true);

      let buf: Buffer = Buffer.alloc(0);
      let closedByUs = false;
      const handle: WsHandle = {
        sendText: (text) => {
          if (!socket.destroyed) {
            socket.write(encodeWsFrame(WS_OPCODE.TEXT, Buffer.from(text), true));
          }
        },
        close: () => {
          closedByUs = true;
          if (!socket.destroyed) {
            try {
              socket.write(encodeWsFrame(WS_OPCODE.CLOSE, Buffer.alloc(0), true));
            } catch {
              /* socket already going away */
            }
            const t = setTimeout(() => socket.destroy(), 100);
            if (typeof t.unref === 'function') t.unref();
          }
        },
        onClose: null,
      };
      const helloTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error('no hello frame before timeout'));
        }
      }, opts.timeoutMs);

      const onData = (chunk: Buffer): void => {
        buf = decodeWsFrames(Buffer.concat([buf, chunk]), (opcode, payload) => {
          if (opcode === WS_OPCODE.PING) {
            if (!socket.destroyed) socket.write(encodeWsFrame(WS_OPCODE.PONG, payload, true));
            return;
          }
          if (opcode === WS_OPCODE.CLOSE) {
            socket.destroy();
            return;
          }
          if (opcode !== WS_OPCODE.TEXT) return;
          const text = payload.toString('utf8');
          opts.onText?.(text);
          if (!settled) {
            try {
              const j = JSON.parse(text) as { kind?: string };
              if (j?.kind === 'hello') {
                settled = true;
                clearTimeout(helloTimer);
                resolve(handle);
              }
            } catch {
              /* keep waiting for hello until timeout */
            }
          }
        });
      };
      socket.on('data', onData);
      // Frames coalesced into the same packet as the 101 response arrive via
      // the `head` buffer, not a 'data' event — the gateway's hello usually
      // lands here.
      if (head && head.length > 0) onData(head);
      socket.on('error', () => {
        /* 'close' follows and settles */
      });
      socket.once('close', () => {
        clearTimeout(helloTimer);
        if (!settled) {
          settled = true;
          reject(new Error('socket closed during handshake'));
          return;
        }
        if (!closedByUs) handle.onClose?.();
      });
    });
    req.end();
  });
}

interface SseHandle {
  close(): void;
  onClose: (() => void) | null;
}

interface OpenSseOpts {
  base: URL;
  pathWithQuery: string;
  token?: string;
  timeoutMs: number;
  /** Invoked once per `data:` event block. */
  onEvent?: () => void;
}

/**
 * Open an SSE stream the way the web hooks do — fetch-style GET with
 * `Authorization: Bearer …` + `Accept: text/event-stream` (the app does not
 * use EventSource; see useDispatchBoardStream / useEscalationStream).
 * Resolves once a 200 with headers arrives.
 */
function openSse(opts: OpenSseOpts): Promise<SseHandle> {
  const { base } = opts;
  const isHttps = base.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise<SseHandle>((resolve, reject) => {
    let settled = false;
    let closedByUs = false;
    const req = lib.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: opts.pathWithQuery,
      method: 'GET',
      agent: false, // held open for the whole run
      headers: {
        accept: 'text/event-stream',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      timeout: opts.timeoutMs,
    });
    const handle: SseHandle = {
      close: () => {
        closedByUs = true;
        req.destroy();
      },
      onClose: null,
    };
    req.on('timeout', () => {
      if (!settled) {
        settled = true;
        reject(new Error('sse connect timeout'));
      }
      req.destroy();
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        if (!settled) {
          settled = true;
          reject(new Error(`sse rejected: HTTP ${res.statusCode}`));
        }
        res.resume();
        req.destroy();
        return;
      }
      settled = true;
      res.socket?.setTimeout(0); // heartbeats are 25 s apart — no idle timeout
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.split('\n').some((l) => l.startsWith('data:'))) opts.onEvent?.();
        }
        if (buf.length > 1_000_000) buf = ''; // guard runaway partial blocks
      });
      res.once('close', () => {
        if (!closedByUs) handle.onClose?.();
      });
      resolve(handle);
    });
    req.end();
  });
}

interface HttpSample {
  durationMs: number;
  status: number;
  ok: boolean;
  error?: string;
}

function httpRequest(
  base: URL,
  opts: { method: 'GET' | 'PUT'; path: string; token?: string; timeoutMs: number; body?: string },
): Promise<HttpSample> {
  const isHttps = base.protocol === 'https:';
  const lib = isHttps ? https : http;
  const start = performance.now();
  return new Promise<HttpSample>((resolve) => {
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: opts.path,
        method: opts.method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        res.on('data', () => {}); // drain so the socket frees
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({
            durationMs: performance.now() - start,
            status,
            ok: status >= 200 && status < 300,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ durationMs: performance.now() - start, status: 0, ok: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ durationMs: performance.now() - start, status: 0, ok: false, error: err.message });
    });
    req.end(opts.body);
  });
}

// ─── Virtual users ───────────────────────────────────────────────────────────

/**
 * Deterministic proportional class assignment: user `idx` belongs to the
 * fraction when the running floor of (idx+1)*frac advances. Over n users this
 * yields exactly floor(n*frac) members, evenly interleaved — reproducible
 * across runs (mirrors http-load's counter-based endpoint mix).
 */
export function inFraction(idx: number, frac: number): boolean {
  return Math.floor((idx + 1) * frac) - Math.floor(idx * frac) >= 1;
}

interface ConnTracker {
  attempts: number;
  connected: number;
  failures: number;
  connectMs: number[];
  unexpectedCloses: number;
  messages: number;
}

function newTracker(): ConnTracker {
  return { attempts: 0, connected: 0, failures: 0, connectMs: [], unexpectedCloses: 0, messages: 0 };
}

interface UserCtx {
  o: MixedOptions;
  base: URL;
  addHttp: (endpoint: string, s: HttpSample) => void;
  ws: ConnTracker;
  dispatchSse: ConnTracker;
  escalationsSse: ConnTracker;
}

function startUser(idx: number, ctx: UserCtx): { stop: () => void } {
  const { o, base } = ctx;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  let ws: WsHandle | null = null;
  const sses: SseHandle[] = [];

  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };
  const every = (fn: () => void, ms: number): void => {
    const t = setInterval(() => {
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };

  // 1) usePendingProposals poll — immediately on mount, then every interval.
  const poll = (): void => {
    void httpRequest(base, {
      method: 'GET',
      path: PROPOSALS_PATH,
      token: o.token,
      timeoutMs: o.timeoutMs,
    }).then((s) => ctx.addHttp('GET /api/proposals', s));
  };
  poll();
  every(poll, o.proposalIntervalS * 1000);

  // 2) client-gateway WebSocket, held open; reconnect on unexpected close.
  const connectWs = (): void => {
    ctx.ws.attempts++;
    const t0 = performance.now();
    openWs({
      base,
      token: o.token,
      timeoutMs: o.timeoutMs,
      onText: () => {
        ctx.ws.messages++;
      },
    })
      .then((h) => {
        ctx.ws.connected++;
        ctx.ws.connectMs.push(performance.now() - t0);
        if (stopped) {
          h.close();
          return;
        }
        ws = h;
        h.onClose = () => {
          ws = null;
          if (stopped) return;
          ctx.ws.unexpectedCloses++;
          later(connectWs, 1000);
        };
      })
      .catch(() => {
        if (!stopped) {
          ctx.ws.failures++;
          later(connectWs, 2000);
        }
      });
  };
  connectWs();
  // Keepalive under the gateway's 90 s idle timeout; also exercises the
  // ping→heartbeat round-trip.
  every(() => ws?.sendText(JSON.stringify({ kind: 'ping' })), o.wsPingIntervalS * 1000);

  const holdSse = (tracker: ConnTracker, pathWithQuery: string): void => {
    const connect = (): void => {
      tracker.attempts++;
      const t0 = performance.now();
      openSse({
        base,
        pathWithQuery,
        token: o.token,
        timeoutMs: o.timeoutMs,
        onEvent: () => {
          tracker.messages++;
        },
      })
        .then((h) => {
          tracker.connected++;
          tracker.connectMs.push(performance.now() - t0);
          if (stopped) {
            h.close();
            return;
          }
          sses.push(h);
          h.onClose = () => {
            if (stopped) return;
            tracker.unexpectedCloses++;
            later(connect, 1000);
          };
        })
        .catch(() => {
          if (!stopped) {
            tracker.failures++;
            later(connect, 2000);
          }
        });
    };
    connect();
  };

  // 3) dispatch-board users: board SSE + presence heartbeat.
  if (inFraction(idx, o.dispatchFraction)) {
    holdSse(ctx.dispatchSse, `/api/dispatch/board/events?date=${encodeURIComponent(o.date)}`);
    if (o.presenceIntervalS > 0) {
      const presence = (): void => {
        void httpRequest(base, {
          method: 'PUT',
          path: PRESENCE_PATH,
          token: o.token,
          timeoutMs: o.timeoutMs,
          body: JSON.stringify({ date: o.date, mode: 'viewing' }),
        }).then((s) => ctx.addHttp('PUT /api/dispatch/presence', s));
      };
      presence();
      every(presence, o.presenceIntervalS * 1000);
    }
  }

  // 4) escalations SSE holders.
  if (inFraction(idx, o.escalationsFraction)) {
    holdSse(ctx.escalationsSse, ESCALATIONS_SSE_PATH);
  }

  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t); // clears intervals too
      timers.clear();
      ws?.close();
      ws = null;
      for (const h of sses) h.close();
      sses.length = 0;
    },
  };
}

// ─── Voice slice (delegates to the existing harness) ─────────────────────────

export interface VoiceSliceResult {
  requested: number;
  exitCode: number | null;
  reportPath: string;
}

/**
 * Spawn packages/api/scripts/voice-load-test.ts for N concurrent synthetic
 * calls, sharing the mixed run's ramp/hold. Reuses the existing harness —
 * its logic (mulaw generation, first-STT metrics, report) is not duplicated
 * here. Output is prefixed [voice]; its JSON report lands in packages/api/.
 */
function runVoiceSlice(o: MixedOptions, stagingWsUrl: string): Promise<VoiceSliceResult> {
  const apiDir = path.resolve(__dirname, '..', 'packages', 'api');
  const reportPath = path.join(apiDir, 'voice-load-report.json');
  return new Promise((resolve) => {
    let settled = false;
    const done = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ requested: o.voice, exitCode, reportPath });
    };
    const child = spawn(
      'npx',
      [
        'tsx',
        'scripts/voice-load-test.ts',
        '--max',
        String(o.voice),
        '--ramp',
        String(o.rampSeconds),
        '--hold',
        String(o.holdSeconds),
      ],
      {
        cwd: apiDir,
        env: { ...process.env, STAGING_WS_URL: stagingWsUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (d: Buffer) => process.stdout.write(`[voice] ${d}`));
    child.stderr.on('data', (d: Buffer) => process.stderr.write(`[voice] ${d}`));
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
}

// ─── Run + report ────────────────────────────────────────────────────────────

export interface ConnClassReport {
  attempts: number;
  connected: number;
  failures: number;
  successRate: number;
  failureRate: number;
  connectMs: { p50: number; p95: number; p99: number };
  unexpectedCloses: number;
  messages: number;
}

export interface MixedReport {
  url: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  config: {
    users: number;
    rampSeconds: number;
    holdSeconds: number;
    rampdownSeconds: number;
    dispatchFraction: number;
    escalationsFraction: number;
    presenceIntervalS: number;
    proposalIntervalS: number;
    date: string;
  };
  users: { total: number; dispatchBoard: number; escalations: number };
  http: {
    totalRequests: number;
    errors: number;
    errorRate: number;
    /** Requests completed during the hold window / holdSeconds. */
    steadyStateRps: number;
    overallRps: number;
    perEndpoint: Record<
      string,
      { count: number; errors: number; p50: number; p95: number; p99: number }
    >;
  };
  connections: {
    ws: ConnClassReport;
    dispatchSse: ConnClassReport;
    escalationsSse: ConnClassReport;
  };
  voice: VoiceSliceResult | null;
  thresholds: {
    httpErrorUnder1pct: boolean;
    wsFailureUnder5pct: boolean;
    dispatchSseFailureUnder5pct: boolean;
    escalationsSseFailureUnder5pct: boolean;
    voicePassed: boolean;
    passed: boolean;
  };
}

function connClassReport(t: ConnTracker): ConnClassReport {
  const d = [...t.connectMs].sort((a, b) => a - b);
  return {
    attempts: t.attempts,
    connected: t.connected,
    failures: t.failures,
    successRate: t.attempts ? Number((t.connected / t.attempts).toFixed(4)) : 1,
    failureRate: t.attempts ? Number((t.failures / t.attempts).toFixed(4)) : 0,
    connectMs: {
      p50: Math.round(percentile(d, 50)),
      p95: Math.round(percentile(d, 95)),
      p99: Math.round(percentile(d, 99)),
    },
    unexpectedCloses: t.unexpectedCloses,
    messages: t.messages,
  };
}

export async function runMixedLoad(o: MixedOptions): Promise<MixedReport> {
  const base = new URL(o.url);
  const totalSeconds = o.rampSeconds + o.holdSeconds + o.rampdownSeconds;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const elapsedS = (): number => (performance.now() - t0) / 1000;

  const httpSamples = new Map<string, Array<HttpSample & { atS: number }>>();
  const addHttp = (endpoint: string, s: HttpSample): void => {
    const arr = httpSamples.get(endpoint) ?? [];
    arr.push({ ...s, atS: elapsedS() });
    httpSamples.set(endpoint, arr);
  };

  const ws = newTracker();
  const dispatchSse = newTracker();
  const escalationsSse = newTracker();
  const ctx: UserCtx = { o, base, addHttp, ws, dispatchSse, escalationsSse };

  let voicePromise: Promise<VoiceSliceResult> | null = null;
  if (o.voice > 0) {
    const stagingWsUrl = o.voiceUrl ?? process.env.STAGING_WS_URL;
    if (!stagingWsUrl) {
      throw new Error(
        '--voice requires --voice-url (or STAGING_WS_URL) pointing at the Twilio media-stream WS endpoint',
      );
    }
    voicePromise = runVoiceSlice(o, stagingWsUrl);
  }

  const users: Array<{ stop: () => void }> = [];
  let spawned = 0;

  // Scheduler tick: every 250 ms reconcile active user count to the target.
  // Unlike http-load's fire-and-forget VUs, users hold connections, so the
  // ramp-down actively stops excess users (LIFO) to model departures.
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const t = elapsedS();
      if (t >= totalSeconds) {
        clearInterval(tick);
        for (const u of users) u.stop();
        users.length = 0;
        // Let in-flight requests and closes settle before reporting.
        setTimeout(resolve, Math.min(o.timeoutMs, 3000) + 200);
        return;
      }
      const want = Math.min(targetConcurrency(t, o), o.max);
      while (users.length < want) {
        users.push(startUser(spawned++, ctx));
      }
      while (users.length > want) {
        users.pop()!.stop();
      }
    }, 250);
  });

  const voice = voicePromise ? await voicePromise : null;
  const finishedAt = new Date().toISOString();
  const durationSeconds = elapsedS();

  const perEndpoint: MixedReport['http']['perEndpoint'] = {};
  let totalRequests = 0;
  let errors = 0;
  let holdCount = 0;
  const holdStart = o.rampSeconds;
  const holdEnd = o.rampSeconds + o.holdSeconds;
  for (const [name, arr] of httpSamples) {
    const d = arr.map((s) => s.durationMs).sort((a, b) => a - b);
    const errs = arr.filter((s) => !s.ok).length;
    perEndpoint[name] = {
      count: arr.length,
      errors: errs,
      p50: Math.round(percentile(d, 50)),
      p95: Math.round(percentile(d, 95)),
      p99: Math.round(percentile(d, 99)),
    };
    totalRequests += arr.length;
    errors += errs;
    holdCount += arr.filter((s) => s.atS >= holdStart && s.atS < holdEnd).length;
  }
  const errorRate = totalRequests ? errors / totalRequests : 0;

  const connections = {
    ws: connClassReport(ws),
    dispatchSse: connClassReport(dispatchSse),
    escalationsSse: connClassReport(escalationsSse),
  };
  const classOk = (r: ConnClassReport): boolean => r.attempts === 0 || r.failureRate <= 0.05;
  const thresholds = {
    httpErrorUnder1pct: errorRate < 0.01,
    wsFailureUnder5pct: classOk(connections.ws),
    dispatchSseFailureUnder5pct: classOk(connections.dispatchSse),
    escalationsSseFailureUnder5pct: classOk(connections.escalationsSse),
    voicePassed: voice === null || voice.exitCode === 0,
    passed: false,
  };
  thresholds.passed =
    thresholds.httpErrorUnder1pct &&
    thresholds.wsFailureUnder5pct &&
    thresholds.dispatchSseFailureUnder5pct &&
    thresholds.escalationsSseFailureUnder5pct &&
    thresholds.voicePassed;

  const report: MixedReport = {
    url: o.url,
    startedAt,
    finishedAt,
    durationSeconds: Math.round(durationSeconds),
    config: {
      users: o.max,
      rampSeconds: o.rampSeconds,
      holdSeconds: o.holdSeconds,
      rampdownSeconds: o.rampdownSeconds,
      dispatchFraction: o.dispatchFraction,
      escalationsFraction: o.escalationsFraction,
      presenceIntervalS: o.presenceIntervalS,
      proposalIntervalS: o.proposalIntervalS,
      date: o.date,
    },
    users: {
      total: spawned,
      dispatchBoard: Math.floor(spawned * o.dispatchFraction),
      escalations: Math.floor(spawned * o.escalationsFraction),
    },
    http: {
      totalRequests,
      errors,
      errorRate: Number(errorRate.toFixed(4)),
      steadyStateRps: o.holdSeconds > 0 ? Number((holdCount / o.holdSeconds).toFixed(2)) : 0,
      overallRps: durationSeconds ? Number((totalRequests / durationSeconds).toFixed(2)) : 0,
      perEndpoint,
    },
    connections,
    voice,
    thresholds,
  };

  if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2));
  return report;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseMixedArgs(argv: string[]): MixedOptions {
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const num = (flag: string, def: number): number => {
    const v = get(flag);
    return v === undefined ? def : Number(v);
  };
  return {
    url: get('--url', 'http://localhost:3000')!,
    token: get('--token'),
    max: num('--users', 1000),
    rampSeconds: num('--ramp', 120),
    holdSeconds: num('--hold', 300),
    rampdownSeconds: num('--rampdown', 30),
    dispatchFraction: num('--dispatch-frac', 0.2),
    escalationsFraction: num('--escalations-frac', 0.1),
    presenceIntervalS: num('--presence-interval', 5),
    proposalIntervalS: num('--proposal-interval', 30),
    wsPingIntervalS: 25,
    date: get('--date', new Date().toISOString().slice(0, 10))!,
    timeoutMs: num('--timeout', 10000),
    out: get('--out'),
    assert: !argv.includes('--no-assert'),
    voice: num('--voice', 0),
    voiceUrl: get('--voice-url'),
  };
}

export function printMixedSummary(r: MixedReport): void {
  const cls = (name: string, c: ConnClassReport): string =>
    `${name.padEnd(14)}${c.connected}/${c.attempts} connected (${(c.successRate * 100).toFixed(1)}%)  ` +
    `connect p50/p95/p99 ${c.connectMs.p50}/${c.connectMs.p95}/${c.connectMs.p99} ms  ` +
    `drops ${c.unexpectedCloses}  msgs ${c.messages}`;
  const eps = Object.entries(r.http.perEndpoint).map(
    ([name, e]) =>
      `  ${name.padEnd(30)}n=${String(e.count).padEnd(7)}p50 ${e.p50}  p95 ${e.p95}  p99 ${e.p99}  errors ${e.errors}`,
  );
  const lines = [
    `\n── mixed load report ────────────────────────────────────────`,
    `target        ${r.url}`,
    `schedule      ramp ${r.config.rampSeconds}s → hold ${r.config.holdSeconds}s @ ${r.config.users} users → down ${r.config.rampdownSeconds}s`,
    `users         ${r.users.total} total · ${r.users.dispatchBoard} dispatch-board · ${r.users.escalations} escalations` +
      (r.config.presenceIntervalS === 0 ? ' · presence PUTs disabled (WS-presence topology)' : ''),
    `http          ${r.http.totalRequests} requests · steady-state ${r.http.steadyStateRps} rps (overall ${r.http.overallRps}) · errors ${r.http.errors} (${(r.http.errorRate * 100).toFixed(2)}%)`,
    ...eps,
    cls('ws', r.connections.ws),
    cls('sse dispatch', r.connections.dispatchSse),
    cls('sse escalate', r.connections.escalationsSse),
    `voice         ${r.voice ? `${r.voice.requested} calls · exit ${r.voice.exitCode} · report ${r.voice.reportPath}` : '(none — use --voice N, or the two-terminal procedure in loadtest/README.md)'}`,
    `thresholds    http error<1%: ${r.thresholds.httpErrorUnder1pct ? 'PASS' : 'FAIL'} · ws fail≤5%: ${r.thresholds.wsFailureUnder5pct ? 'PASS' : 'FAIL'} · dispatch sse: ${r.thresholds.dispatchSseFailureUnder5pct ? 'PASS' : 'FAIL'} · escalations sse: ${r.thresholds.escalationsSseFailureUnder5pct ? 'PASS' : 'FAIL'}` +
      (r.voice ? ` · voice: ${r.thresholds.voicePassed ? 'PASS' : 'FAIL'}` : ''),
    `─────────────────────────────────────────────────────────────\n`,
  ];
  process.stdout.write(lines.join('\n'));
}

// Only run when invoked directly (not when imported by the self-check).
const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1] && /mixed-1000\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const opts = parseMixedArgs(process.argv.slice(2));
  runMixedLoad(opts)
    .then((report) => {
      printMixedSummary(report);
      if (opts.out) process.stdout.write(`report written to ${opts.out}\n`);
      if (opts.assert && !report.thresholds.passed) process.exit(1);
      // Held sockets may keep the loop alive briefly; report is final.
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`mixed load run failed: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
