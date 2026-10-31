import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

const send = vi.fn();
vi.mock('../config/r2', () => ({
  getR2Client: () => ({ send }),
  getR2Bucket: () => 'paymentspurchseordes',
  orderPrefix: (orderId: string) => `purchase-orders/${orderId}/`,
  toObjectKey: (orderId: string, key: string) => `purchase-orders/${orderId}/${key}`,
  buildSignedUrl: async (orderId: string, key: string) =>
    `https://signed.test/purchase-orders/${orderId}/${key}?sig=1`,
  getSignedUrlTtlSeconds: () => 900,
}));

import { registerPaymentReceiptsRoutes } from './payment-receipts.routes';
import type { AuthVariables } from '../middlewares/auth.middleware';
import { MAX_FILE_SIZE_BYTES } from '../utils/image-validation.utils';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BASE = '/purchase-orders/42/payments';

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>({
    defaultHook: (result, c) => {
      if ('error' in result) {
        return c.json({ success: false, error: 'Bad Request', message: result.error.issues[0]?.message }, 400);
      }
    },
  });
  // Stand in for requireAuth(): every request in these tests is already authenticated.
  app.use('*', async (c, next) => {
    c.set('id_user', 7);
    await next();
  });
  registerPaymentReceiptsRoutes(app);
  return app;
}

function makePngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function pngForm(name = 'comprobante pago.png') {
  const form = new FormData();
  form.append('file', new File([makePngBuffer(1200, 1600)], name, { type: 'image/png' }));
  return form;
}

const notFoundError = () => Object.assign(new Error('not found'), { name: 'NotFound' });

describe('payment receipts routes', () => {
  beforeEach(() => {
    send.mockReset();
  });

  describe('POST /purchase-orders/{orderId}/payments', () => {
    it('stores the receipt under the order folder and returns a signed URL', async () => {
      send.mockResolvedValueOnce({});
      const res = await buildApp().request(BASE, { method: 'POST', body: pngForm() });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: {
          key: expect.stringMatching(/^[0-9a-f-]{36}$/),
          orderId: '42',
          url: expect.stringContaining('https://signed.test/purchase-orders/42/'),
          expiresIn: 900,
          contentType: 'image/png',
          size: 33,
          width: 1200,
          height: 1600,
        },
      });

      const command = send.mock.calls[0][0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'paymentspurchseordes',
        Key: `purchase-orders/42/${body.data.key}`,
        ContentType: 'image/png',
        Metadata: { 'uploaded-by': '7', 'original-name': 'comprobante%20pago.png' },
      });
    });

    it('rejects a request with no file attached', async () => {
      const res = await buildApp().request(BASE, { method: 'POST', body: new FormData() });
      expect(res.status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('rejects an unsupported file type', async () => {
      const form = new FormData();
      form.append('file', new File([Buffer.from('hello')], 'doc.pdf', { type: 'application/pdf' }));
      const res = await buildApp().request(BASE, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/image\/jpeg, image\/png, image\/webp/);
    });

    it('rejects a request whose Content-Length exceeds the 10MB limit, without touching R2', async () => {
      const form = new FormData();
      form.append('file', new File([Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)], 'big.png', { type: 'image/png' }));
      const res = await buildApp().request(BASE, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('rejects an orderId that could escape the order folder', async () => {
      const res = await buildApp().request('/purchase-orders/..%2Fother/payments', {
        method: 'POST',
        body: pngForm(),
      });
      expect(res.status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('GET /purchase-orders/{orderId}/payments', () => {
    it('lists every receipt of the order across pages, oldest first, with signed URLs', async () => {
      send
        .mockResolvedValueOnce({
          Contents: [{ Key: `purchase-orders/42/${KEY}`, Size: 10, LastModified: new Date('2026-02-01T00:00:00Z') }],
          IsTruncated: true,
          NextContinuationToken: 'next',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'purchase-orders/42/older', Size: 5, LastModified: new Date('2026-01-01T00:00:00Z') }],
          IsTruncated: false,
        });

      const res = await buildApp().request(BASE);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        data: [
          {
            key: 'older',
            orderId: '42',
            url: 'https://signed.test/purchase-orders/42/older?sig=1',
            expiresIn: 900,
            size: 5,
            lastModified: '2026-01-01T00:00:00.000Z',
          },
          {
            key: KEY,
            orderId: '42',
            url: `https://signed.test/purchase-orders/42/${KEY}?sig=1`,
            expiresIn: 900,
            size: 10,
            lastModified: '2026-02-01T00:00:00.000Z',
          },
        ],
      });

      expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
      expect(send.mock.calls[0][0].input.Prefix).toBe('purchase-orders/42/');
      expect(send.mock.calls[1][0].input.ContinuationToken).toBe('next');
    });

    it('returns an empty list for an order without receipts', async () => {
      send.mockResolvedValueOnce({ IsTruncated: false });
      const res = await buildApp().request(BASE);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: [] });
    });
  });

  describe('GET /purchase-orders/{orderId}/payments/{key}', () => {
    it('returns the receipt detail with a fresh signed URL', async () => {
      send.mockResolvedValueOnce({
        ContentType: 'image/png',
        ContentLength: 1234,
        LastModified: new Date('2026-01-01T00:00:00Z'),
        Metadata: { 'uploaded-by': '7', 'original-name': 'pago%20ma%C3%B1ana.png' },
      });

      const res = await buildApp().request(`${BASE}/${KEY}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        data: {
          key: KEY,
          orderId: '42',
          url: `https://signed.test/purchase-orders/42/${KEY}?sig=1`,
          expiresIn: 900,
          contentType: 'image/png',
          size: 1234,
          lastModified: '2026-01-01T00:00:00.000Z',
          uploadedBy: 7,
          originalName: 'pago mañana.png',
        },
      });
    });

    it('returns null uploadedBy/originalName when metadata is missing', async () => {
      send.mockResolvedValueOnce({ ContentType: 'image/png', ContentLength: 1 });
      const body = await (await buildApp().request(`${BASE}/${KEY}`)).json();
      expect(body.data.uploadedBy).toBeNull();
      expect(body.data.originalName).toBeNull();
    });

    it('returns 404 when the receipt does not exist', async () => {
      send.mockRejectedValueOnce(notFoundError());
      expect((await buildApp().request(`${BASE}/${KEY}`)).status).toBe(404);
    });

    it('propagates a non-NotFound R2 error as a 500 rather than a 404', async () => {
      send.mockRejectedValueOnce(Object.assign(new Error('access denied'), { name: 'AccessDenied' }));
      expect((await buildApp().request(`${BASE}/${KEY}`)).status).toBe(500);
    });

    it('rejects a key that is not a UUID before touching R2', async () => {
      expect((await buildApp().request(`${BASE}/abc.png`)).status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('PUT /purchase-orders/{orderId}/payments/{key}', () => {
    it('overwrites an existing receipt keeping the same key', async () => {
      send.mockResolvedValueOnce({}); // HeadObjectCommand
      send.mockResolvedValueOnce({}); // PutObjectCommand

      const res = await buildApp().request(`${BASE}/${KEY}`, { method: 'PUT', body: pngForm() });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.key).toBe(KEY);
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
      expect(send.mock.calls[1][0]).toBeInstanceOf(PutObjectCommand);
      expect(send.mock.calls[1][0].input.Key).toBe(`purchase-orders/42/${KEY}`);
    });

    it('returns 404 and writes nothing when the receipt does not exist', async () => {
      send.mockRejectedValueOnce(notFoundError());
      const res = await buildApp().request(`${BASE}/${KEY}`, { method: 'PUT', body: pngForm() });
      expect(res.status).toBe(404);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid replacement file without writing', async () => {
      send.mockResolvedValueOnce({}); // HeadObjectCommand
      const form = new FormData();
      form.append('file', new File([Buffer.from('hello')], 'x.png', { type: 'image/png' }));
      const res = await buildApp().request(`${BASE}/${KEY}`, { method: 'PUT', body: form });
      expect(res.status).toBe(400);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('DELETE /purchase-orders/{orderId}/payments/{key}', () => {
    it('deletes an existing receipt', async () => {
      send.mockResolvedValueOnce({}); // HeadObjectCommand
      send.mockResolvedValueOnce({}); // DeleteObjectCommand

      const res = await buildApp().request(`${BASE}/${KEY}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: { key: KEY, orderId: '42' } });
      expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
      expect(send.mock.calls[1][0].input.Key).toBe(`purchase-orders/42/${KEY}`);
    });

    it('returns 404 when the receipt does not exist', async () => {
      send.mockRejectedValueOnce(notFoundError());
      const res = await buildApp().request(`${BASE}/${KEY}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
