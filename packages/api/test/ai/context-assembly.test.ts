import {
  createContextBlock,
  assembleContext,
  estimateTokens,
} from '../../src/ai/context-assembly';

describe('P2-008 — Context assembly stub', () => {
  it('happy path — creates context block', () => {
    const block = createContextBlock('terminology', 'hvac-pack', 'SEER: Seasonal Energy...', 10);
    expect(block.type).toBe('terminology');
    expect(block.source).toBe('hvac-pack');
    expect(block.priority).toBe(10);
  });

  it('happy path — assembles context sorted by priority', () => {
    const blocks = [
      createContextBlock('low', 'src1', 'low priority', 1),
      createContextBlock('high', 'src2', 'high priority', 10),
      createContextBlock('mid', 'src3', 'mid priority', 5),
    ];
    const assembled = assembleContext(blocks);
    expect(assembled.blocks[0].type).toBe('high');
    expect(assembled.blocks[1].type).toBe('mid');
    expect(assembled.blocks[2].type).toBe('low');
    expect(assembled.assembledAt).toBeInstanceOf(Date);
  });

  it('validation — estimateTokens returns reasonable values', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('mock provider test — assembleContext calculates token estimate', () => {
    const blocks = [
      createContextBlock('a', 's', 'a'.repeat(100), 1),
      createContextBlock('b', 's', 'b'.repeat(200), 2),
    ];
    const assembled = assembleContext(blocks);
    expect(assembled.totalTokenEstimate).toBe(75); // 25 + 50
  });

  it('malformed AI output handled gracefully — empty blocks array', () => {
    const assembled = assembleContext([]);
    expect(assembled.blocks).toEqual([]);
    expect(assembled.totalTokenEstimate).toBe(0);
  });
});
