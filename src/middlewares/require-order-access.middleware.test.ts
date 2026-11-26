import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requireOrderAccess, type OrderAccessVariables } from './require-order-access.middleware';
import { OBRA_PAYMENT_ACCESS_SQL, ORDER_ACCESS_SQL, SALES_ORDER_ACCESS_SQL, WORKER_PAYMENT_ACCESS_SQL } from '../services/order-access.repository';

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
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '12', acceso: { duenio: true } }] });

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

  it('scopes the check to live order, live project and the owner or a team member', () => {
    const sql = ORDER_ACCESS_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('op.id_own_project = po.id_own_project AND op.deleted_at IS NULL');
    expect(sql).toContain('po.id_purchase_order = $1::bigint AND po.deleted_at IS NULL');
    expect(sql).toContain('permisos_en_proyecto(po.id_own_project, $2::bigint) IS NOT NULL');
  });

  it('answers 404 when the row has no acceso', async () => {
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '12', acceso: null }] });
    expect((await buildApp().request('/purchase-orders/123/payments')).status).toBe(404);
  });

  it('lets a team member with pedidos_compra see the receipts', async () => {
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '12', acceso: { duenio: false, permisos: { pedidos_compra: ['ver'] } } }] });
    expect((await buildApp().request('/purchase-orders/123/payments')).status).toBe(200);
  });

  it('answers 403 to a team member without pedidos_compra', async () => {
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '12', acceso: { duenio: false, permisos: { clientes: ['ver'] } } }] });
    const res = await buildApp().request('/purchase-orders/123/payments');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain('pedidos de compra');
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
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '9', acceso: { duenio: true } }] });
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

  it('scopes the sales check to live order, live project and the owner or a team member', () => {
    const sql = SALES_ORDER_ACCESS_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('FROM sales_orders so');
    expect(sql).toContain('op.id_own_project = so.id_own_project AND op.deleted_at IS NULL');
    expect(sql).toContain('so.id_sales_order = $1::bigint AND so.deleted_at IS NULL');
    expect(sql).toContain('permisos_en_proyecto(so.id_own_project, $2::bigint) IS NOT NULL');
  });

  it('the quick sale (caja rápida) can see sales receipts', async () => {
    query.mockResolvedValueOnce({ rows: [{ id_own_project: '9', acceso: { duenio: false, permisos: { caja_rapida: ['ver', 'crear'] } } }] });
    expect((await buildSalesApp().request('/sales-orders/55/payments')).status).toBe(200);
  });

  describe('pagos a trabajadores (kind worker)', () => {
    const app = () => {
      const a = new Hono<{ Variables: OrderAccessVariables }>();
      a.use('*', async (c, next) => {
        c.set('id_user', 7);
        await next();
      });
      a.use('/worker-payments/:orderId/payments/*', requireOrderAccess(() => db, 'worker'));
      a.post('/worker-payments/:orderId/payments', (c) => c.json({ id_own_project: c.get('id_own_project') }));
      return a;
    };

    it('busca el pago en trabajador_pagos y deja subir a quien tiene trabajadores', async () => {
      query.mockResolvedValueOnce({ rows: [{ id_own_project: '41', acceso: { duenio: false, permisos: { trabajadores: ['ver', 'crear'] } } }] });
      const res = await app().request('/worker-payments/5/payments', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(query).toHaveBeenCalledWith(WORKER_PAYMENT_ACCESS_SQL, ['5', 7]);
      expect(WORKER_PAYMENT_ACCESS_SQL).toMatch(/FROM trabajador_pagos tp/);
    });

    it('sin el módulo trabajadores: 403', async () => {
      query.mockResolvedValueOnce({ rows: [{ id_own_project: '41', acceso: { duenio: false, permisos: { pedidos_compra: ['ver', 'crear'] } } }] });
      expect((await app().request('/worker-payments/5/payments', { method: 'POST' })).status).toBe(403);
    });
  });

  describe('pagos de facturas de obra (kind obra)', () => {
    const app = () => {
      const a = new Hono<{ Variables: OrderAccessVariables }>();
      a.use('*', async (c, next) => {
        c.set('id_user', 7);
        await next();
      });
      a.use('/obra-payments/:orderId/payments/*', requireOrderAccess(() => db, 'obra'));
      a.post('/obra-payments/:orderId/payments', (c) => c.json({ id_own_project: c.get('id_own_project') }));
      return a;
    };

    it('busca el pago en obra_factura_pagos y deja subir a quien tiene presupuestos', async () => {
      query.mockResolvedValueOnce({ rows: [{ id_own_project: '41', acceso: { duenio: false, permisos: { presupuestos: ['ver', 'crear'] } } }] });
      const res = await app().request('/obra-payments/12/payments', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(query).toHaveBeenCalledWith(OBRA_PAYMENT_ACCESS_SQL, ['12', 7]);
      expect(OBRA_PAYMENT_ACCESS_SQL).toMatch(/FROM obra_factura_pagos p/);
    });

    it('sin presupuestos: 403', async () => {
      query.mockResolvedValueOnce({ rows: [{ id_own_project: '41', acceso: { duenio: false, permisos: { trabajadores: ['ver', 'crear'] } } }] });
      expect((await app().request('/obra-payments/12/payments', { method: 'POST' })).status).toBe(403);
    });
  });
});
