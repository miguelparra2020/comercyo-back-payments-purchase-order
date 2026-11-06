import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requireOrderAccess, type OrderAccessVariables } from './require-order-access.middleware';
import { ORDER_ACCESS_SQL, SALES_ORDER_ACCESS_SQL } from '../services/order-access.repository';

const query = vi.fn();
const db = { query } as any;

function buildApp(idUser = 7) {
  const app = new Hono<{ Variables: OrderAccessVariables }>();
  app.use('*', async (c, next) => {
    c.set('id_user', idUser);
    await next();
  });
  app.use('/purchase-orders/:orderId/payments/*', requireOrderAccess(() => db));
  app.get('/purchase-orders/:orderId/payments', (c) => c.json({ id_own_project: c.get('id_own_project') }));
  app.get('/purchase-orders/:orderId/payments/:key', (c) => c.json({ id_own_project: c.get('id_own_project') }));
  return app;
}

describe('requireOrderAccess', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('lets the owner of the order project through and exposes id_own_project', async () => {
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '12' }] });

    const res = await buildApp(7).request('/purchase-orders/123/payments');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_own_project: 12 });
    expect(query).toHaveBeenCalledWith(ORDER_ACCESS_SQL, ['123', 7]);
  });

  it('also guards the single-receipt paths', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await buildApp().request('/purchase-orders/123/payments/some-key');
    expect(res.status).toBe(404);
  });

  it('answers 404 when the user does not own the project (or the order does not exist)', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const res = await buildApp(99).request('/purchase-orders/123/payments');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Not Found',
      message: 'Purchase order not found',
    });
  });

  it.each(['abc', '0', '-1', '1.5', '01', '12345678901234567890'])(
    'rejects orderId %s with 400 without querying the database',
    async (orderId) => {
      const res = await buildApp().request(`/purchase-orders/${orderId}/payments`);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    }
  );

  it('scopes the check to live order, live project and live user owning it', () => {
    const sql = ORDER_ACCESS_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('op.id_own_project = po.id_own_project AND op.deleted_at IS NULL');
    expect(sql).toContain('u.email = op.created_by_email AND u.deleted_at IS NULL');
    expect(sql).toContain('po.id_purchase_order = $1::bigint AND po.deleted_at IS NULL AND u.id_user = $2');
  });

  it('propagates database errors instead of granting access', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    const app = buildApp();
    app.onError((_err, c) => c.json({ success: false }, 500));
    const res = await app.request('/purchase-orders/123/payments');
    expect(res.status).toBe(500);
  });
});

describe('requireOrderAccess (abonos de venta)', () => {
  beforeEach(() => {
    query.mockReset();
  });

  function buildSalesApp(idUser = 7) {
    const app = new Hono<{ Variables: OrderAccessVariables }>();
    app.use('*', async (c, next) => {
      c.set('id_user', idUser);
      await next();
    });
    app.use('/sales-orders/:orderId/payments/*', requireOrderAccess(() => db, 'sales'));
    app.get('/sales-orders/:orderId/payments', (c) => c.json({ id_own_project: c.get('id_own_project') }));
    return app;
  }

  it('checks the sales order against the owner of its project', async () => {
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '9' }] });
    const res = await buildSalesApp(7).request('/sales-orders/55/payments');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_own_project: 9 });
    expect(query).toHaveBeenCalledWith(SALES_ORDER_ACCESS_SQL, ['55', 7]);
  });

  it('answers 404 Sales order not found when the user does not own it', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await buildSalesApp(99).request('/sales-orders/55/payments');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'Not Found', message: 'Sales order not found' });
  });

  it('scopes the sales check to live order, live project and live user owning it', () => {
    const sql = SALES_ORDER_ACCESS_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('FROM sales_orders so');
    expect(sql).toContain('op.id_own_project = so.id_own_project AND op.deleted_at IS NULL');
    expect(sql).toContain('u.email = op.created_by_email AND u.deleted_at IS NULL');
    expect(sql).toContain('so.id_sales_order = $1::bigint AND so.deleted_at IS NULL AND u.id_user = $2');
  });
});
