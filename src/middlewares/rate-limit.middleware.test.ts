import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimiter } from './rate-limit.middleware';

function buildApp(max: number, windowMs: number) {
  const app = new Hono();
  app.use('*', rateLimiter({ max, windowMs }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

const requestFrom = (app: Hono, ip: string) =>
  app.request('/ping', { headers: { 'x-forwarded-for': ip } });

describe('rateLimiter middleware', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the configured max within the window', async () => {
    const app = buildApp(3, 60_000);

    const res1 = await requestFrom(app, '1.1.1.1');
    const res2 = await requestFrom(app, '1.1.1.1');
    const res3 = await requestFrom(app, '1.1.1.1');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
  });

  it('blocks the request that exceeds max with a 429 and a Retry-After header', async () => {
    const app = buildApp(2, 60_000);

    await requestFrom(app, '2.2.2.2');
    await requestFrom(app, '2.2.2.2');
    const blocked = await requestFrom(app, '2.2.2.2');

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = await blocked.json();
    expect(body).toMatchObject({ success: false, error: 'Too Many Requests' });
  });

  it('tracks separate counters per client so one IP cannot exhaust another IP\'s quota', async () => {
    const app = buildApp(1, 60_000);

    const first = await requestFrom(app, '3.3.3.3');
    const second = await requestFrom(app, '4.4.4.4');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('resets the counter once the window has elapsed', async () => {
    vi.useFakeTimers();
    const app = buildApp(1, 1_000);

    const first = await requestFrom(app, '5.5.5.5');
    expect(first.status).toBe(200);

    const blocked = await requestFrom(app, '5.5.5.5');
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(1_001);

    const afterWindow = await requestFrom(app, '5.5.5.5');
    expect(afterWindow.status).toBe(200);
  });
});
