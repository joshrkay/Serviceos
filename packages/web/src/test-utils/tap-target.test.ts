import { describe, expect, it } from 'vitest';
import { expectTapTarget } from './tap-target';

function el(cls: string): Element {
  const node = document.createElement('button');
  node.setAttribute('class', cls);
  return node;
}

describe('expectTapTarget', () => {
  it('accepts min-h-11 and taller steps with a width guarantee', () => {
    expect(() => expectTapTarget(el('min-h-11 min-w-11'), 'a')).not.toThrow();
    expect(() => expectTapTarget(el('min-h-14 w-full'), 'b')).not.toThrow();
    expect(() => expectTapTarget(el('min-h-[56px] flex-1'), 'c')).not.toThrow();
  });

  it('rejects anything shorter than 44px, or with nothing keeping it wide enough', () => {
    expect(() => expectTapTarget(el('min-h-10 w-full'), 'd')).toThrow();
    expect(() => expectTapTarget(el('min-h-0 w-full'), 'e')).toThrow();
    expect(() => expectTapTarget(el('min-h-14'), 'f')).toThrow();
  });
});
