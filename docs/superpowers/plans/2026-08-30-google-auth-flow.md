# Google Auth Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `POST /auth/google`, `POST /auth/logout`, `GET /auth/me`, and the JWT+session middleware in `comercyo-back-users`, wiring the already-working frontend Google login to `supabase-tiendas`'s `users`/`sessions` tables.

**Architecture:** A stateless HS256 JWT (via `jose`) carries `{ id_user, sub, session_id }`. Every private request is checked twice: JWT signature/expiry, then a DB lookup of `sessions.token_hash` (sha256 of the raw JWT) so logout/revocation is instant. `google-auth-library` verifies the Google id_token; no hand-rolled crypto.

**Tech Stack:** Hono + `@hono/zod-openapi`, `pg`, `jose@5` (pinned — v6 dropped CommonJS `require` support and this project compiles to CommonJS), `google-auth-library`, `vitest` (new — no test runner exists in this repo yet).

**Spec:** `docs/superpowers/specs/2026-08-30-google-auth-flow-design.md`

## Global Constraints

- Auth always uses the single `supabase-tiendas` project via `TIENDAS_DB_REF` — never the request's `?ref=` query param.
- Session revocation is checked on **every** private request via a `sessions.token_hash` DB lookup, not JWT expiry alone.
- Session lifetime is `SESSION_TTL_DAYS` (default 14), used identically for both the JWT `exp` claim and `sessions.expires_at`.
- JWT payload is exactly `{ id_user, sub, session_id }` plus standard `iat`/`exp` — no email/name/avatar/roles.
- The `user.id` field returned to the frontend is `String(id_user)` — never Google's `sub`.
- Every error response uses `{ success: false, error, message? }`, matching the existing `tag-modules` routes.
- Pin `jose` to `5.10.0` exactly (not `^5`, not latest) — `jose@6` removed the CJS `require` export condition, and `require('jose')` will throw `ERR_REQUIRE_ESM` under this project's `"module": "CommonJS"` tsconfig.

---

## File Structure

- `src/config/db.ts` (modify) — export `requiredEnv`; add `getUsersDb()`.
- `src/utils/jwt.utils.ts` (new) — sign/verify the app JWT, hash tokens, compute session expiry.
- `src/utils/google.utils.ts` (new) — verify a Google id_token, return a normalized profile.
- `src/middlewares/auth.middleware.ts` (new) — `requireAuth()` Hono middleware: JWT + DB session check.
- `src/routes/auth.routes.ts` (new) — `registerAuthRoutes(apiV1)`: `POST /auth/google`, `POST /auth/logout`, `GET /auth/me`.
- `src/app.ts` (modify) — register the new routes.
- `.env.example` (modify) — document new env vars.

---

### Task 1: `getUsersDb()` in `src/config/db.ts` + test runner

**Files:**
- Modify: `src/config/db.ts`
- Create: `src/config/db.test.ts`
- Modify: `package.json` (add `vitest` devDependency + `test` script)

**Interfaces:**
- Produces: `export const requiredEnv: (name: string) => string`, `export const getUsersDb: () => Pool` (from `src/config/db.ts`), both used by every later task.

- [ ] **Step 1: Install the test runner**

```bash
npm install -D vitest@4.1.11
```

- [ ] **Step 2: Add the `test` script**

In `package.json`, inside `"scripts"`, add:

```json
"test": "vitest run"
```

- [ ] **Step 3: Write the failing test**

Create `src/config/db.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';

describe('getUsersDb', () => {
  beforeEach(() => {
    process.env.DATABASE_BASE = 'postgresql://postgres.';
    process.env.DATABASE_PASSWORD = 'secret';
    process.env.DATABASE_HOST = '@aws-0-test.pooler.supabase.com:6543/postgres';
  });

  it('throws when TIENDAS_DB_REF is not set', async () => {
    delete process.env.TIENDAS_DB_REF;
    const { getUsersDb } = await import('./db');
    expect(() => getUsersDb()).toThrow('Missing required environment variable: TIENDAS_DB_REF');
  });

  it('returns the same pool instance on repeated calls', async () => {
    process.env.TIENDAS_DB_REF = 'test-ref';
    const { getUsersDb } = await import('./db');
    const first = getUsersDb();
    const second = getUsersDb();
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- src/config/db.test.ts`
Expected: FAIL — `getUsersDb` is not exported from `./db`.

- [ ] **Step 5: Implement `getUsersDb`**

In `src/config/db.ts`, change the `requiredEnv` declaration (currently `const requiredEnv = ...`) to:

```ts
export const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};
```

Then add at the end of the file:

```ts
export const getUsersDb = () => getDb(requiredEnv('TIENDAS_DB_REF'));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/config/db.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config/db.ts src/config/db.test.ts
git commit -m "feat(auth): add test runner and getUsersDb()"
```

---

### Task 2: `src/utils/jwt.utils.ts`

**Files:**
- Create: `src/utils/jwt.utils.ts`
- Create: `src/utils/jwt.utils.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface SessionJwtPayload { id_user: number; sub: string; session_id: string }`
  - `export function signSessionJwt(payload: SessionJwtPayload): Promise<string>`
  - `export function verifySessionJwt(token: string): Promise<SessionJwtPayload | null>`
  - `export function hashToken(token: string): string`
  - `export function sessionExpiresAt(): Date`
  All consumed by `auth.middleware.ts` (Task 4) and `auth.routes.ts` (Tasks 5-6).

- [ ] **Step 1: Install `jose`**

```bash
npm install jose@5.10.0
```

- [ ] **Step 2: Write the failing tests**

Create `src/utils/jwt.utils.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { signSessionJwt, verifySessionJwt, hashToken } from './jwt.utils';

describe('jwt.utils', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long';
    process.env.SESSION_TTL_DAYS = '14';
  });

  it('signs and verifies a round-trip payload', async () => {
    const token = await signSessionJwt({ id_user: 42, sub: 'google-sub-1', session_id: 'session-1' });
    const payload = await verifySessionJwt(token);
    expect(payload).toEqual({ id_user: 42, sub: 'google-sub-1', session_id: 'session-1' });
  });

  it('returns null for a tampered token', async () => {
    const token = await signSessionJwt({ id_user: 42, sub: 'google-sub-1', session_id: 'session-1' });
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const payload = await verifySessionJwt(tampered);
    expect(payload).toBeNull();
  });

  it('returns null for an expired token', async () => {
    process.env.SESSION_TTL_DAYS = '-1';
    const token = await signSessionJwt({ id_user: 42, sub: 'google-sub-1', session_id: 'session-1' });
    const payload = await verifySessionJwt(token);
    expect(payload).toBeNull();
  });

  it('hashToken produces the sha256 hex digest of the input', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/utils/jwt.utils.test.ts`
Expected: FAIL — `./jwt.utils` does not exist.

- [ ] **Step 4: Implement `jwt.utils.ts`**

Create `src/utils/jwt.utils.ts`:

```ts
import { SignJWT, jwtVerify } from 'jose';
import { createHash } from 'crypto';
import { requiredEnv } from '../config/db';

export interface SessionJwtPayload {
  id_user: number;
  sub: string;
  session_id: string;
}

const getSecretKey = () => new TextEncoder().encode(requiredEnv('JWT_SECRET'));

const ttlSeconds = () => Number(process.env.SESSION_TTL_DAYS || 14) * 24 * 60 * 60;

export async function signSessionJwt(payload: SessionJwtPayload): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds();
  return new SignJWT({ id_user: payload.id_user, sub: payload.sub, session_id: payload.session_id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(getSecretKey());
}

export async function verifySessionJwt(token: string): Promise<SessionJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (
      typeof payload.id_user !== 'number' ||
      typeof payload.sub !== 'string' ||
      typeof payload.session_id !== 'string'
    ) {
      return null;
    }
    return { id_user: payload.id_user, sub: payload.sub, session_id: payload.session_id };
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionExpiresAt(): Date {
  return new Date(Date.now() + ttlSeconds() * 1000);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/utils/jwt.utils.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/utils/jwt.utils.ts src/utils/jwt.utils.test.ts
git commit -m "feat(auth): add jwt.utils (sign/verify/hash)"
```

---

### Task 3: `src/utils/google.utils.ts`

**Files:**
- Create: `src/utils/google.utils.ts`
- Create: `src/utils/google.utils.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface GoogleProfile { sub: string; email: string; email_verified: boolean; name: string; picture: string }`
  - `export function verifyGoogleCredential(credential: string): Promise<GoogleProfile | null>`
  Consumed by `auth.routes.ts` (Task 5).

- [ ] **Step 1: Install `google-auth-library`**

```bash
npm install google-auth-library@11.0.2
```

- [ ] **Step 2: Write the failing tests**

Create `src/utils/google.utils.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyIdToken = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken })),
}));

import { verifyGoogleCredential } from './google.utils';

describe('verifyGoogleCredential', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    verifyIdToken.mockReset();
  });

  it('returns the profile for a valid credential', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
      }),
    });

    const profile = await verifyGoogleCredential('fake-credential');

    expect(profile).toEqual({
      sub: 'google-sub-1',
      email: 'user@example.com',
      email_verified: true,
      name: 'Test User',
      picture: 'https://example.com/avatar.png',
    });
  });

  it('returns null when verification throws', async () => {
    verifyIdToken.mockRejectedValue(new Error('invalid token'));
    const profile = await verifyGoogleCredential('bad-credential');
    expect(profile).toBeNull();
  });

  it('returns null when the payload has no sub or email', async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'user@example.com' }) });
    const profile = await verifyGoogleCredential('fake-credential');
    expect(profile).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/utils/google.utils.test.ts`
Expected: FAIL — `./google.utils` does not exist.

- [ ] **Step 4: Implement `google.utils.ts`**

Create `src/utils/google.utils.ts`:

```ts
import { OAuth2Client } from 'google-auth-library';
import { requiredEnv } from '../config/db';

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture: string;
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile | null> {
  const clientId = requiredEnv('GOOGLE_CLIENT_ID');
  const client = new OAuth2Client(clientId);

  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email) {
      return null;
    }

    return {
      sub: payload.sub,
      email: payload.email,
      email_verified: payload.email_verified ?? false,
      name: payload.name ?? '',
      picture: payload.picture ?? '',
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/utils/google.utils.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/utils/google.utils.ts src/utils/google.utils.test.ts
git commit -m "feat(auth): add google.utils (verify Google id_token)"
```

---

### Task 4: `src/middlewares/auth.middleware.ts`

**Files:**
- Create: `src/middlewares/auth.middleware.ts`
- Create: `src/middlewares/auth.middleware.test.ts`

**Interfaces:**
- Consumes: `getUsersDb` (`../config/db`, Task 1), `verifySessionJwt`, `hashToken` (`../utils/jwt.utils`, Task 2).
- Produces: `export function requireAuth(): (c: Context, next: Next) => Promise<Response | void>`. On success it calls `c.set('id_user', number)` and `c.set('token_hash', string)`. Consumed by `auth.routes.ts` (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `src/middlewares/auth.middleware.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const query = vi.fn();
vi.mock('../config/db', () => ({
  getUsersDb: () => ({ query }),
}));

const verifySessionJwt = vi.fn();
vi.mock('../utils/jwt.utils', () => ({
  verifySessionJwt: (...args: unknown[]) => verifySessionJwt(...args),
  hashToken: (token: string) => `hashed:${token}`,
}));

import { requireAuth } from './auth.middleware';

function buildApp() {
  const app = new Hono();
  app.use('*', requireAuth());
  app.get('/', (c) => c.json({ id_user: c.get('id_user'), token_hash: c.get('token_hash') }));
  return app;
}

describe('requireAuth', () => {
  beforeEach(() => {
    query.mockReset();
    verifySessionJwt.mockReset();
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await buildApp().request('/');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid JWT', async () => {
    verifySessionJwt.mockResolvedValue(null);
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer bad-token' } });
    expect(res.status).toBe(401);
  });

  it('rejects when the session is missing from the database', async () => {
    verifySessionJwt.mockResolvedValue({ id_user: 1, sub: 'sub-1', session_id: 'session-1' });
    query.mockResolvedValue({ rows: [] });
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer good-token' } });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    verifySessionJwt.mockResolvedValue({ id_user: 1, sub: 'sub-1', session_id: 'session-1' });
    query.mockResolvedValue({
      rows: [{ id_user: 1, expires_at: new Date(Date.now() + 10000), revoked_at: new Date() }],
    });
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer good-token' } });
    expect(res.status).toBe(401);
  });

  it('rejects an expired session', async () => {
    verifySessionJwt.mockResolvedValue({ id_user: 1, sub: 'sub-1', session_id: 'session-1' });
    query.mockResolvedValue({
      rows: [{ id_user: 1, expires_at: new Date(Date.now() - 10000), revoked_at: null }],
    });
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer good-token' } });
    expect(res.status).toBe(401);
  });

  it('allows a valid session through and sets context', async () => {
    verifySessionJwt.mockResolvedValue({ id_user: 7, sub: 'sub-1', session_id: 'session-1' });
    query.mockResolvedValue({
      rows: [{ id_user: 7, expires_at: new Date(Date.now() + 10000), revoked_at: null }],
    });
    const res = await buildApp().request('/', { headers: { Authorization: 'Bearer good-token' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_user: 7, token_hash: 'hashed:good-token' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/middlewares/auth.middleware.test.ts`
Expected: FAIL — `./auth.middleware` does not exist.

- [ ] **Step 3: Implement `auth.middleware.ts`**

Create `src/middlewares/auth.middleware.ts`:

```ts
import type { Context, Next } from 'hono';
import { getUsersDb } from '../config/db';
import { verifySessionJwt, hashToken } from '../utils/jwt.utils';

export function requireAuth() {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: 'Unauthorized', message: 'Missing bearer token' }, 401);
    }

    const token = authHeader.slice(7).trim();
    const payload = await verifySessionJwt(token);
    if (!payload) {
      return c.json({ success: false, error: 'Unauthorized', message: 'Invalid or expired token' }, 401);
    }

    const tokenHash = hashToken(token);
    const db = getUsersDb();
    const result = await db.query(
      `SELECT id_user, expires_at, revoked_at FROM sessions WHERE token_hash = $1`,
      [tokenHash]
    );

    const session = result.rows[0];
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      return c.json({ success: false, error: 'Unauthorized', message: 'Session not found or expired' }, 401);
    }

    c.set('id_user', session.id_user);
    c.set('token_hash', tokenHash);
    await next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/middlewares/auth.middleware.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/middlewares/auth.middleware.ts src/middlewares/auth.middleware.test.ts
git commit -m "feat(auth): add requireAuth middleware"
```

---

### Task 5: `POST /auth/google` in `src/routes/auth.routes.ts`

**Files:**
- Create: `src/routes/auth.routes.ts`
- Create: `src/routes/auth.routes.test.ts`

**Interfaces:**
- Consumes: `getUsersDb` (Task 1), `verifyGoogleCredential` (Task 3), `signSessionJwt`, `hashToken`, `sessionExpiresAt` (Task 2).
- Produces: `export const registerAuthRoutes = (apiV1: OpenAPIHono) => void`, registering `POST /auth/google` in this task (`POST /auth/logout` and `GET /auth/me` are added in Task 6, in the same file). Consumed by `app.ts` (Task 7).

- [ ] **Step 1: Write the failing tests**

Create `src/routes/auth.routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

const query = vi.fn();
vi.mock('../config/db', () => ({
  getUsersDb: () => ({ query }),
}));

const verifyGoogleCredential = vi.fn();
vi.mock('../utils/google.utils', () => ({
  verifyGoogleCredential: (...args: unknown[]) => verifyGoogleCredential(...args),
}));

const signSessionJwt = vi.fn();
const hashToken = vi.fn();
const sessionExpiresAt = vi.fn();
vi.mock('../utils/jwt.utils', () => ({
  signSessionJwt: (...args: unknown[]) => signSessionJwt(...args),
  hashToken: (...args: unknown[]) => hashToken(...args),
  sessionExpiresAt: (...args: unknown[]) => sessionExpiresAt(...args),
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => 'fixed-session-id' };
});

import { registerAuthRoutes } from './auth.routes';

function buildApp() {
  const apiV1 = new OpenAPIHono();
  registerAuthRoutes(apiV1);
  const app = new OpenAPIHono();
  app.route('/api/v1', apiV1);
  return app;
}

describe('POST /auth/google', () => {
  beforeEach(() => {
    query.mockReset();
    verifyGoogleCredential.mockReset();
    signSessionJwt.mockReset();
    hashToken.mockReset();
    sessionExpiresAt.mockReset();
  });

  it('rejects a missing credential', async () => {
    const res = await buildApp().request('/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid Google credential', async () => {
    verifyGoogleCredential.mockResolvedValue(null);
    const res = await buildApp().request('/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: 'bad-credential' }),
    });
    expect(res.status).toBe(401);
  });

  it('logs in a valid Google user, upserts, and creates a session', async () => {
    verifyGoogleCredential.mockResolvedValue({
      sub: 'google-sub-1',
      email: 'user@example.com',
      email_verified: true,
      name: 'Test User',
      picture: 'https://example.com/avatar.png',
    });
    query.mockResolvedValueOnce({
      rows: [
        { id_user: 42, email: 'user@example.com', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] });
    signSessionJwt.mockResolvedValue('signed.jwt.token');
    hashToken.mockReturnValue('hashed-token');
    sessionExpiresAt.mockReturnValue(new Date('2026-09-13T00:00:00.000Z'));

    const res = await buildApp().request('/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: 'good-credential' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jwt: 'signed.jwt.token',
      user: { id: '42', email: 'user@example.com', name: 'Test User', avatar: 'https://example.com/avatar.png' },
    });
    expect(signSessionJwt).toHaveBeenCalledWith({ id_user: 42, sub: 'google-sub-1', session_id: 'fixed-session-id' });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO sessions'),
      ['fixed-session-id', 42, 'hashed-token', new Date('2026-09-13T00:00:00.000Z'), null, null]
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/routes/auth.routes.test.ts`
Expected: FAIL — `./auth.routes` does not exist.

- [ ] **Step 3: Implement `auth.routes.ts` (login route only for now)**

Create `src/routes/auth.routes.ts`:

```ts
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { randomUUID } from 'crypto';
import { getUsersDb } from '../config/db';
import { requireAuth } from '../middlewares/auth.middleware';
import { verifyGoogleCredential } from '../utils/google.utils';
import { hashToken, sessionExpiresAt, signSessionJwt } from '../utils/jwt.utils';

const ErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  message: z.string().optional(),
});

const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatar: z.string(),
});

const GoogleLoginBodySchema = z.object({
  credential: z.string().min(1),
});

const LoginResponseSchema = z.object({
  jwt: z.string(),
  user: UserSchema,
});

const parseJson = async (c: Context) => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

type UserRow = { id_user: number; email: string; name: string | null; avatar_url: string | null };

const toUser = (row: UserRow) => ({
  id: String(row.id_user),
  email: row.email,
  name: row.name ?? '',
  avatar: row.avatar_url ?? '',
});

export const registerAuthRoutes = (apiV1: any) => {
  const googleLoginRoute = createRoute({
    method: 'post',
    path: '/auth/google',
    request: {
      body: {
        content: { 'application/json': { schema: GoogleLoginBodySchema } },
      },
    },
    responses: {
      200: { description: 'Login successful', content: { 'application/json': { schema: LoginResponseSchema } } },
      400: { description: 'Bad request', content: { 'application/json': { schema: ErrorSchema } } },
      401: { description: 'Invalid Google credential', content: { 'application/json': { schema: ErrorSchema } } },
    },
    tags: ['Auth'],
  });

  apiV1.openapi(googleLoginRoute, async (c: Context) => {
    const body = await parseJson(c);
    const parsed = GoogleLoginBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Bad Request', message: parsed.error.issues[0]?.message },
        400
      );
    }

    const profile = await verifyGoogleCredential(parsed.data.credential);
    if (!profile) {
      return c.json({ success: false, error: 'Unauthorized', message: 'Invalid Google credential' }, 401);
    }

    const db = getUsersDb();
    const upsert = await db.query(
      `INSERT INTO users (sub, email, email_verified, name, avatar_url, last_in)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (sub) DO UPDATE SET
         email = EXCLUDED.email,
         email_verified = EXCLUDED.email_verified,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         last_in = now(),
         updated_at = now()
       RETURNING id_user, email, name, avatar_url`,
      [profile.sub, profile.email, profile.email_verified, profile.name, profile.picture]
    );

    const userRow: UserRow = upsert.rows[0];
    const sessionId = randomUUID();
    const jwt = await signSessionJwt({ id_user: userRow.id_user, sub: profile.sub, session_id: sessionId });
    const tokenHash = hashToken(jwt);
    const userAgent = c.req.header('user-agent') ?? null;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    await db.query(
      `INSERT INTO sessions (id, id_user, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userRow.id_user, tokenHash, sessionExpiresAt(), userAgent, ip]
    );

    return c.json({ jwt, user: toUser(userRow) }, 200);
  });
};
```

(`requireAuth` is imported but unused until Task 6 — that's expected and resolved in the next task.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/routes/auth.routes.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts src/routes/auth.routes.test.ts
git commit -m "feat(auth): add POST /auth/google"
```

---

### Task 6: `POST /auth/logout` and `GET /auth/me`

**Files:**
- Modify: `src/routes/auth.routes.ts`
- Modify: `src/routes/auth.routes.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task 4, now actually wired in), `getUsersDb` (Task 1).
- Produces: `registerAuthRoutes` now also registers `POST /auth/logout` and `GET /auth/me`. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `src/routes/auth.routes.test.ts` (add this import near the top, alongside the existing mocks, and the two `describe` blocks below at the end of the file):

```ts
vi.mock('../middlewares/auth.middleware', () => ({
  requireAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('id_user', 42);
    c.set('token_hash', 'hashed-token');
    await next();
  },
}));
```

(Place this `vi.mock` call with the other `vi.mock` calls at the top of the file — `vi.mock` is hoisted by Vitest regardless of position, but keeping mocks grouped together matches the rest of the file's style.)

```ts
describe('POST /auth/logout', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('revokes the current session', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await buildApp().request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sessions SET revoked_at = now()'),
      ['hashed-token']
    );
  });
});

describe('GET /auth/me', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns the current user', async () => {
    query.mockResolvedValue({
      rowCount: 1,
      rows: [{ id_user: 42, email: 'user@example.com', name: 'Test User', avatar_url: 'https://example.com/avatar.png' }],
    });
    const res = await buildApp().request('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { id: '42', email: 'user@example.com', name: 'Test User', avatar: 'https://example.com/avatar.png' },
    });
  });

  it('returns 404 when the user row is gone', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await buildApp().request('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/routes/auth.routes.test.ts`
Expected: FAIL — `/auth/logout` and `/auth/me` return 404 (not registered yet).

- [ ] **Step 3: Implement the two routes**

In `src/routes/auth.routes.ts`, add these two schemas near `LoginResponseSchema`:

```ts
const MeResponseSchema = z.object({
  success: z.literal(true),
  data: UserSchema,
});
```

Inside `registerAuthRoutes`, after `googleLoginRoute` and before the `apiV1.openapi(googleLoginRoute, ...)` call, add:

```ts
  const logoutRoute = createRoute({
    method: 'post',
    path: '/auth/logout',
    responses: {
      200: {
        description: 'Logged out',
        content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } },
      },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
    },
    tags: ['Auth'],
  });

  const meRoute = createRoute({
    method: 'get',
    path: '/auth/me',
    responses: {
      200: { description: 'Current user', content: { 'application/json': { schema: MeResponseSchema } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'User not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
    tags: ['Auth'],
  });

  apiV1.use('/auth/logout', requireAuth());
  apiV1.use('/auth/me', requireAuth());
```

And after the existing `apiV1.openapi(googleLoginRoute, ...)` block, add:

```ts
  apiV1.openapi(logoutRoute, async (c: Context) => {
    const tokenHash = c.get('token_hash');
    const db = getUsersDb();
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]);
    return c.json({ success: true }, 200);
  });

  apiV1.openapi(meRoute, async (c: Context) => {
    const idUser = c.get('id_user');
    const db = getUsersDb();
    const result = await db.query(
      `SELECT id_user, email, name, avatar_url FROM users WHERE id_user = $1`,
      [idUser]
    );

    if (!result.rowCount) {
      return c.json({ success: false, error: 'Not Found', message: 'User not found' }, 404);
    }

    return c.json({ success: true, data: toUser(result.rows[0]) }, 200);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/routes/auth.routes.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.ts src/routes/auth.routes.test.ts
git commit -m "feat(auth): add POST /auth/logout and GET /auth/me"
```

---

### Task 7: Wire routes into the app + env docs

**Files:**
- Modify: `src/app.ts`
- Modify: `.env.example`
- Create: `src/app.test.ts`

**Interfaces:**
- Consumes: `registerAuthRoutes` (`./routes/auth.routes`, Tasks 5-6).
- Produces: nothing new — this is the final wiring task.

- [ ] **Step 1: Write the failing test**

Create `src/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import app from './app';

describe('app wiring', () => {
  it('exposes the auth routes in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/auth/google', '/auth/logout', '/auth/me'])
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app.test.ts`
Expected: FAIL — `doc.paths` does not contain the `/auth/*` entries.

- [ ] **Step 3: Register the routes**

In `src/app.ts`, add the import near the existing `registerTagModulesRoutes` import:

```ts
import { registerAuthRoutes } from './routes/auth.routes';
```

And call it alongside `registerTagModulesRoutes(apiV1);`:

```ts
registerAuthRoutes(apiV1);
registerTagModulesRoutes(apiV1);
```

- [ ] **Step 4: Document the new env vars**

Append to `.env.example`:

```
# Auth Configuration
GOOGLE_CLIENT_ID=            # must equal the frontend's VITE_GOOGLE_CLIENT_ID (the aud to verify)
JWT_SECRET=                  # long random secret, HS256, different per environment
TIENDAS_DB_REF=jzjgdcnlvfosvnjhssiv   # supabase-tiendas project ref
SESSION_TTL_DAYS=14
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/app.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests across all tasks)

- [ ] **Step 7: Type-check**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/app.ts src/app.test.ts .env.example
git commit -m "feat(auth): wire auth routes into the app"
```

---

## Explicitly out of scope (matches the spec)

- Refresh tokens / short-lived access tokens.
- Roles/permissions in the JWT.
- Frontend changes (calling `/auth/me` on boot, persisting `user` to `localStorage`).
- Multi-tenant auth.
- Handling `users.is_blocked` at login — the column exists in the schema but blocking behavior was never discussed in the spec; flagging here rather than silently adding a 403 path that wasn't approved.

## Manual verification after implementation

Automated tests use mocked DB/Google calls throughout — nothing here has touched a real Supabase project. Before treating this as done end-to-end, manually verify against a real (branch/staging) `supabase-tiendas`:

1. Set real `GOOGLE_CLIENT_ID`, `JWT_SECRET`, `TIENDAS_DB_REF`, `DATABASE_BASE`/`DATABASE_PASSWORD`/`DATABASE_HOST` in `.env`.
2. Run `npm run dev`, get a real Google `credential` from the frontend (or Google's OAuth Playground), `POST` it to `/api/v1/auth/google` — confirm a row appears in `users` and `sessions`.
3. Call `/api/v1/auth/me` with the returned `jwt` — confirm it returns the same user.
4. Call `/api/v1/auth/logout`, then repeat the `/api/v1/auth/me` call with the same `jwt` — confirm it now returns `401`.
5. Confirm `sessions.revoked_at` is set in the DB after logout.
