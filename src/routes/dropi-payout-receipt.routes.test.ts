import { describe, it, expect, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

vi.mock('../config/r2', () => ({
  buildSignedUrl: async (orderId: string, key: string, kind: string) => `https://signed.test/${kind}-orders/${orderId}/${key}?sig=1`,
  getSignedUrlTtlSeconds: () => 900,
}));

import { DROPI_PAYOUT_RECEIPT_SQL, registerDropiPayoutReceiptRoute } from './dropi-payout-receipt.routes';
import type { AuthVariables } from '../middlewares/auth.middleware';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function buildApp(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('id_user', 7);
    await next();
  });
  registerDropiPayoutReceiptRoute(app, () => ({ query }) as any);
  return { app, query };
}

describe('comprobante de un pago al dropshipper (2026-11-21)', () => {
  it('el dropshipper del pago recibe la URL firmada de la carpeta del pedido', async () => {
    const { app, query } = buildApp([{ order_id: '239', key: KEY }]);
    const res = await app.request('/dropi/payouts/12/receipt');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ url: `https://signed.test/sales-orders/239/${KEY}?sig=1`, expiresIn: 900 });
    expect(query).toHaveBeenCalledWith(DROPI_PAYOUT_RECEIPT_SQL, ['12', 7]);
    expect(DROPI_PAYOUT_RECEIPT_SQL).toMatch(/ds\.id_user = \$2/);
    expect(DROPI_PAYOUT_RECEIPT_SQL).toMatch(/anulado_en IS NULL/);
  });

  it('si no es suyo, está anulado o no tiene comprobante: 404; un id inválido: 400', async () => {
    expect((await buildApp([]).app.request('/dropi/payouts/12/receipt')).status).toBe(404);
    expect((await buildApp([]).app.request('/dropi/payouts/abc/receipt')).status).toBe(400);
  });
});
