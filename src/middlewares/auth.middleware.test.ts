import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const verifyAccessToken = vi.fn();
vi.mock('../utils/jwt.utils', () => ({
  verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
}));

import { requireAuth, type AuthVariables } from './auth.middleware';

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', requireAuth());
  app.get('/', (c) => c.json({ id_user: c.get('id_user') }));
  return app;
}

describe('requireAuth', () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await buildApp().request('/');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid or expired JWT', async () => {
    verifyAccessToken.mockResolvedValue(null);
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer bad-token' } });
    expect(res.status).toBe(401);
  });

  it('allows a valid token through and sets id_user, with no DB lookup', async () => {
    verifyAccessToken.mockResolvedValue({ id_user: 7, session_id: 'session-1' });
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer good-token' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_user: 7 });
  });
});
