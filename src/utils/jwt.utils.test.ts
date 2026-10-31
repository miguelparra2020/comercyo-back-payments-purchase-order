import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { verifyAccessToken } from './jwt.utils';

const SECRET = 'test-secret-at-least-32-characters-long';
const AUDIENCE = 'comercyo-internal';

async function signTestToken(
  payload: Record<string, unknown>,
  expiresInSeconds: number,
  audience?: string
) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp);
  if (audience) {
    builder = builder.setAudience(audience);
  }
  return builder.sign(new TextEncoder().encode(SECRET));
}

describe('jwt.utils', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    process.env.JWT_AUDIENCE = AUDIENCE;
  });

  it('verifies a validly signed token and returns its payload', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, 3600, AUDIENCE);
    const payload = await verifyAccessToken(token);
    expect(payload).toEqual({ id_user: 42, session_id: 'session-1' });
  });

  it('returns null for a tampered token', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, 3600, AUDIENCE);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const payload = await verifyAccessToken(tampered);
    expect(payload).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, -10, AUDIENCE);
    const payload = await verifyAccessToken(token);
    expect(payload).toBeNull();
  });

  it('returns null when the audience does not match', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, 3600, 'some-other-audience');
    const payload = await verifyAccessToken(token);
    expect(payload).toBeNull();
  });

  it('returns null when the token has no audience at all', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, 3600, undefined);
    const payload = await verifyAccessToken(token);
    expect(payload).toBeNull();
  });

  it('returns null when the payload is missing required fields', async () => {
    const token = await signTestToken({ id_user: 42 }, 3600, AUDIENCE);
    const payload = await verifyAccessToken(token);
    expect(payload).toBeNull();
  });
});
