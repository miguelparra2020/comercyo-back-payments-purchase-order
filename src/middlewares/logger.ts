import { Context, Next } from 'hono';

export function logger() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const method = c.req.method;
    const url = c.req.url;
    const status = c.res.status || 200;
  };
}
