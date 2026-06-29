import { Spinner } from '../ui/spinner';

/**
 * Full-area centered loading state shown while a lazy route chunk resolves —
 * used both as the router `hydrateFallbackElement` (cold deep-link to a lazy
 * route) and anywhere a route subtree is waiting on its code chunk. Keeps the
 * wait from degrading to a blank white screen.
 */
export function RouteFallback() {
  return (
    <div
      className="flex h-full w-full items-center justify-center p-8"
      role="status"
      aria-label="Loading"
    >
      <Spinner size="lg" className="text-muted-foreground" />
    </div>
  );
}
