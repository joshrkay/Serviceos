import { describe, it, expect } from 'vitest';
import { BoundedSendQueue } from '../../src/ws/bounded-send-queue';

describe('BoundedSendQueue', () => {
  it('drops lower-priority frames when over capacity', () => {
    const q = new BoundedSendQueue({
      surface: 'test',
      maxMsgs: 3,
      maxBytes: 1024,
      highWatermark: 0.7,
    });
    expect(q.enqueue({ priority: 'delta', data: 'a' })).toBe(true);
    expect(q.enqueue({ priority: 'delta', data: 'b' })).toBe(true);
    expect(q.enqueue({ priority: 'delta', data: 'c' })).toBe(true);
    // 4th delta — over capacity, no lower-priority to evict, dropped.
    expect(q.enqueue({ priority: 'delta', data: 'd' })).toBe(false);
    // Control gets through by evicting the oldest delta.
    expect(q.enqueue({ priority: 'control', data: 'CTRL' })).toBe(true);
    expect(q.size()).toBe(3);
  });

  it('coalesces adjacent same-key delta frames at high watermark', () => {
    const q = new BoundedSendQueue({
      surface: 'test',
      maxMsgs: 5,
      maxBytes: 1024,
      highWatermark: 0.5,
      coalesce: (a, b) => ({
        priority: a.priority,
        data: a.data + '|' + b.data,
        coalesceKey: a.coalesceKey,
      }),
    });
    q.enqueue({ priority: 'delta', data: '1' });
    q.enqueue({ priority: 'delta', data: '2' });
    q.enqueue({ priority: 'delta', data: '3', coalesceKey: 'k' });
    // Above 50% occupancy with same coalesceKey — merged in place,
    // queue size unchanged.
    q.enqueue({ priority: 'delta', data: '4', coalesceKey: 'k' });
    expect(q.size()).toBe(3);
  });

  it('drains in order to the sink', async () => {
    const q = new BoundedSendQueue({
      surface: 'test',
      maxMsgs: 5,
      maxBytes: 1024,
      highWatermark: 0.7,
    });
    q.enqueue({ priority: 'control', data: 'a' });
    q.enqueue({ priority: 'delta', data: 'b' });
    const sent: string[] = [];
    await q.drain((f) => {
      sent.push(f.data);
    });
    expect(sent).toEqual(['a', 'b']);
    expect(q.size()).toBe(0);
  });
});
