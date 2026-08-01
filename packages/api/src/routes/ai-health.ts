/**
 * P2-029 — GET /api/health/ai
 *
 * Returns per-provider health state derived from the circuit-breaker registry.
 * Reads cached state only — no active probing on the public listing route.
 *
 * Response shape:
 *   { providers: [{ name, available, breakerState, lastError?, lastSuccessAt? }] }
 *
 * U4 — GET /api/health/ai/completion (METRICS_TOKEN / same gate as /metrics)
 * runs a cheap classify_intent completion so ops can see real provider
 * failures that leave the breaker closed (bad key, model/host mismatch).
 */
import { Router, Request, Response } from 'express';
import { CircuitBreakerRegistry, type BreakerKeyParts } from '../ai/gateway/breaker';
import type { LLMGateway } from '../ai/gateway/gateway';
import { probeAiCompletion } from '../ai/gateway/readiness';
import { checkMetricsAuth } from '../bootstrap/metrics-auth';

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
 *
 * @deprecated Pass descriptors only in tests. Production uses registry iteration.
 */
export interface ProviderHealthDescriptor {
  name: string;
  isAvailable: () => Promise<boolean>;
  /** Optional breaker key parts to look up the specific cell. Defaults to { provider: name, modelFamily: 'default' }. */
  breakerKeyParts?: BreakerKeyParts;
}

export interface AiHealthRouterOptions {
  /** When set, enables GET /ai/completion (gated like /metrics). */
  gateway?: Pick<LLMGateway, 'complete'>;
}

/**
 * Create the Express router for AI health checks.
 *
 * The handler iterates the circuit-breaker registry directly to enumerate all
 * known providers and their breaker states — so the response is always
 * populated as long as the gateway has received at least one request (which
 * creates breaker cells).
 *
 * @param breakerRegistry - Shared circuit breaker registry from createLLMGateway.
 * @param providers       - Optional list of provider descriptors for tests /
 *                          legacy callers that need isAvailable() probing. When
 *                          provided, these entries are merged with the registry
 *                          state (registry wins for breakerState/lastError/
 *                          lastSuccessAt; descriptor wins for `available`).
 *                          Pass an empty array (or omit) to rely solely on
 *                          registry iteration.
 * @param options         - Optional completion-probe wiring.
 */
export function createAiHealthRouter(
  breakerRegistry: CircuitBreakerRegistry,
  providers: ProviderHealthDescriptor[] = [],
  options: AiHealthRouterOptions = {},
): Router {
  const router = Router();

  router.get('/ai', async (_req: Request, res: Response) => {
    // Build a lookup for descriptor-supplied availability overrides.
    const descriptorMap = new Map<string, ProviderHealthDescriptor>(
      providers.map((p) => [p.name, p]),
    );

    // Primary source of truth: iterate registry cells.
    const registryStates = breakerRegistry.getProviderStates();

    const providerEntries: ProviderHealthEntry[] = await Promise.all(
      registryStates.map(async (state): Promise<ProviderHealthEntry> => {
        const descriptor = descriptorMap.get(state.provider);
        const available = descriptor
          ? await descriptor.isAvailable().catch(() => false)
          : state.breakerState === 'closed';

        const entry: ProviderHealthEntry = {
          name: state.provider,
          available,
          breakerState: state.breakerState,
        };

        if (state.lastError !== undefined) {
          entry.lastError = state.lastError;
        }

        if (state.lastSuccessAt !== undefined) {
          entry.lastSuccessAt = state.lastSuccessAt.toISOString();
        }

        return entry;
      }),
    );

    // Include any descriptor entries whose provider has no registry cell yet
    // (e.g. providers not yet called, added via test descriptors only).
    const registryProviderNames = new Set(registryStates.map((s) => s.provider));
    const extraEntries: ProviderHealthEntry[] = await Promise.all(
      providers
        .filter((p) => !registryProviderNames.has(p.name))
        .map(async (p): Promise<ProviderHealthEntry> => {
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

    res.status(200).json({ providers: [...providerEntries, ...extraEntries] });
  });

  router.get('/ai/completion', async (req: Request, res: Response) => {
    const auth = checkMetricsAuth(
      req.headers.authorization,
      process.env.METRICS_TOKEN,
      process.env.NODE_ENV,
    );
    if (!auth.ok) {
      if (auth.headers) {
        for (const [k, v] of Object.entries(auth.headers)) res.setHeader(k, v);
      }
      res.status(auth.status).json(auth.body);
      return;
    }

    if (!options.gateway) {
      res.status(503).json({
        error: 'AI_GATEWAY_UNAVAILABLE',
        message: 'LLM gateway is not configured (AI_PROVIDER_API_KEY missing).',
      });
      return;
    }

    const completionProbe = await probeAiCompletion(options.gateway, {
      providersSnapshot: () =>
        breakerRegistry.getProviderStates().map((state) => ({
          name: state.provider,
          available: state.breakerState === 'closed',
          breakerState: state.breakerState,
          ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
        })),
    });
    res.status(200).json({ completionProbe });
  });

  return router;
}
