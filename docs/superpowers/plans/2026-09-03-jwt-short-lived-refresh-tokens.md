# JWT hardening (resource server side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `comercyo-back-company-projects` validate access tokens issued by `comercyo-back-users` statelessly — signature + expiry + `aud` only, zero DB calls in the auth path — replacing the current per-request `sessions` lookup against the shared Supabase DB.

**Architecture:** `jwt.utils.ts` verifies with `jose`, adding an `aud` check. `auth.middleware.ts` drops its `getUsersDb()`/`sessions` query entirely. `own-projects.routes.ts`'s five handlers need `email` (a real query filter, `created_by_email`), which the JWT no longer carries and `requireAuth()` no longer looks up — a new, separately-testable `resolveEmail()` middleware fetches it by `id_user` and is chained only on `/own-projects` routes, so the route file and its existing test suite are untouched.

**Tech Stack:** TypeScript, Hono 4.13.5, `@hono/zod-openapi`, `jose` 5.10.0, `pg`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-jwt-short-lived-refresh-tokens-design.md`

## Global Constraints

- `JWT_AUDIENCE` must be the exact same string as in `comercyo-back-users` — operational constraint, not enforced by code.
- Access token payload verified here is `{ id_user, session_id }` plus standard `aud`/`iat`/`exp` — this repo never reads `session_id` for anything (it has no logout/session-revocation endpoints), only `id_user`.
- This repo issues nothing and never touches `refresh_tokens` — only `comercyo-back-users` does.
- The DDL for `refresh_tokens`/dropped `sessions` columns is a separate prompt, run after both backend plans. Every task here is verified with mocked `db.query`, never a real database.
- Existing error shape `{ success: false, error, message? }` and existing test conventions (Vitest, `vi.mock`, `app.request(...)`) are unchanged.

---

### Task 1: `jwt.utils.ts` — verify `aud`, drop unused `hashToken`

**Files:**
- Modify: `src/utils/jwt.utils.ts`
- Modify: `src/utils/jwt.utils.test.ts`

**Interfaces:**
- Produces: `AccessTokenPayload = { id_user: number; session_id: string }`; `verifyAccessToken(token: string): Promise<AccessTokenPayload | null>`. Task 2 imports this.
- Consumes: env vars `JWT_SECRET`, `JWT_AUDIENCE`; `requiredEnv` from `../config/db`.
- Removed: `hashToken` — was only used by the old DB-checked `auth.middleware.ts`; nothing else in this repo hashes tokens (only `comercyo-back-users` mints/hashes refresh tokens).

- [ ] **Step 1: Replace the test file**

```typescript
// src/utils/jwt.utils.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { verifyAccessToken } from './jwt.utils';

const SECRET = 'test-secret-at-least-32-characters-long';
const AUDIENCE = 'comercyo-internal';

async function signTestToken(
  payload: Record<string, unknown>,
  expiresInSeconds: number,
  audience: string | undefined = AUDIENCE
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
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, 3600);
    const payload = await verifyAccessToken(token);
    expect(payload).toEqual({ id_user: 42, session_id: 'session-1' });
  });

  it('returns null for a tampered token', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, 3600);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const payload = await verifyAccessToken(tampered);
    expect(payload).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const token = await signTestToken({ id_user: 42, session_id: 'session-1' }, -10);
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
    const token = await signTestToken({ id_user: 42 }, 3600);
    const payload = await verifyAccessToken(token);
    expect(payload).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- jwt.utils`
Expected: FAIL — `verifyAccessToken` isn't exported yet; the current `verifySessionJwt` doesn't check `aud`.

- [ ] **Step 3: Replace the implementation**

```typescript
// src/utils/jwt.utils.ts
import { jwtVerify } from 'jose';
import { requiredEnv } from '../config/db';

export interface AccessTokenPayload {
  id_user: number;
  session_id: string;
}

const getSecretKey = () => new TextEncoder().encode(requiredEnv('JWT_SECRET'));
const getAudience = () => requiredEnv('JWT_AUDIENCE');

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { audience: getAudience() });
    if (typeof payload.id_user !== 'number' || typeof payload.session_id !== 'string') {
      return null;
    }
    return { id_user: payload.id_user, session_id: payload.session_id };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm test -- jwt.utils`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/jwt.utils.ts src/utils/jwt.utils.test.ts
git commit -m "feat: verify access tokens by audience, drop unused hashToken"
```

---

### Task 2: `auth.middleware.ts` — drop the `sessions` DB lookup entirely

**Files:**
- Modify: `src/middlewares/auth.middleware.ts`
- Modify: `src/middlewares/auth.middleware.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken` from Task 1 (`../utils/jwt.utils`).
- Produces: `AuthVariables = { id_user: number; email: string }` (drops `token_hash`; keeps `email` as a key because Task 3's `resolveEmail()` middleware sets it later in the same request chain — `requireAuth()` itself no longer sets it). `requireAuth(): (c, next) => Promise<Response | void>`.

- [ ] **Step 1: Replace the test file**

```typescript
// src/middlewares/auth.middleware.test.ts
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- middlewares/auth.middleware`
Expected: FAIL — old middleware still calls `getUsersDb()`/`hashToken` and sets `token_hash`/`email` itself.

- [ ] **Step 3: Replace the implementation**

```typescript
// src/middlewares/auth.middleware.ts
import type { Context, Next } from 'hono';
import { verifyAccessToken } from '../utils/jwt.utils';

export type AuthVariables = {
  id_user: number;
  email: string;
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
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm test -- middlewares/auth.middleware`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/middlewares/auth.middleware.ts src/middlewares/auth.middleware.test.ts
git commit -m "feat: make requireAuth stateless (signature+exp+aud only, no DB)"
```

---

### Task 3: `resolveEmail()` middleware + wire into `app.ts` + fix `own-projects.routes.test.ts` fixture

**Files:**
- Create: `src/middlewares/resolve-email.middleware.ts`
- Create: `src/middlewares/resolve-email.middleware.test.ts`
- Modify: `src/app.ts:1-9,72-77` (imports and route wiring)
- Modify: `src/routes/own-projects.routes.test.ts:17-22` (drop the now-nonexistent `token_hash` context key)

**Interfaces:**
- Consumes: `AuthVariables`, `id_user` (Task 2, via `c.get('id_user')`); `getUsersDb` from `../config/db`.
- Produces: `resolveEmail(): (c, next) => Promise<Response | void>` — sets `c.set('email', ...)`. `own-projects.routes.ts` already reads `c.get('email')` and needs zero changes; it just needs this middleware chained in front of it in `app.ts`.

- [ ] **Step 1: Write the new middleware's test file**

```typescript
// src/middlewares/resolve-email.middleware.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const query = vi.fn();
vi.mock('../config/db', () => ({
  getUsersDb: () => ({ query }),
}));

import { resolveEmail } from './resolve-email.middleware';
import type { AuthVariables } from './auth.middleware';

function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('id_user', 7);
    await next();
  });
  app.use('*', resolveEmail());
  app.get('/', (c) => c.json({ email: c.get('email') }));
  return app;
}

describe('resolveEmail', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('sets email in context from the users table, by id_user', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ email: 'owner@example.com' }] });
    const res = await buildApp().request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'owner@example.com' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM users'), [7]);
  });

  it('rejects with 401 when the user row is gone', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await buildApp().request('/');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -- resolve-email`
Expected: FAIL — `./resolve-email.middleware` doesn't exist yet.

- [ ] **Step 3: Write the middleware**

```typescript
// src/middlewares/resolve-email.middleware.ts
import type { Context, Next } from 'hono';
import { getUsersDb } from '../config/db';
import type { AuthVariables } from './auth.middleware';

export function resolveEmail() {
  return async (c: Context<{ Variables: AuthVariables }>, next: Next) => {
    const idUser = c.get('id_user');
    const db = getUsersDb();
    const result = await db.query(`SELECT email FROM users WHERE id_user = $1`, [idUser]);
    if (!result.rowCount) {
      return c.json({ success: false, error: 'Unauthorized', message: 'User not found' }, 401);
    }
    c.set('email', result.rows[0].email);
    await next();
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm test -- resolve-email`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire `resolveEmail()` into `app.ts`**

Add the import next to the other middleware imports:

```typescript
import { resolveEmail } from './middlewares/resolve-email.middleware';
```

Change the `/own-projects` middleware chain from:

```typescript
apiV1.use('/own-projects', requireAuth());
apiV1.use('/own-projects/*', requireAuth());
registerOwnProjectsRoutes(apiV1);
```

to:

```typescript
apiV1.use('/own-projects', requireAuth());
apiV1.use('/own-projects/*', requireAuth());
apiV1.use('/own-projects', resolveEmail());
apiV1.use('/own-projects/*', resolveEmail());
registerOwnProjectsRoutes(apiV1);
```

- [ ] **Step 6: Drop the stale `token_hash` line from `own-projects.routes.test.ts`'s fixture**

In `buildApp()`'s stand-in middleware, change:

```typescript
  app.use('*', async (c, next) => {
    c.set('id_user', 1);
    c.set('token_hash', 'irrelevant');
    c.set('email', AUTH_EMAIL);
    await next();
  });
```

to:

```typescript
  app.use('*', async (c, next) => {
    c.set('id_user', 1);
    c.set('email', AUTH_EMAIL);
    await next();
  });
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS, all files — including `own-projects.routes.test.ts` (~19 cases, unchanged apart from Step 6's one line) and `app.test.ts`.

- [ ] **Step 8: Type-check**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/middlewares/resolve-email.middleware.ts src/middlewares/resolve-email.middleware.test.ts src/app.ts src/routes/own-projects.routes.test.ts
git commit -m "feat: resolve own-projects' email via a dedicated middleware, not the auth token"
```

---

### Task 4: Config

**Files:**
- Modify: `.env.example`
- Modify: `.env` (gitignored — confirm with `git check-ignore .env` before editing if unsure)

**Interfaces:** none — documentation/config only.

- [ ] **Step 1: Update `.env.example`**

Replace the `# Auth Configuration` block:

```
# Auth Configuration
# Access tokens are issued by the separate Comercyo users/auth backend
# (comercyo-back-users). This backend only verifies them - signature,
# expiry, and audience (JWT_AUDIENCE) - it never touches sessions or
# refresh tokens itself.
JWT_SECRET=                  # long random secret, HS256, same value the auth backend signs with
JWT_AUDIENCE=comercyo-internal   # must equal comercyo-back-users' JWT_AUDIENCE
TIENDAS_DB_REF=jzjgdcnlvfosvnjhssiv   # supabase-tiendas project ref - still used for this repo's own business data (own_projects, users.email lookups)
```

- [ ] **Step 2: Update `.env`**

Same edit as Step 1, but keep the existing real values for `JWT_SECRET`/`TIENDAS_DB_REF` — only add `JWT_AUDIENCE=comercyo-internal` and update the comment.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore: add JWT_AUDIENCE, document stateless auth in .env.example"
```

(`.env` is gitignored — nothing to commit there, it's a local-only edit so `npm run dev` keeps working.)
