import type { Context, Next } from 'hono';
import type { AuthVariables } from './auth.middleware';
import { getUsersDb, type Queryable } from '../config/db';
import { findAccessibleOrderProject } from '../services/order-access.repository';

export type OrderAccessVariables = AuthVariables & {
  id_own_project: number;
};

export const ORDER_ID_PATTERN = /^[1-9]\d{0,18}$/;

// Must run after requireAuth(). Mounted on
// '/purchase-orders/:orderId/payments/*' so the orderId param is available.
//
// A purchase order the user cannot access answers 404, exactly like one that
// does not exist, so callers cannot probe which order ids exist in other
// projects.
export function requireOrderAccess(getDb: () => Queryable = getUsersDb) {
  return async (c: Context<{ Variables: OrderAccessVariables }>, next: Next) => {
    const orderId = c.req.param('orderId') ?? '';
    if (!ORDER_ID_PATTERN.test(orderId)) {
      return c.json(
        { success: false, error: 'Bad Request', message: 'orderId must be a positive integer' },
        400
      );
    }

    const idOwnProject = await findAccessibleOrderProject(getDb(), orderId, c.get('id_user'));
    if (idOwnProject === null) {
      return c.json(
        { success: false, error: 'Not Found', message: 'Purchase order not found' },
        404
      );
    }

    c.set('id_own_project', idOwnProject);
    await next();
  };
}
