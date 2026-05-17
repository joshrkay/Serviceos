/**
 * P2-029 — GET /api/health/ai
 *
 * Returns per-provider health state derived from the circuit-breaker registry.
 * Reads cached state only — no active probing.
 *
 * Response shape:
 *   { providers: [{ name, available, breakerState, lastError?, lastSuccessAt? }] }
 *
 * Public endpoint (no auth required) — health endpoints are conventionally
 * open so monitoring infrastructure can reach them without credentials.
 */
import { Router, Request, Response } from 'express';
import { CircuitBreakerRegistry, type BreakerKeyParts } from '../ai/gateway/breaker';

export interface ProviderHealthEntry {
  name: string;
  available: boolean;
  breakerState: 'closed' | 'open' | 'half-open';
  lastError?: string;
  lastSuccessAt?: string;
}

/**
 * A lightweight descriptor for providers registered with the health endpoint.
 * The `isAvailable()` function reads cached state — it must NOT issue network
 * calls (no active probing per P2-029 spec).
 */
export interface ProviderHealthDescriptor {
  name: string;
  isAvailable: () => Promise<boolean>;
  /** Optional breaker key parts to look up the specific cell. Defaults to { provider: name, modelFamily: 'default' }. */
  breakerKeyParts?: BreakerKeyParts;
}

/**
 * Create the Express router for AI health checks.
 *
 * @param breakerRegistry - Shared circuit breaker registry from createLLMGateway.
 * @param providers       - Optional list of provider descriptors. When empty,
 *                          the response still returns the providers array (empty).
 *                          This is intentional: P2-029 wires the endpoint; actual
 *                          provider list grows as real providers are provisioned.
 */
export function createAiHealthRouter(
  breakerRegistry: CircuitBreakerRegistry,
  providers: ProviderHealthDescriptor[] = [],
): Router {
  const router = Router();

  router.get('/ai', async (_req: Request, res: Response) => {
    const providerEntries: ProviderHealthEntry[] = await Promise.all(
      providers.map(async (p): Promise<ProviderHealthEntry> => {
        const keyParts: BreakerKeyParts = p.breakerKeyParts ?? {
          provider: p.name,
          modelFamily: 'default',
        };
        const cell = breakerRegistry.cell(keyParts);
        const breakerState = cell.getState();
        const available = await p.isAvailable().catch(() => false);

        const entry: ProviderHealthEntry = { name: p.name, available, breakerState };

        const lastError = cell.getLastError();
        if (lastError !== undefined) {
          entry.lastError = lastError;
        }

        const lastSuccessAt = cell.getLastSuccessAt();
        if (lastSuccessAt !== undefined) {
          entry.lastSuccessAt = lastSuccessAt.toISOString();
        }

        return entry;
      }),
    );

    res.status(200).json({ providers: providerEntries });
  });

  return router;
}
