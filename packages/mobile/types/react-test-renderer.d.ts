// Minimal ambient types for react-test-renderer. This isolated project has no
// @types/react-test-renderer dependency, and the package ships none; declare
// only the slice the voice hook test uses. A standalone .d.ts (not an inline
// `declare module` in a consuming file) is required so TS treats this as the
// module's declaration rather than an augmentation of an untyped module.
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export function act(callback: () => void): void;
  export function act(callback: () => Promise<unknown>): Promise<void>;
  export function create(element: ReactElement): { unmount(): void };

  const TestRenderer: { create: typeof create; act: typeof act };
  export default TestRenderer;
}
