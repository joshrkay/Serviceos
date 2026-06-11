/**
 * D2-1b — Audit coverage smoke test for catalog items, estimate templates,
 * and service bundles.
 *
 * Phase 1 of the D2-1 audit coverage rollout (see
 * docs/quality/audit-coverage-2026-05-16.md) flagged these three routes as
 * lacking audit trails. This test pins three canary mutations to ensure the
 * service-layer audit writes survive future refactors.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';

import { createCatalogItemsRouter } from '../../src/routes/catalog-items';
import { createTemplateRouter } from '../../src/routes/templates';
import { createBundleRouter } from '../../src/routes/bundles';

import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import {
  InMemoryEstimateTemplateRepository,
  createTemplate,
} from '../../src/templates/estimate-template';
import { InMemoryServiceBundleRepository } from '../../src/verticals/bundles';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-d2-1b';
const USER_ID = 'user-d2-1b';

interface Harness {
  app: express.Express;
  auditRepo: InMemoryAuditRepository;
  catalogRepo: InMemoryCatalogItemRepository;
  templateRepo: InMemoryEstimateTemplateRepository;
  bundleRepo: InMemoryServiceBundleRepository;
}

function buildHarness(): Harness {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-d2-1b',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });

  const auditRepo = new InMemoryAuditRepository();
  const catalogRepo = new InMemoryCatalogItemRepository();
  const templateRepo = new InMemoryEstimateTemplateRepository();
  const bundleRepo = new InMemoryServiceBundleRepository();

  app.use('/api/catalog/items', createCatalogItemsRouter(catalogRepo, auditRepo));
  app.use('/api/templates', createTemplateRouter(templateRepo, auditRepo));
  app.use('/api/bundles', createBundleRouter(bundleRepo, auditRepo));

  return { app, auditRepo, catalogRepo, templateRepo, bundleRepo };
}

const sampleLineItem = {
  description: 'Diagnostic fee',
  category: 'labor' as const,
  defaultQuantity: 1,
  defaultUnitPriceCents: 8900,
  taxable: true,
  sortOrder: 1,
  isOptional: false,
};

describe('D2-1b — audit coverage for catalog, templates, bundles', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  it('POST /api/catalog/items writes catalog_item.created', async () => {
    const res = await request(h.app)
      .post('/api/catalog/items')
      .send({
        name: 'Service call',
        category: 'Labor',
        unit: 'hour',
        unitPriceCents: 12500,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const events = await h.auditRepo.findByEntity(
      TENANT_ID,
      'catalog_item',
      res.body.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('catalog_item.created');
    expect(events[0].actorId).toBe(USER_ID);
  });

  it('PUT /api/templates/:id writes estimate_template.updated', async () => {
    // Seed a template directly through the service so the canary is the PUT.
    const template = await createTemplate(
      {
        tenantId: TENANT_ID,
        verticalType: 'hvac',
        categoryId: 'hvac-repair-ac',
        name: 'Standard AC Repair',
        lineItemTemplates: [sampleLineItem],
        createdBy: USER_ID,
      },
      h.templateRepo,
    );

    const res = await request(h.app)
      .put(`/api/templates/${template.id}`)
      .send({ name: 'Renamed AC Repair' });

    expect(res.status).toBe(200);

    const events = await h.auditRepo.findByEntity(
      TENANT_ID,
      'estimate_template',
      template.id,
    );
    const updateEvents = events.filter(
      (e) => e.eventType === 'estimate_template.updated',
    );
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0].actorId).toBe(USER_ID);
  });

  it('POST /api/bundles writes service_bundle.created', async () => {
    const res = await request(h.app)
      .post('/api/bundles')
      .send({
        verticalType: 'hvac',
        name: 'AC Tune-Up Bundle',
        categoryIds: ['hvac-maint-tuneup'],
        lineItemTemplates: [sampleLineItem],
        triggerKeywords: ['tune up'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const events = await h.auditRepo.findByEntity(
      TENANT_ID,
      'service_bundle',
      res.body.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('service_bundle.created');
    expect(events[0].actorId).toBe(USER_ID);
  });
});
