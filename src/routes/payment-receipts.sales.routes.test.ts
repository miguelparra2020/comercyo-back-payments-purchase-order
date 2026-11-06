import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

// Comprobantes de los abonos de la factura de venta: mismas rutas que compras
// bajo /sales-orders, guardados en la carpeta sales-orders/{orderId}/ del bucket.

const send = vi.fn();
const PREFIX = { purchase: 'purchase-orders/', sales: 'sales-orders/' } as const;
type Kind = keyof typeof PREFIX;
vi.mock('../config/r2', () => ({
  getR2Client: () => ({ send }),
  getR2Bucket: () => 'paymentspurchseordes',
  orderPrefix: (orderId: string, kind: Kind = 'purchase') => `${PREFIX[kind]}${orderId}/`,
  toObjectKey: (orderId: string, key: string, kind: Kind = 'purchase') => `${PREFIX[kind]}${orderId}/${key}`,
  buildSignedUrl: async (orderId: string, key: string, kind: Kind = 'purchase') =>
    `https://signed.test/${PREFIX[kind]}${orderId}/${key}?sig=1`,
  getSignedUrlTtlSeconds: () => 900,
}));

import { registerPaymentReceiptsRoutes } from './payment-receipts.routes';
import type { AuthVariables } from '../middlewares/auth.middleware';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('id_user', 7);
    await next();
  });
  registerPaymentReceiptsRoutes(app, 'sales');
  return app;
}

function pngForm() {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1200, 16);
  buffer.writeUInt32BE(1600, 20);
  const form = new FormData();
  form.append('file', new File([buffer], 'abono.png', { type: 'image/png' }));
  return form;
}

describe('payment receipts routes (abonos de venta)', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('POST guarda la foto en sales-orders/{orderId}/ y devuelve la URL firmada', async () => {
    send.mockResolvedValueOnce({});
    const res = await buildApp().request('/sales-orders/55/payments', { method: 'POST', body: pngForm() });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.orderId).toBe('55');
    expect(data.url).toContain('https://signed.test/sales-orders/55/');
    const put = send.mock.calls[0][0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input.Key).toMatch(/^sales-orders\/55\/[0-9a-f-]{36}$/);
  });

  it('GET y DELETE de un comprobante usan la carpeta de ventas', async () => {
    send.mockResolvedValueOnce({ ContentType: 'image/png', ContentLength: 10, Metadata: {} });
    const get = await buildApp().request(`/sales-orders/55/payments/${KEY}`);
    expect(get.status).toBe(200);
    expect((send.mock.calls[0][0] as HeadObjectCommand).input.Key).toBe(`sales-orders/55/${KEY}`);

    send.mockReset();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const del = await buildApp().request(`/sales-orders/55/payments/${KEY}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const command = send.mock.calls[1][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input.Key).toBe(`sales-orders/55/${KEY}`);
  });

  it('no registra las rutas de compras', async () => {
    const res = await buildApp().request('/purchase-orders/55/payments');
    expect(res.status).toBe(404);
  });
});
