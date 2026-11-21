import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { buildSignedUrl, getSignedUrlTtlSeconds } from '../config/r2';
import { getUsersDb, type Queryable } from '../config/db';
import type { AuthVariables } from '../middlewares/auth.middleware';

// 2026-11-21: el dropshipper ve el comprobante de un pago que le hicieron.
// Cuando la tienda le adjunta el comprobante al gasto "Comisión Dropi" de la
// factura, comercyo-back-dropi registra el pago (dropi_payouts) con esa misma
// foto (comprobante_key, carpeta sales-orders/{pedido}/ del bucket privado).
// Solo el dropshipper dueño del pago, y solo si el pago está vigente.

type AuthContext = Context<{ Variables: AuthVariables }>;

export const DROPI_PAYOUT_RECEIPT_SQL = `
  SELECT py.id_sales_order::text AS order_id, py.comprobante_key::text AS key
    FROM dropi_payouts py
    JOIN dropshippers ds ON ds.id_dropshipper = py.id_dropshipper
   WHERE py.id_payout = $1::bigint
     AND ds.id_user = $2
     AND py.anulado_en IS NULL
     AND py.comprobante_key IS NOT NULL
     AND py.id_sales_order IS NOT NULL
   LIMIT 1`;

const ParamsSchema = z.object({
  payoutId: z.string().regex(/^[1-9][0-9]{0,17}$/, 'payoutId must be a positive integer').openapi({ param: { name: 'payoutId', in: 'path' } }),
});

const ResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    url: z.string().openapi({ description: 'URL firmada temporal (el bucket es privado)' }),
    expiresIn: z.number().int(),
  }),
});

const ErrorSchema = z.object({ success: z.literal(false), error: z.string(), message: z.string().optional() });

export const registerDropiPayoutReceiptRoute = (apiV1: any, getDb: () => Queryable = getUsersDb) => {
  const route = createRoute({
    method: 'get',
    path: '/dropi/payouts/{payoutId}/receipt',
    summary: 'Comprobante de un pago al dropshipper (solo el dropshipper del pago)',
    request: { params: ParamsSchema },
    responses: {
      200: { description: 'URL firmada', content: { 'application/json': { schema: ResponseSchema } } },
      401: { description: 'Sin sesión', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'No existe, no es suyo o no tiene comprobante', content: { 'application/json': { schema: ErrorSchema } } },
    },
    security: [{ Bearer: [] }],
    tags: ['Dropi'],
  });

  apiV1.openapi(route, async (c: AuthContext) => {
    const { rows } = await getDb().query(DROPI_PAYOUT_RECEIPT_SQL, [c.req.param('payoutId'), c.get('id_user')]);
    const row = rows[0];
    if (!row) return c.json({ success: false as const, error: 'Not Found', message: 'Comprobante no encontrado' }, 404);
    return c.json({ success: true as const, data: { url: await buildSignedUrl(row.order_id, row.key, 'sales'), expiresIn: getSignedUrlTtlSeconds() } }, 200);
  });
};
