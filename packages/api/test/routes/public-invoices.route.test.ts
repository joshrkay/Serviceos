import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createPublicInvoicesRouter } from '../../src/routes/public-invoices';
import type { PublicInvoiceService } from '../../src/invoices/public-invoice-service';
import { NotFoundError } from '../../src/shared/errors';

const VALID_TOKEN = 'a'.repeat(20);

function stubService(overrides: Partial<PublicInvoiceService> = {}): PublicInvoiceService {
  return {
    getByToken: vi.fn(async () => ({ invoiceNumber: 'INV-1' })),
    recordView: vi.fn(async () => ({ viewCount: 1 })),
    getOrCreateCheckoutUrl: vi.fn(async () => ({ url: 'https://pay.example/x' })),
    ...overrides,
  } as unknown as PublicInvoiceService;
}

function buildApp(service: PublicInvoiceService) {
  const app = express();
  app.use(express.json());
  app.use('/public/invoices', createPublicInvoicesRouter(service));
  return app;
}

describe('EC-7 — public invoice token guard (route layer)', () => {
  it('rejects a too-short token with 400 and never calls the service', async () => {
    const service = stubService();
    const r = await request(buildApp(service)).get('/public/invoices/short');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_TOKEN');
    expect(service.getByToken).not.toHaveBeenCalled();
  });

  it('rejects a too-long token (> 512) with 400 — route mirrors the service bound', async () => {
    const service = stubService();
    const r = await request(buildApp(service)).get(`/public/invoices/${'a'.repeat(513)}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_TOKEN');
    expect(service.getByToken).not.toHaveBeenCalled();
  });

  it('passes a valid-length token through to the service', async () => {
    const service = stubService();
    const r = await request(buildApp(service)).get(`/public/invoices/${VALID_TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.invoiceNumber).toBe('INV-1');
    expect(service.getByToken).toHaveBeenCalledWith(VALID_TOKEN);
  });
});

describe('EC-9 — route handlers map (and log) errors instead of leaking them', () => {
  it('maps a NotFoundError to 404 (4xx → warn branch)', async () => {
    const service = stubService({
      getByToken: vi.fn(async () => {
        throw new NotFoundError('Invoice', 'tok');
      }),
    });
    const r = await request(buildApp(service)).get(`/public/invoices/${VALID_TOKEN}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBeDefined();
  });

  it('maps an unexpected error to 500 (5xx → error branch) without crashing', async () => {
    const service = stubService({
      recordView: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r = await request(buildApp(service)).post(`/public/invoices/${VALID_TOKEN}/view`);
    expect(r.status).toBe(500);
    expect(r.body).toBeDefined();
  });
});
