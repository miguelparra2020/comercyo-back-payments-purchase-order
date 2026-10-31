import type { Context, Next } from 'hono';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyGenerator?: (c: Context) => string;
};

type Hit = { count: number; resetAt: number };

const defaultKeyGenerator = (c: Context): string => {
  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  return c.req.header('x-real-ip') ?? 'unknown';
};

// In-memory fixed-window limiter. Best-effort abuse mitigation only: on
// serverless (Vercel) each warm instance keeps its own counters, so it does
// not enforce a single global limit across concurrent instances or survive
// cold starts. It still blocks a script hammering one warm instance.
export function rateLimiter({ windowMs, max, keyGenerator = defaultKeyGenerator }: RateLimitOptions) {
  const hits = new Map<string, Hit>();

  return async (c: Context, next: Next) => {
    const key = keyGenerator(c);
    const now = Date.now();

    let hit = hits.get(key);
    if (!hit || hit.resetAt <= now) {
      hit = { count: 0, resetAt: now + windowMs };
      hits.set(key, hit);
    }
    hit.count += 1;

    if (hit.count > max) {
      const retryAfterSeconds = Math.ceil((hit.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        { success: false, error: 'Too Many Requests', message: 'Rate limit exceeded, try again later' },
        429
      );
    }

    await next();
  };
}
