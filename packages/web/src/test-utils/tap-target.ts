import { expect } from 'vitest';

/**
 * Mobile bar (CLAUDE.md): every tap target is ≥44×44. jsdom can't measure
 * layout, so component tests pin the CSS class contract instead — `size-11`,
 * or `min-h-11` plus `min-w-11` (a control that stretches to its container
 * with `w-full` / `flex-1` is wide enough by construction). The measured
 * check lives in e2e/page-tap-targets-mobile.spec.ts (#1398).
 */
function meetsTapTarget(el: Element): boolean {
  const cls = el.getAttribute('class') ?? '';
  const has = (token: string) => new RegExp(`(^|\\s)${token}(\\s|$)`).test(cls);
  const minH = /(^|\s)min-h-\[(\d+)px\](\s|$)/.exec(cls);
  const tall = has('size-11') || has('min-h-11') || (!!minH && Number(minH[2]) >= 44);
  const minW = /(^|\s)min-w-\[(\d+)px\](\s|$)/.exec(cls);
  const wide =
    has('size-11') || has('min-w-11') || has('w-full') || has('flex-1') || (!!minW && Number(minW[2]) >= 44);
  return tall && wide;
}

export function expectTapTarget(el: Element, what: string): void {
  const cls = el.getAttribute('class') ?? '';
  expect(meetsTapTarget(el), `${what} must be ≥44×44 (class="${cls}")`).toBe(true);
}

const CONTROLS =
  'button, a[href], select, textarea, input:not([type="hidden"]):not([type="file"]), [role="switch"], [role="radio"], [role="checkbox"]';

/**
 * Every rendered control under `root` meets the tap-target contract. Controls
 * that are visually hidden (`sr-only` / `hidden`) are skipped — their visible
 * label or wrapper is the target. Fails with the full list of offenders.
 */
export function expectAllTapTargets(root: ParentNode, what: string): void {
  const offenders: string[] = [];
  for (const el of Array.from(root.querySelectorAll(CONTROLS))) {
    const cls = el.getAttribute('class') ?? '';
    if (/(^|\s)(sr-only|hidden)(\s|$)/.test(cls)) continue;
    if (meetsTapTarget(el)) continue;
    const name =
      el.getAttribute('aria-label') ??
      el.getAttribute('placeholder') ??
      (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    offenders.push(`${el.tagName.toLowerCase()} "${name}" class="${cls}"`);
  }
  expect(offenders, `${what}: controls under 44×44`).toEqual([]);
}
