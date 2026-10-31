import type { Context, Next } from 'hono';
import { verifyAccessToken } from '../utils/jwt.utils';

export type AuthVariables = {
  id_user: number;
};

export function requireAuth() {
  return async (c: Context<{ Variables: AuthVariables }>, next: Next) => {
    const authHeader = c.req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: 'Unauthorized', message: 'Missing bearer token' }, 401);
    }

    const token = authHeader.slice(7).trim();
    const payload = await verifyAccessToken(token);
    if (!payload) {
      return c.json({ success: false, error: 'Unauthorized', message: 'Invalid or expired token' }, 401);
    }

    c.set('id_user', payload.id_user);
    await next();
  };
}
