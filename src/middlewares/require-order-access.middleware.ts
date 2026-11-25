import type { Context, Next } from 'hono';
import type { AuthVariables } from './auth.middleware';
import { getUsersDb, type Queryable } from '../config/db';
import { findAccessibleOrderProject } from '../services/order-access.repository';
import type { OrderKind } from '../config/r2';
import { mensajeSinPermiso, permisoFaltante, type Acceso } from '../lib/permisos';
import { REGLAS_POR_TIPO } from './permisos.reglas';

export type OrderAccessVariables = AuthVariables & {
  id_own_project: number;
  /** Dueño o permisos del miembro del equipo (permisos_en_proyecto). */
  acceso: Acceso;
};

export const ORDER_ID_PATTERN = /^[1-9]\d{0,18}$/;

// Must run after requireAuth(). Mounted on
// '/purchase-orders/:orderId/payments/*' (kind 'purchase') and
// '/sales-orders/:orderId/payments/*' (kind 'sales') so the orderId param is available.
//
// A purchase order the user cannot access answers 404, exactly like one that
// does not exist, so callers cannot probe which order ids exist in other
// projects.
const NOT_FOUND_MESSAGE: Record<OrderKind, string> = {
  purchase: 'Purchase order not found',
  sales: 'Sales order not found',
};

export function requireOrderAccess(getDb: () => Queryable = getUsersDb, kind: OrderKind = 'purchase') {
  return async (c: Context<{ Variables: OrderAccessVariables }>, next: Next) => {
    const orderId = c.req.param('orderId') ?? '';
    if (!ORDER_ID_PATTERN.test(orderId)) {
      return c.json(
        { success: false, error: 'Bad Request', message: 'orderId must be a positive integer' },
        400
      );
    }

    const pedido = await findAccessibleOrderProject(getDb(), orderId, c.get('id_user'), kind);
    if (pedido === null) {
      return c.json(
        { success: false, error: 'Not Found', message: NOT_FOUND_MESSAGE[kind] },
        404
      );
    }

    // Equipo de la tienda: el dueño puede todo; un miembro, lo que digan sus permisos.
    const falta = permisoFaltante(pedido.acceso, REGLAS_POR_TIPO[kind], c.req.method, c.req.path);
    if (falta) {
      return c.json({ success: false, error: 'Forbidden', message: mensajeSinPermiso(falta) }, 403);
    }

    c.set('id_own_project', pedido.id_own_project);
    c.set('acceso', pedido.acceso);
    await next();
  };
}
