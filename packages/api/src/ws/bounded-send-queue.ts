/**
 * Bounded outbound send queue with priority classes + drop policy.
 *
 * Used by both the Twilio Media Streams adapter and the new client WS
 * gateway. Frames are tagged with a priority; control/terminal frames
 * are never dropped, and lower-priority frames are coalesced or dropped
 * oldest-first when the queue is over watermark.
 *
 * The queue is push-based: callers `enqueue()`, the queue `drain()`s to
 * a sink (the WS `send` function). EWMA send latency + occupancy are
 * tracked so a slow-consumer detector can decide to disconnect.
 */
import {
  wsDropTotal,
  wsQueueDepthBytes,
  wsQueueDepthMsgs,
  wsSendLatencyMs,
} from '../monitoring/metrics';

export type Priority = 'terminal' | 'control' | 'delta' | 'telemetry';

const PRIORITY_RANK: Record<Priority, number> = {
  terminal: 0,
  control: 1,
  delta: 2,
  telemetry: 3,
};

export interface Frame {
  priority: Priority;
  data: string;
  /** Bytes — used for byte-cap accounting; defaults to data length. */
  bytes?: number;
  /** Optional coalesce key — adjacent same-key delta frames are merged by the
   *  caller-supplied `coalesce` function. */
  coalesceKey?: string;
}

export interface BoundedSendQueueOptions {
  surface: string;
  maxMsgs: number;
  maxBytes: number;
  /** Watermark above which the queue starts coalescing/dropping. 0–1. */
  highWatermark: number;
  /** Optional coalesce: combine two adjacent frames with the same key. */
  coalesce?: (a: Frame, b: Frame) => Frame;
  /** Hook fired when the queue accepts a frame. */
  onEnqueue?: (depthMsgs: number, depthBytes: number) => void;
  /** Hook fired when a frame is dropped. */
  onDrop?: (frame: Frame, reason: 'overflow' | 'coalesced') => void;
}

export interface BoundedSendQueueStats {
  depthMsgs: number;
  depthBytes: number;
  occupancyPct: number;
  ewmaSendLatencyMs: number;
  dropTotal: number;
  consecutiveOverWatermarkMs: number;
}

export class BoundedSendQueue {
  private readonly surface: string;
  private readonly maxMsgs: number;
  private readonly maxBytes: number;
  private readonly highWatermark: number;
  private readonly coalesce?: (a: Frame, b: Frame) => Frame;
  private readonly onEnqueue?: (m: number, b: Frame) => void;
  private readonly onDrop?: (frame: Frame, reason: 'overflow' | 'coalesced') => void;

  private queue: Frame[] = [];
  private bytes = 0;
  private dropTotal = 0;
  private ewmaSendLatencyMs = 0;
  private overWatermarkSinceMs = 0;

  constructor(opts: BoundedSendQueueOptions) {
    this.surface = opts.surface;
    this.maxMsgs = opts.maxMsgs;
    this.maxBytes = opts.maxBytes;
    this.highWatermark = opts.highWatermark;
    this.coalesce = opts.coalesce;
    this.onEnqueue = (m, f) => opts.onEnqueue?.(m, this.bytes) || undefined;
    this.onDrop = opts.onDrop;
  }

  /** Returns true if accepted, false if the frame was dropped. */
  enqueue(frame: Frame): boolean {
    const bytes = frame.bytes ?? Buffer.byteLength(frame.data, 'utf8');
    const sized: Frame = { ...frame, bytes };

    // Coalesce adjacent same-key delta frames at high watermark.
    if (this.coalesce && frame.coalesceKey && this.occupancyPct() >= this.highWatermark) {
      const last = this.queue[this.queue.length - 1];
      if (last && last.coalesceKey === frame.coalesceKey && last.priority === frame.priority) {
        const merged = this.coalesce(last, sized);
        const mergedBytes = merged.bytes ?? Buffer.byteLength(merged.data, 'utf8');
        this.bytes -= last.bytes ?? 0;
        this.queue[this.queue.length - 1] = { ...merged, bytes: mergedBytes };
        this.bytes += mergedBytes;
        wsDropTotal.inc({ surface: this.surface, reason: 'coalesced', priority: frame.priority });
        this.onDrop?.(sized, 'coalesced');
        this.updateGauges();
        return true;
      }
    }

    if (this.queue.length + 1 > this.maxMsgs || this.bytes + bytes > this.maxBytes) {
      // Try to evict lower-priority frames first (oldest of each tier).
      if (!this.evictForRoom(sized)) {
        // Even after eviction, no room — drop this frame unless it's terminal/control.
        if (sized.priority === 'terminal' || sized.priority === 'control') {
          // Force-evict the lowest-priority oldest frame.
          this.forceEvict();
          if (this.queue.length + 1 > this.maxMsgs || this.bytes + bytes > this.maxBytes) {
            // Still no room — accept anyway (terminal must deliver) and trust
            // the caller to disconnect on overflow.
          }
        } else {
          this.dropTotal++;
          wsDropTotal.inc({ surface: this.surface, reason: 'overflow', priority: sized.priority });
          this.onDrop?.(sized, 'overflow');
          this.updateGauges();
          return false;
        }
      }
    }

    this.queue.push(sized);
    this.bytes += bytes;
    this.onEnqueue?.(this.queue.length, sized);
    this.updateGauges();
    return true;
  }

  /** Drain to the sink. Stops at the first sink throw or when empty. */
  async drain(send: (frame: Frame) => void | Promise<void>): Promise<void> {
    while (this.queue.length > 0) {
      const f = this.queue.shift()!;
      this.bytes -= f.bytes ?? 0;
      const start = Date.now();
      try {
        await send(f);
      } catch {
        // Drop; outer caller decides whether to disconnect on send failure.
      }
      const elapsed = Date.now() - start;
      this.ewmaSendLatencyMs = this.ewmaSendLatencyMs === 0
        ? elapsed
        : 0.2 * elapsed + 0.8 * this.ewmaSendLatencyMs;
      wsSendLatencyMs.observe({ surface: this.surface }, elapsed);
    }
    this.updateGauges();
  }

  size(): number {
    return this.queue.length;
  }

  byteSize(): number {
    return this.bytes;
  }

  occupancyPct(): number {
    return Math.max(this.queue.length / this.maxMsgs, this.bytes / this.maxBytes);
  }

  stats(): BoundedSendQueueStats {
    const occ = this.occupancyPct();
    if (occ >= this.highWatermark) {
      if (this.overWatermarkSinceMs === 0) this.overWatermarkSinceMs = Date.now();
    } else {
      this.overWatermarkSinceMs = 0;
    }
    return {
      depthMsgs: this.queue.length,
      depthBytes: this.bytes,
      occupancyPct: occ,
      ewmaSendLatencyMs: this.ewmaSendLatencyMs,
      dropTotal: this.dropTotal,
      consecutiveOverWatermarkMs:
        this.overWatermarkSinceMs === 0 ? 0 : Date.now() - this.overWatermarkSinceMs,
    };
  }

  clear(): void {
    this.queue = [];
    this.bytes = 0;
    this.updateGauges();
  }

  private evictForRoom(incoming: Frame): boolean {
    // Drop the oldest frame strictly lower in priority than incoming.
    const idx = this.queue.findIndex(
      (q) => PRIORITY_RANK[q.priority] > PRIORITY_RANK[incoming.priority],
    );
    if (idx === -1) return false;
    const evicted = this.queue.splice(idx, 1)[0];
    this.bytes -= evicted.bytes ?? 0;
    this.dropTotal++;
    wsDropTotal.inc({ surface: this.surface, reason: 'overflow', priority: evicted.priority });
    this.onDrop?.(evicted, 'overflow');
    return true;
  }

  private forceEvict(): void {
    // Evict the lowest-priority oldest frame.
    let evictIdx = -1;
    let worst = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const r = PRIORITY_RANK[this.queue[i].priority];
      if (r > worst) {
        worst = r;
        evictIdx = i;
      }
    }
    if (evictIdx === -1) return;
    const evicted = this.queue.splice(evictIdx, 1)[0];
    this.bytes -= evicted.bytes ?? 0;
    this.dropTotal++;
    wsDropTotal.inc({ surface: this.surface, reason: 'overflow', priority: evicted.priority });
    this.onDrop?.(evicted, 'overflow');
  }

  private updateGauges(): void {
    wsQueueDepthMsgs.set({ surface: this.surface }, this.queue.length);
    wsQueueDepthBytes.set({ surface: this.surface }, this.bytes);
  }
}
