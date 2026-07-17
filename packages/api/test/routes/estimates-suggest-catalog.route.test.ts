/**
 * Regression: POST /api/estimates/suggest must ground AI-suggested line-item
 * prices to the tenant catalog, exactly like the voice path.
 *
 * The bug: createEstimateRouter built `new EstimateTaskHandler(aiDeps.gateway)`
 * WITHOUT a catalog repo, so an LLM-invented unitPrice bypassed catalog
 * grounding on this primary in-app surface — violating the locked pattern
 * "never trust an LLM-emitted price without resolution". These tests wire the
 * catalog repo through EstimateAIDeps and prove the returned line carries the
 * CATALOG price (pricingSource 'catalog'), not the raw LLM price.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createEstimateRouter, EstimateAIDeps } from '../../src/routes/estimates';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-suggest-1';
const USER_ID = 'user-suggest-1';

// The LLM invents a price that is NOT the catalog price. Grounding must
// overwrite it with the real catalog unitPriceCents (7500). Must stay within
// PRICE_CONFLICT tolerance of the catalog price — a larger deviation is a
// "did you mean" conflict (surfaced for one-tap resolution), not a snap.
const LLM_INVENTED_PRICE = 7440;
const CATALOG_PRICE = 7500;

function makeGateway(): LLMGateway {
  const stub = new StubProvider('stub');
  stub.setResponse({
    content: JSON.stringify({
      customerId: '550e8400-e29b-41d4-a716-446655440000',
      lineItems: [{ description: 'Pipe repair', quantity: 2, unitPrice: LLM_INVENTED_PRICE }],
      notes: 'AI draft',
      confidence_score: 0.95,
    }),
  });
  const providers = new Map<string, LLMProvider>();
  providers.set('stub', stub);
  const config: LLMGatewayConfig = { defaultProvider: 'stub', defaultModel: 'test-model' };
  return new LLMGateway(config, providers);
}

async function catalogWithPipeRepair(): Promise<InMemoryCatalogItemRepository> {
  const repo = new InMemoryCatalogItemRepository();
  await repo.create(
    createCatalogItem({
      tenantId: TENANT_ID,
      name: 'Pipe repair',
      category: 'Parts',
      unit: 'each',
      unitPriceCents: CATALOG_PRICE,
    }),
  );
  return repo;
}

function buildApp(aiDeps?: EstimateAIDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-suggest-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/estimates',
    createEstimateRouter(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
      new InMemoryAuditRepository(),
      permissiveTenantOwnership(),
      undefined,
      aiDeps,
    ),
  );
  return app;
}

describe('POST /api/estimates/suggest — catalog grounding', () => {
  it('grounds the AI-suggested line price to the tenant catalog (pricingSource=catalog)', async () => {
    const app = buildApp({
      gateway: makeGateway(),
      proposalRepo: new InMemoryProposalRepository(),
      catalogRepo: await catalogWithPipeRepair(),
    });

    const res = await request(app)
      .post('/api/estimates/suggest')
      .send({ description: 'need a pipe repair' });

    expect(res.status).toBe(200);
    const line = res.body.lineItems[0];
    // Grounded: the catalog price wins, the LLM's invented price is discarded.
    expect(line.unitPrice).toBe(CATALOG_PRICE);
    expect(line.unitPrice).not.toBe(LLM_INVENTED_PRICE);
    expect(line.pricingSource).toBe('catalog');
  });

  it('without a catalog repo the LLM price is NOT grounded (guards the bug that was fixed)', async () => {
    // Proves the wiring is load-bearing: drop catalogRepo and the invented
    // LLM price rides through as uncatalogued (the pre-fix behavior).
    const app = buildApp({
      gateway: makeGateway(),
      proposalRepo: new InMemoryProposalRepository(),
      // catalogRepo intentionally omitted
    });

    const res = await request(app)
      .post('/api/estimates/suggest')
      .send({ description: 'need a pipe repair' });

    expect(res.status).toBe(200);
    const line = res.body.lineItems[0];
    expect(line.unitPrice).toBe(LLM_INVENTED_PRICE);
    expect(line.pricingSource).toBe('uncatalogued');
  });
});
