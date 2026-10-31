# R2 Image Storage CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `own-projects` (Postgres) CRUD with a stateless CRUD (POST/GET/DELETE) for product images backed by Cloudflare R2, and remove all now-unused Postgres infrastructure.

**Architecture:** Hono + `@hono/zod-openapi` keep serving `/api/v1` with the same Bearer-JWT auth and Swagger docs pattern the repo already uses. A new `src/config/r2.ts` wraps an `@aws-sdk/client-s3` `S3Client` pointed at the R2 S3-compatible endpoint. A new `src/utils/image-validation.utils.ts` validates mime type, size and pixel dimensions of an uploaded buffer using `image-size` (header-only parsing, no native deps). `src/routes/images.routes.ts` wires the three endpoints together. R2 is the only source of truth — no database, no metadata table.

**Tech Stack:** Hono, `@hono/zod-openapi`, `@aws-sdk/client-s3`, `image-size` (legacy 1.x line, CJS), `jose` (JWT verification, unchanged), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-r2-image-storage-design.md`

## Global Constraints

- Accepted file types: `image/jpeg`, `image/png` only (covers `.jpg`, `.jpeg`, `.png`).
- Max upload size: 3 MB (`3 * 1024 * 1024` bytes).
- Pixel dimensions: width and height must each be within `[500, 1920]` px inclusive.
- R2 bucket: `bucketcomercyoimages`; all objects live under the fixed prefix `imagesproducts/`.
- Public URL base comes from `R2_PUBLIC_URL` env var (currently `https://pub-c0245257942f4b8da675fcfe22cb9b6c.r2.dev`).
- Every `/images/*` route requires `Authorization: Bearer <JWT>` via the existing `requireAuth()` — no other auth mechanism.
- `/images/*` shares one rate limiter: `windowMs: 60_000, max: 100` (same values `own-projects` used).
- No image metadata is persisted anywhere — R2 is the sole source of truth.
- Response envelope unchanged: `{ success: true, data }` on success, `{ success: false, error, message? }` on failure.
- `image-size` must be pinned to the `1.2.1` ("legacy") line, not `^2.x` — v2 is ESM-only and this repo compiles to CommonJS (`tsconfig.json` → `"module": "CommonJS"`); requiring an ESM-only package would break at runtime.

---

### Task 1: Extract `requiredEnv` into its own module

**Files:**
- Create: `src/utils/env.utils.ts`
- Create: `src/utils/env.utils.test.ts`
- Modify: `src/utils/jwt.utils.ts:2`

**Interfaces:**
- Produces: `requiredEnv(name: string): string` — throws `Error('Missing required environment variable: ' + name)` when the env var is unset or blank; otherwise returns the trimmed value. Consumed by Task 3 (`src/config/r2.ts`) and already by `jwt.utils.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/env.utils.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { requiredEnv } from './env.utils';

describe('requiredEnv', () => {
  afterEach(() => {
    delete process.env.SOME_TEST_VAR;
  });

  it('returns the trimmed value when the variable is set', () => {
    process.env.SOME_TEST_VAR = '  hello  ';
    expect(requiredEnv('SOME_TEST_VAR')).toBe('hello');
  });

  it('throws when the variable is not set', () => {
    delete process.env.SOME_TEST_VAR;
    expect(() => requiredEnv('SOME_TEST_VAR')).toThrow(
      'Missing required environment variable: SOME_TEST_VAR'
    );
  });

  it('throws when the variable is set to an empty/whitespace string', () => {
    process.env.SOME_TEST_VAR = '   ';
    expect(() => requiredEnv('SOME_TEST_VAR')).toThrow(
      'Missing required environment variable: SOME_TEST_VAR'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/env.utils.test.ts`
Expected: FAIL — `Cannot find module './env.utils'`

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/env.utils.ts`:

```ts
export const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/env.utils.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Repoint `jwt.utils.ts` at the new module**

In `src/utils/jwt.utils.ts`, change line 2 from:

```ts
import { requiredEnv } from '../config/db';
```

to:

```ts
import { requiredEnv } from './env.utils';
```

- [ ] **Step 6: Run the full suite to confirm nothing broke**

Run: `npx vitest run`
Expected: PASS — all existing tests (including `jwt.utils.test.ts` and `auth.middleware.test.ts`) still pass. `src/config/db.ts` still has its own internal `requiredEnv` copy at this point — that's fine, it's deleted wholesale in Task 2.

- [ ] **Step 7: Commit**

```bash
git add src/utils/env.utils.ts src/utils/env.utils.test.ts src/utils/jwt.utils.ts
git commit -m "refactor: extract requiredEnv into src/utils/env.utils.ts"
```

---

### Task 2: Remove own-projects and all Postgres infrastructure

**Files:**
- Delete: `src/routes/own-projects.routes.ts`, `src/routes/own-projects.routes.test.ts`
- Delete: `src/config/db.ts`, `src/config/db.test.ts`
- Delete: `src/middlewares/resolve-email.middleware.ts`, `src/middlewares/resolve-email.middleware.test.ts`
- Modify: `src/middlewares/auth.middleware.ts`
- Modify: `src/app.ts`
- Modify: `src/app.test.ts` (full rewrite)
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AuthVariables = { id_user: number }` (trimmed — `email` no longer exists, since nothing sets it anymore). Consumed by Task 5 (`images.routes.ts`) and Task 6 (`app.ts` wiring).

- [ ] **Step 1: Delete the own-projects route and its test**

```bash
git rm src/routes/own-projects.routes.ts src/routes/own-projects.routes.test.ts
```

- [ ] **Step 2: Delete the Postgres config and its test**

```bash
git rm src/config/db.ts src/config/db.test.ts
```

- [ ] **Step 3: Delete the resolveEmail middleware and its test**

```bash
git rm src/middlewares/resolve-email.middleware.ts src/middlewares/resolve-email.middleware.test.ts
```

- [ ] **Step 4: Trim `AuthVariables` in `auth.middleware.ts`**

Replace the full contents of `src/middlewares/auth.middleware.ts` with:

```ts
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
```

(This drops the `email` field and the comment describing `resolveEmail()`, since that middleware no longer exists. `auth.middleware.test.ts` already only asserts on `id_user`, so it needs no changes.)

- [ ] **Step 5: Strip `app.ts` down to a bare skeleton**

Replace the full contents of `src/app.ts` with:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from './middlewares/logger';
import { config } from './config/config';

const app = new Hono();
const apiV1 = new OpenAPIHono({
  defaultHook: (result, c) => {
    if ('error' in result) {
      return c.json(
        { success: false, error: 'Bad Request', message: result.error.issues[0]?.message },
        400
      );
    }
  },
});

// CORS middleware
app.use('*', cors({
  origin: config.cors.origin,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 600,
  // Auth is a Bearer token, not cookies, so no request needs credentials
  // mode - and the fetch spec forbids Access-Control-Allow-Origin: * paired
  // with Access-Control-Allow-Credentials: true for a credentialed request.
  credentials: config.cors.origin !== '*',
}));

// Logger middleware
app.use('*', logger());

// Bearer JWT auth - lets Swagger UI's "Authorize" button attach
// `Authorization: Bearer <token>` to every request, and documents that
// every images operation requires it (see `security` on each route).
apiV1.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// The OpenAPI documentation will be auto-generated by @hono/zod-openapi
apiV1.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Comercyo Images API',
    version: '1.0.0',
    description: 'Almacenamiento temporal de imágenes de producto sobre Cloudflare R2 para comercyo-back-images-stage-1.',
  },
  servers: [
    {
      url: `${config.productionUrl}/api/v1`,
      description: 'Production server',
    },
    {
      url: `http://localhost:${config.port}/api/v1`,
      description: 'Development server',
    },
  ],
});

apiV1.get('/doc', swaggerUI({ url: '/api/v1/openapi.json' }));

app.route('/api/v1', apiV1);

// 404 handler
app.notFound((c) => {
  return c.json({ 
    success: false,
    error: 'Not Found', 
    path: c.req.path 
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ 
    success: false,
    error: 'Internal Server Error', 
    message: err.message 
  }, 500);
});

export default app;
```

(No routes are registered yet — `registerImagesRoutes` and its wiring arrive in Task 6. This is intentionally a transitional state.)

- [ ] **Step 6: Rewrite `app.test.ts` for the bare skeleton**

Replace the full contents of `src/app.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import app from './app';

describe('app wiring', () => {
  it('exposes an OpenAPI document with no routes yet', async () => {
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.info.title).toBe('Comercyo Images API');
    expect(doc.paths).toEqual({});
  });

  it('declares a Bearer security scheme in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(doc.components.securitySchemes.Bearer).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  });

  it('returns 404 with the request path for an unknown route', async () => {
    const res = await app.request('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'Not Found', path: '/api/v1/does-not-exist' });
  });
});
```

(This file is rewritten again in Task 6 once the images routes are wired in — this version only proves the skeleton boots correctly.)

- [ ] **Step 7: Remove the `pg` dependency from `package.json`**

In `package.json`, delete this line from `dependencies`:

```json
    "pg": "^8.16.3",
```

- [ ] **Step 8: Remove the Postgres env var from `.env.example`**

In `.env.example`, delete the last line:

```
TIENDAS_DB_REF=jzjgdcnlvfosvnjhssiv   # supabase-tiendas project ref - still used for this repo's own business data (own_projects, users.email lookups)
```

- [ ] **Step 9: Run the full suite and type-check**

Run: `npx vitest run`
Expected: PASS — no test references `own-projects`, `db.ts`, or `resolveEmail` anymore.

Run: `npm run type-check`
Expected: no errors (confirms nothing still imports the deleted files).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove own-projects CRUD and all Postgres infrastructure"
```

---

### Task 3: Cloudflare R2 client configuration

**Files:**
- Create: `src/config/r2.ts`
- Create: `src/config/r2.test.ts`
- Modify: `package.json` (add `@aws-sdk/client-s3`)
- Modify: `.env.example` (add R2 env vars)

**Interfaces:**
- Consumes: `requiredEnv(name: string): string` from Task 1 (`src/utils/env.utils.ts`).
- Produces (all from `src/config/r2.ts`):
  - `R2_PREFIX: string` — constant, `'imagesproducts/'`.
  - `getR2Client(): S3Client` — memoized singleton.
  - `getR2Bucket(): string`.
  - `toObjectKey(key: string): string` — prepends `R2_PREFIX`.
  - `buildPublicUrl(key: string): string` — `${R2_PUBLIC_URL}/${R2_PREFIX}${key}`.
  - Consumed by Task 5 (`images.routes.ts`).

- [ ] **Step 1: Add the `@aws-sdk/client-s3` dependency**

In `package.json`, add to `dependencies` (alphabetically first, before `@hono/node-server`):

```json
    "@aws-sdk/client-s3": "^3.1128.0",
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `src/config/r2.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getR2Client, getR2Bucket, buildPublicUrl, toObjectKey, R2_PREFIX } from './r2';

describe('r2 config', () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key-id';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'bucketcomercyoimages';
    process.env.R2_PUBLIC_URL = 'https://pub-test.r2.dev';
  });

  it('returns the same S3Client instance on repeated calls', () => {
    const first = getR2Client();
    const second = getR2Client();
    expect(first).toBe(second);
  });

  it('reads the bucket name from R2_BUCKET_NAME', () => {
    expect(getR2Bucket()).toBe('bucketcomercyoimages');
  });

  it('prefixes object keys with imagesproducts/', () => {
    expect(R2_PREFIX).toBe('imagesproducts/');
    expect(toObjectKey('abc.png')).toBe('imagesproducts/abc.png');
  });

  it('builds a public URL under the imagesproducts/ prefix', () => {
    expect(buildPublicUrl('abc.png')).toBe('https://pub-test.r2.dev/imagesproducts/abc.png');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/config/r2.test.ts`
Expected: FAIL — `Cannot find module './r2'`

- [ ] **Step 4: Write minimal implementation**

Create `src/config/r2.ts`:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { requiredEnv } from '../utils/env.utils';

export const R2_PREFIX = 'imagesproducts/';

let client: S3Client | undefined;

export const getR2Client = () => {
  if (client) {
    return client;
  }

  client = new S3Client({
    region: 'auto',
    endpoint: `https://${requiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  return client;
};

export const getR2Bucket = () => requiredEnv('R2_BUCKET_NAME');

export const toObjectKey = (key: string) => `${R2_PREFIX}${key}`;

export const buildPublicUrl = (key: string) => `${requiredEnv('R2_PUBLIC_URL')}/${toObjectKey(key)}`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/config/r2.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Add R2 env vars to `.env.example`**

Append to the end of `.env.example`:

```

# Cloudflare R2 Configuration
# Temporary storage for product images, under the imagesproducts/ prefix.
# Create credentials in the Cloudflare dashboard: R2 > Manage R2 API Tokens
# (permission: Object Read & Write).
R2_ACCOUNT_ID=                     # Cloudflare account id (also part of the S3 endpoint)
R2_ACCESS_KEY_ID=                  # from an R2 API Token
R2_SECRET_ACCESS_KEY=              # from an R2 API Token
R2_BUCKET_NAME=bucketcomercyoimages
R2_PUBLIC_URL=https://pub-c0245257942f4b8da675fcfe22cb9b6c.r2.dev   # bucket's Public Development URL
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/config/r2.ts src/config/r2.test.ts .env.example
git commit -m "feat: add Cloudflare R2 client configuration"
```

---

### Task 4: Image validation utility

**Files:**
- Create: `src/utils/image-validation.utils.ts`
- Create: `src/utils/image-validation.utils.test.ts`
- Modify: `package.json` (add `image-size`)

**Interfaces:**
- Consumes: nothing new.
- Produces (from `src/utils/image-validation.utils.ts`):
  - `MAX_FILE_SIZE_BYTES: number`, `MIN_DIMENSION_PX: number`, `MAX_DIMENSION_PX: number`.
  - `type ImageValidationResult = { ok: true; ext: string; width: number; height: number } | { ok: false; message: string }`.
  - `validateImage(buffer: Buffer, mimeType: string): ImageValidationResult`.
  - `generateImageKey(ext: string): string` — `${randomUUID()}.${ext}`.
  - Consumed by Task 5 (`images.routes.ts`).

- [ ] **Step 1: Add the `image-size` dependency (pinned to the legacy CJS line)**

In `package.json`, add to `dependencies` (alphabetically, between `hono` and `jose`):

```json
    "image-size": "1.2.1",
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `src/utils/image-validation.utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  validateImage,
  generateImageKey,
  MAX_FILE_SIZE_BYTES,
  MIN_DIMENSION_PX,
  MAX_DIMENSION_PX,
} from './image-validation.utils';

function makePngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.writeUInt32BE(13, 8); // IHDR chunk length
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('validateImage', () => {
  it('rejects a mime type that is not image/jpeg or image/png', () => {
    const result = validateImage(Buffer.from('not an image'), 'application/pdf');
    expect(result).toEqual({ ok: false, message: 'Only image/jpeg and image/png files are allowed' });
  });

  it('rejects a file larger than 3MB', () => {
    const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
    const result = validateImage(oversized, 'image/png');
    expect(result.ok).toBe(false);
  });

  it('rejects an image smaller than 500x500', () => {
    const result = validateImage(makePngBuffer(499, 800), 'image/png');
    expect(result).toEqual({
      ok: false,
      message: `Image dimensions must be between ${MIN_DIMENSION_PX}x${MIN_DIMENSION_PX} and ${MAX_DIMENSION_PX}x${MAX_DIMENSION_PX} px`,
    });
  });

  it('rejects an image larger than 1920x1920', () => {
    const result = validateImage(makePngBuffer(800, 1921), 'image/png');
    expect(result.ok).toBe(false);
  });

  it('accepts a valid PNG within the allowed size and dimension range', () => {
    const result = validateImage(makePngBuffer(800, 600), 'image/png');
    expect(result).toEqual({ ok: true, ext: 'png', width: 800, height: 600 });
  });

  it('generates a unique key with the given extension', () => {
    const key1 = generateImageKey('png');
    const key2 = generateImageKey('png');
    expect(key1).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(key1).not.toBe(key2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/utils/image-validation.utils.test.ts`
Expected: FAIL — `Cannot find module './image-validation.utils'`

- [ ] **Step 4: Write minimal implementation**

Create `src/utils/image-validation.utils.ts`:

```ts
import { randomUUID } from 'node:crypto';
import sizeOf from 'image-size';

export const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024;
export const MIN_DIMENSION_PX = 500;
export const MAX_DIMENSION_PX = 1920;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export type ImageValidationResult =
  | { ok: true; ext: string; width: number; height: number }
  | { ok: false; message: string };

export const validateImage = (buffer: Buffer, mimeType: string): ImageValidationResult => {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    return { ok: false, message: 'Only image/jpeg and image/png files are allowed' };
  }

  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return { ok: false, message: `File must be at most ${MAX_FILE_SIZE_BYTES} bytes` };
  }

  let dimensions;
  try {
    dimensions = sizeOf(buffer);
  } catch {
    return { ok: false, message: 'Could not read image dimensions' };
  }

  const { width, height } = dimensions;
  if (!width || !height) {
    return { ok: false, message: 'Could not read image dimensions' };
  }

  if (
    width < MIN_DIMENSION_PX ||
    width > MAX_DIMENSION_PX ||
    height < MIN_DIMENSION_PX ||
    height > MAX_DIMENSION_PX
  ) {
    return {
      ok: false,
      message: `Image dimensions must be between ${MIN_DIMENSION_PX}x${MIN_DIMENSION_PX} and ${MAX_DIMENSION_PX}x${MAX_DIMENSION_PX} px`,
    };
  }

  return { ok: true, ext, width, height };
};

export const generateImageKey = (ext: string) => `${randomUUID()}.${ext}`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/utils/image-validation.utils.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/utils/image-validation.utils.ts src/utils/image-validation.utils.test.ts
git commit -m "feat: add image validation utility (type, size, dimensions)"
```

---

### Task 5: Images routes (POST / GET / DELETE)

**Files:**
- Create: `src/routes/images.routes.ts`
- Create: `src/routes/images.routes.test.ts`

**Interfaces:**
- Consumes:
  - `AuthVariables` from `src/middlewares/auth.middleware.ts` (Task 2).
  - `getR2Client`, `getR2Bucket`, `buildPublicUrl`, `toObjectKey` from `src/config/r2.ts` (Task 3).
  - `validateImage`, `generateImageKey` from `src/utils/image-validation.utils.ts` (Task 4).
- Produces: `registerImagesRoutes(apiV1: OpenAPIHono): void`, registering `POST /images`, `GET /images/{key}`, `DELETE /images/{key}` on the passed instance. Consumed by Task 6 (`app.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/routes/images.routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

const send = vi.fn();
vi.mock('../config/r2', () => ({
  getR2Client: () => ({ send }),
  getR2Bucket: () => 'bucketcomercyoimages',
  buildPublicUrl: (key: string) => `https://pub-test.r2.dev/imagesproducts/${key}`,
  toObjectKey: (key: string) => `imagesproducts/${key}`,
}));

import { registerImagesRoutes } from './images.routes';
import type { AuthVariables } from '../middlewares/auth.middleware';

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  // Stand in for requireAuth(): every request in these tests is already authenticated.
  app.use('*', async (c, next) => {
    c.set('id_user', 1);
    await next();
  });
  registerImagesRoutes(app);
  return app;
}

function makePngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function pngFile(width: number, height: number, name = 'photo.png') {
  return new File([makePngBuffer(width, height)], name, { type: 'image/png' });
}

describe('images routes', () => {
  beforeEach(() => {
    send.mockReset();
  });

  describe('POST /images', () => {
    it('uploads a valid PNG and returns its public URL', async () => {
      send.mockResolvedValueOnce({}); // PutObjectCommand
      const form = new FormData();
      form.append('file', pngFile(800, 600));

      const res = await buildApp().request('/images', { method: 'POST', body: form });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: {
          key: expect.stringMatching(/^[0-9a-f-]{36}\.png$/),
          url: expect.stringContaining('https://pub-test.r2.dev/imagesproducts/'),
          contentType: 'image/png',
          size: 33,
          width: 800,
          height: 600,
        },
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('rejects a request with no file attached', async () => {
      const form = new FormData();
      const res = await buildApp().request('/images', { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('rejects an unsupported file type', async () => {
      const form = new FormData();
      form.append('file', new File([Buffer.from('hello')], 'doc.pdf', { type: 'application/pdf' }));
      const res = await buildApp().request('/images', { method: 'POST', body: form });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toMatch(/image\/jpeg and image\/png/);
    });

    it('rejects an image smaller than 500x500', async () => {
      const form = new FormData();
      form.append('file', pngFile(400, 400));
      const res = await buildApp().request('/images', { method: 'POST', body: form });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /images/{key}', () => {
    it('returns image details when the object exists', async () => {
      send.mockResolvedValueOnce({
        ContentType: 'image/png',
        ContentLength: 1234,
        LastModified: new Date('2026-01-01T00:00:00Z'),
      });

      const res = await buildApp().request('/images/abc.png');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        data: {
          key: 'abc.png',
          url: 'https://pub-test.r2.dev/imagesproducts/abc.png',
          contentType: 'image/png',
          size: 1234,
          lastModified: '2026-01-01T00:00:00.000Z',
        },
      });
    });

    it('returns 404 when the object does not exist', async () => {
      const err = new Error('not found');
      err.name = 'NotFound';
      send.mockRejectedValueOnce(err);

      const res = await buildApp().request('/images/missing.png');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /images/{key}', () => {
    it('deletes an existing object', async () => {
      send.mockResolvedValueOnce({}); // HeadObjectCommand
      send.mockResolvedValueOnce({}); // DeleteObjectCommand

      const res = await buildApp().request('/images/abc.png', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: { key: 'abc.png' } });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('returns 404 when the object does not exist', async () => {
      const err = new Error('not found');
      err.name = 'NotFound';
      send.mockRejectedValueOnce(err);

      const res = await buildApp().request('/images/missing.png', { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/images.routes.test.ts`
Expected: FAIL — `Cannot find module './images.routes'`

- [ ] **Step 3: Write the implementation**

Create `src/routes/images.routes.ts`:

```ts
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { AuthVariables } from '../middlewares/auth.middleware';
import { getR2Client, getR2Bucket, buildPublicUrl, toObjectKey } from '../config/r2';
import { validateImage, generateImageKey } from '../utils/image-validation.utils';

const ErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  message: z.string().optional(),
});

const ImageBaseSchema = z.object({
  key: z.string(),
  url: z.string(),
  contentType: z.string(),
  size: z.number(),
});

const UploadedImageSchema = ImageBaseSchema.extend({
  width: z.number(),
  height: z.number(),
});

const StoredImageSchema = ImageBaseSchema.extend({
  lastModified: z.string(),
});

const UploadResponseSchema = z.object({
  success: z.literal(true),
  data: UploadedImageSchema,
});

const DetailResponseSchema = z.object({
  success: z.literal(true),
  data: StoredImageSchema,
});

const DeleteResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ key: z.string() }),
});

const KeyParamSchema = z.object({
  key: z.string().regex(/^[\w.-]+$/, 'key must contain only letters, numbers, dots, underscores or hyphens'),
});

const UploadBodySchema = z.object({
  file: z.any().openapi({ type: 'string', format: 'binary' }),
});

const badRequest = (c: Context, message: string) =>
  c.json({ success: false, error: 'Bad Request', message }, 400);

const notFound = (c: Context) =>
  c.json({ success: false, error: 'Not Found', message: 'Image not found' }, 404);

const isNotFoundError = (err: unknown) =>
  err instanceof Error && ['NotFound', 'NoSuchKey'].includes(err.name);

export const registerImagesRoutes = (apiV1: any) => {
  const uploadRoute = createRoute({
    method: 'post',
    path: '/images',
    request: {
      body: { content: { 'multipart/form-data': { schema: UploadBodySchema } } },
    },
    responses: {
      201: { description: 'Uploaded', content: { 'application/json': { schema: UploadResponseSchema } } },
      400: { description: 'Bad request', content: { 'application/json': { schema: ErrorSchema } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
    },
    tags: ['Images'],
    security: [{ Bearer: [] }],
  });

  const getRoute = createRoute({
    method: 'get',
    path: '/images/{key}',
    request: { params: KeyParamSchema },
    responses: {
      200: { description: 'Image detail', content: { 'application/json': { schema: DetailResponseSchema } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
    tags: ['Images'],
    security: [{ Bearer: [] }],
  });

  const deleteRoute = createRoute({
    method: 'delete',
    path: '/images/{key}',
    request: { params: KeyParamSchema },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: DeleteResponseSchema } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
    tags: ['Images'],
    security: [{ Bearer: [] }],
  });

  // Caller is responsible for applying requireAuth() to '/images' and
  // '/images/*' before this registration - kept out of this function so
  // route wiring stays testable with a stand-in auth context.
  apiV1.openapi(uploadRoute, async (c: Context<{ Variables: AuthVariables }>) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return badRequest(c, 'file is required');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = validateImage(buffer, file.type);
    if (!result.ok) {
      return badRequest(c, result.message);
    }

    const key = generateImageKey(result.ext);
    const client = getR2Client();
    await client.send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: toObjectKey(key),
        Body: buffer,
        ContentType: file.type,
      })
    );

    return c.json(
      {
        success: true,
        data: {
          key,
          url: buildPublicUrl(key),
          contentType: file.type,
          size: buffer.byteLength,
          width: result.width,
          height: result.height,
        },
      },
      201
    );
  });

  apiV1.openapi(getRoute, async (c: Context<{ Variables: AuthVariables }>) => {
    const key = c.req.param('key');
    const client = getR2Client();
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: getR2Bucket(), Key: toObjectKey(key) })
      );
      return c.json(
        {
          success: true,
          data: {
            key,
            url: buildPublicUrl(key),
            contentType: head.ContentType ?? 'application/octet-stream',
            size: head.ContentLength ?? 0,
            lastModified: (head.LastModified ?? new Date()).toISOString(),
          },
        },
        200
      );
    } catch (err) {
      if (isNotFoundError(err)) {
        return notFound(c);
      }
      throw err;
    }
  });

  apiV1.openapi(deleteRoute, async (c: Context<{ Variables: AuthVariables }>) => {
    const key = c.req.param('key');
    const client = getR2Client();
    try {
      await client.send(new HeadObjectCommand({ Bucket: getR2Bucket(), Key: toObjectKey(key) }));
    } catch (err) {
      if (isNotFoundError(err)) {
        return notFound(c);
      }
      throw err;
    }

    await client.send(new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: toObjectKey(key) }));
    return c.json({ success: true, data: { key } }, 200);
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/routes/images.routes.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/images.routes.ts src/routes/images.routes.test.ts
git commit -m "feat: add images CRUD routes (POST/GET/DELETE) over R2"
```

---

### Task 6: Wire the images routes into `app.ts`

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `registerImagesRoutes` from `src/routes/images.routes.ts` (Task 5), `requireAuth` from `src/middlewares/auth.middleware.ts` (unchanged), `rateLimiter` from `src/middlewares/rate-limit.middleware.ts` (unchanged).
- Produces: the final wired `app` default export.

- [ ] **Step 1: Wire auth, rate limiting, and route registration into `app.ts`**

In `src/app.ts`, add these imports after the existing ones:

```ts
import { requireAuth } from './middlewares/auth.middleware';
import { rateLimiter } from './middlewares/rate-limit.middleware';
import { registerImagesRoutes } from './routes/images.routes';
```

Then, replace this line:

```ts
apiV1.get('/doc', swaggerUI({ url: '/api/v1/openapi.json' }));

app.route('/api/v1', apiV1);
```

with:

```ts
apiV1.get('/doc', swaggerUI({ url: '/api/v1/openapi.json' }));

// Best-effort abuse mitigation ahead of auth - see rate-limit.middleware.ts
// for why this is per-warm-instance rather than a global guarantee.
//
// A single '/images/*' registration is enough - Hono's wildcard pattern
// also matches the bare '/images' path, so a parallel '/images'
// registration alongside it would just run every middleware below twice
// per request to the bare path.
const imagesRateLimiter = rateLimiter({ windowMs: 60_000, max: 100 });
apiV1.use('/images/*', imagesRateLimiter);
apiV1.use('/images/*', requireAuth());
registerImagesRoutes(apiV1);

app.route('/api/v1', apiV1);
```

- [ ] **Step 2: Rewrite `app.test.ts` with full wiring coverage**

Replace the full contents of `src/app.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const send = vi.fn();
vi.mock('./config/r2', () => ({
  getR2Client: () => ({ send }),
  getR2Bucket: () => 'bucketcomercyoimages',
  buildPublicUrl: (key: string) => `https://pub-test.r2.dev/imagesproducts/${key}`,
  toObjectKey: (key: string) => `imagesproducts/${key}`,
}));

import app from './app';

const SECRET = 'test-secret-at-least-32-characters-long';
const AUDIENCE = 'comercyo-internal';

async function signRawToken(payload: Record<string, unknown>, audience?: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp);
  if (audience) builder = builder.setAudience(audience);
  return builder.sign(new TextEncoder().encode(SECRET));
}

function signToken(payload: Record<string, unknown>) {
  return signRawToken(payload, AUDIENCE);
}

describe('app wiring', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.JWT_SECRET = SECRET;
    process.env.JWT_AUDIENCE = AUDIENCE;
  });

  it('exposes the images routes in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.info.title).toBe('Comercyo Images API');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/images', '/images/{key}']));
  });

  it('declares a Bearer security scheme required on every images operation', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(doc.components.securitySchemes.Bearer).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    for (const path of ['/images', '/images/{key}']) {
      for (const operation of Object.values(doc.paths[path]) as any[]) {
        expect(operation.security).toEqual([{ Bearer: [] }]);
      }
    }
  });

  it('rejects unauthenticated requests to POST /images', async () => {
    expect((await app.request('/api/v1/images', { method: 'POST' })).status).toBe(401);
  });

  it('rejects unauthenticated requests to GET /images/:key', async () => {
    expect((await app.request('/api/v1/images/abc.png')).status).toBe(401);
  });

  it('rejects unauthenticated requests to DELETE /images/:key', async () => {
    expect((await app.request('/api/v1/images/abc.png', { method: 'DELETE' })).status).toBe(401);
  });

  it('rate limits /images at 100 requests/minute per IP', async () => {
    const headers = { 'x-forwarded-for': '9.9.9.9' };
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      lastStatus = (await app.request('/api/v1/images/abc.png', { headers })).status;
    }
    expect(lastStatus).toBe(429);

    // A different IP is unaffected by 9.9.9.9's exhausted quota.
    const otherIpRes = await app.request('/api/v1/images/abc.png', { headers: { 'x-forwarded-for': '8.8.8.8' } });
    expect(otherIpRes.status).toBe(401); // past the rate limiter, blocked by auth instead
  });

  it('accepts a real, correctly-audienced token and reaches the route handler', async () => {
    const token = await signToken({ id_user: 7, session_id: 'session-1' });
    send.mockResolvedValueOnce({
      ContentType: 'image/png',
      ContentLength: 42,
      LastModified: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await app.request('/api/v1/images/abc.png', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects a correctly-signed token missing the aud claim (simulating the old token format)', async () => {
    const token = await signRawToken({ id_user: 7, session_id: 'session-1' });
    const res = await app.request('/api/v1/images/abc.png', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 404 with the request path for an unknown route', async () => {
    const res = await app.request('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'Not Found', path: '/api/v1/does-not-exist' });
  });
});
```

- [ ] **Step 3: Run the full suite and type-check**

Run: `npx vitest run`
Expected: PASS — all tests, including the new wiring tests, pass.

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 4: Manual smoke test against real R2 (requires real `.env` credentials)**

Run: `npm run dev`, then in another terminal:

```bash
curl -X POST http://localhost:3001/api/v1/images \
  -H "Authorization: Bearer <a real JWT signed by comercyo-back-users>" \
  -F "file=@/path/to/a/real/photo.jpg"
```

Expected: `201` with a `data.url` pointing at `https://pub-c0245257942f4b8da675fcfe22cb9b6c.r2.dev/imagesproducts/<key>`. Open that URL in a browser to confirm the image is publicly reachable. Then `curl http://localhost:3001/api/v1/images/<key>` (expect `200`) and `curl -X DELETE .../images/<key>` (expect `200`), and re-run the GET to confirm it now returns `404`.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat: wire images routes into app.ts with auth and rate limiting"
```
