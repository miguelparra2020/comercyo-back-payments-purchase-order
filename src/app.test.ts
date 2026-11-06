import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const send = vi.fn();
vi.mock('./config/r2', () => ({
  getR2Client: () => ({ send }),
  getR2Bucket: () => 'paymentspurchseordes',
  orderPrefix: (orderId: string) => `purchase-orders/${orderId}/`,
  toObjectKey: (orderId: string, key: string) => `purchase-orders/${orderId}/${key}`,
  buildSignedUrl: async (orderId: string, key: string) => `https://signed.test/${orderId}/${key}`,
  getSignedUrlTtlSeconds: () => 900,
}));

const RECEIPT = '/api/v1/purchase-orders/42/payments/3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const COLLECTION = '/api/v1/purchase-orders/42/payments';

const dbQuery = vi.fn();
vi.mock('./config/db', () => ({ getUsersDb: () => ({ query: dbQuery }) }));

import app from './app';

const SECRET = 'test-secret-at-least-32-characters-long';
const AUDIENCE = 'comercyo-internal';

async function signRawToken(payload: Record<string, unknown>, audience?: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp);
  if (audience) builder = builder.setAudience(audience);
  return builder.sign(new TextEncoder().encode(SECRET));
}

function signToken(payload: Record<string, unknown>) {
  return signRawToken(payload, AUDIENCE);
}

describe('app wiring', () => {
  beforeEach(() => {
    send.mockReset();
    dbQuery.mockReset();
    dbQuery.mockResolvedValue({ rows: [{ id_own_project: 12 }] });
    process.env.JWT_SECRET = SECRET;
    process.env.JWT_AUDIENCE = AUDIENCE;
  });

  it('exposes the payment receipt routes in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.info.title).toBe('Comercyo Purchase Order Payments API');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/purchase-orders/{orderId}/payments', '/purchase-orders/{orderId}/payments/{key}']));
  });

  it('declares a Bearer security scheme required on every payment receipt operation', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(doc.components.securitySchemes.Bearer).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    for (const path of ['/purchase-orders/{orderId}/payments', '/purchase-orders/{orderId}/payments/{key}']) {
      for (const operation of Object.values(doc.paths[path]) as any[]) {
        expect(operation.security).toEqual([{ Bearer: [] }]);
      }
    }
  });

  it('exposes the sales-order receipt routes (abonos de venta) with Bearer security', async () => {
    const doc = await (await app.request('/api/v1/openapi.json')).json();
    for (const path of ['/sales-orders/{orderId}/payments', '/sales-orders/{orderId}/payments/{key}']) {
      expect(doc.paths[path]).toBeDefined();
      for (const operation of Object.values(doc.paths[path]) as any[]) {
        expect(operation.security).toEqual([{ Bearer: [] }]);
      }
    }
  });

  it('requires auth and checks access to the sales order before touching R2', async () => {
    expect((await app.request('/api/v1/sales-orders/42/payments')).status).toBe(401);

    const token = await signToken({ id_user: 7, session_id: 'session-1' });
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.request('/api/v1/sales-orders/42/payments', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
    expect(dbQuery.mock.calls[0][0]).toMatch(/FROM sales_orders so/);
    expect(dbQuery.mock.calls[0][1]).toEqual(['42', 7]);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests to POST payments', async () => {
    expect((await app.request(COLLECTION, { method: 'POST' })).status).toBe(401);
  });

  it('rejects unauthenticated requests to GET a receipt', async () => {
    expect((await app.request(RECEIPT)).status).toBe(401);
  });

  it('rejects unauthenticated requests to list payments', async () => {
    expect((await app.request(COLLECTION)).status).toBe(401);
  });

  it('rejects unauthenticated requests to PUT a receipt', async () => {
    expect((await app.request(RECEIPT, { method: 'PUT' })).status).toBe(401);
  });

  it('rejects unauthenticated requests to DELETE a receipt', async () => {
    expect((await app.request(RECEIPT, { method: 'DELETE' })).status).toBe(401);
  });

  it('rate limits /purchase-orders at 100 requests/minute per IP', async () => {
    const headers = { 'x-forwarded-for': '9.9.9.9' };
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      lastStatus = (await app.request(RECEIPT, { headers })).status;
    }
    expect(lastStatus).toBe(429);

    // A different IP is unaffected by 9.9.9.9's exhausted quota.
    const otherIpRes = await app.request(RECEIPT, { headers: { 'x-forwarded-for': '8.8.8.8' } });
    expect(otherIpRes.status).toBe(401); // past the rate limiter, blocked by auth instead
  });

  it('accepts a real, correctly-audienced token and reaches the route handler', async () => {
    const token = await signToken({ id_user: 7, session_id: 'session-1' });
    send.mockResolvedValueOnce({
      ContentType: 'image/png',
      ContentLength: 42,
      LastModified: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await app.request(RECEIPT, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects a correctly-signed token missing the aud claim (simulating the old token format)', async () => {
    const token = await signRawToken({ id_user: 7, session_id: 'session-1' });
    const res = await app.request(RECEIPT, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it('returns 404 and never touches R2 when the user does not own the order project', async () => {
    const token = await signToken({ id_user: 99, session_id: 'session-1' });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.request(RECEIPT, { headers: { Authorization: `Bearer ${token}` } });

    expect(res.status).toBe(404);
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('FROM purchase_orders'), ['42', 99]);
    expect(send).not.toHaveBeenCalled();
  });

  it('applies the ownership check to uploads and listing too', async () => {
    const token = await signToken({ id_user: 99, session_id: 'session-1' });
    dbQuery.mockResolvedValue({ rows: [] });
    const headers = { Authorization: `Bearer ${token}` };

    expect((await app.request(COLLECTION, { headers })).status).toBe(404);
    expect((await app.request(COLLECTION, { method: 'POST', headers, body: new FormData() })).status).toBe(404);
    expect((await app.request(RECEIPT, { method: 'PUT', headers, body: new FormData() })).status).toBe(404);
    expect((await app.request(RECEIPT, { method: 'DELETE', headers })).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('checks auth before ownership: no token means no database query', async () => {
    expect((await app.request(COLLECTION)).status).toBe(401);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns 404 with the request path for an unknown route', async () => {
    const res = await app.request('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'Not Found', path: '/api/v1/does-not-exist' });
  });
});
