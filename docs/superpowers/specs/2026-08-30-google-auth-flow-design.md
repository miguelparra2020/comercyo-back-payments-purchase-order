# Google auth flow — design

Status: **superseded** by
`2026-09-03-jwt-short-lived-refresh-tokens-design.md` — the session model
described below (long-lived JWT, DB-checked on every request, no refresh
tokens) was deliberately replaced once the platform needed short-lived
access tokens + rotating refresh tokens. Kept for history.

## Context

`comercyo-back-users` currently has no auth implementation — only a
multi-tenant `tag-modules` CRUD proxy keyed by a `?ref=` query param
(`resolveDb` → `getDb(ref)`).

The frontend (`comercyopuntocom`) already has a working Google sign-in
on the client side:

- `src/core/auth/useGoogleAuth.ts` — uses Google Identity Services
  (via `@react-oauth/google`'s `GoogleOAuthProvider`, `VITE_GOOGLE_CLIENT_ID`)
  to obtain a Google `credential` (id_token JWT), then calls
  `POST /auth/google { credential }` expecting `{ jwt, user }` back.
- `src/core/auth/authStore.ts` — persists only `jwt` to `localStorage`
  (not `user`); `apiPrivate` (axios) attaches
  `Authorization: Bearer <jwt>` to every private request; a `401`
  response triggers automatic logout.
- `src/shared/types/index.ts` — `User = { id: string, email: string,
  name: string, avatar: string }`.

None of this backend piece exists yet. This spec defines it.

The database (`supabase-tiendas`, the single merged Supabase project —
see project memory `project_architecture_tiendas`) already has the
target schema:

- `public.users` — `id_user` (int4, PK, default `nextval(...)`,
  anchor of ~30 FKs across the schema — never replace its type),
  `sub` (text, unique, Google sub), `email`, `email_verified`,
  `name`, `avatar_url`, `last_in`, `is_blocked`, soft-delete columns.
- `public.sessions` — `id` (uuid, PK), `id_user` (FK →
  `users.id_user`), `token_hash` (text, unique), `created_at`,
  `expires_at`, `revoked_at` (nullable), `user_agent`, `ip`.
- `public.user_events` — `id_user`, `id_session`, `event_type`,
  `event_data` (jsonb), `occurred_at`. Not written to by this spec's
  endpoints directly, but the shape exists for future instrumentation.

Access model (from project memory): the frontend never talks to
Supabase's Data API directly. Everything goes through this kind of
backend, which uses the `service_role`/direct Postgres connection.
Authorization logic lives in backend application code, not in
Postgres RLS (`sessions`/`users` have RLS enabled with zero policies
— deny-by-default to `anon`/`authenticated`; this backend connects
directly via `pg` with full DB credentials, bypassing PostgREST
entirely).

## Decisions confirmed with the user

- Auth is **not** multi-tenant: `public.users`/`public.sessions`
  always live in the single `supabase-tiendas` project, regardless of
  any `?ref=` query param used elsewhere in this backend.
- Session revocation is checked **on every private request** (JWT
  signature/expiry check, then a DB lookup by `token_hash`) — not
  stateless-only, not a short-JWT/refresh-token split. Logout must be
  immediate.
- Session lifetime is **long** (14 days chosen, from a 7–30 day
  range) — appropriate for an internal/backoffice-style app where
  users rarely want to re-login.

## Architecture

- **DB access**: add `getUsersDb()` to `src/config/db.ts`. It calls
  the existing `getDb(ref)` with `ref` fixed to `requiredEnv('TIENDAS_DB_REF')`,
  reusing the existing per-ref pool cache. Auth code never reads the
  request's `?ref=` query param.
- **Verifying Google's id_token**: `google-auth-library`'s
  `OAuth2Client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })`.
  Do not hand-roll JWKS fetching or signature verification.
- **Signing the app's own JWT**: `jose`, HS256, one secret
  (`JWT_SECRET`). No asymmetric keys — no third party other than this
  backend ever verifies this JWT.
- **`sessions.token_hash`**: `sha256(hex)` of the full JWT string
  (Node's built-in `crypto`, no new dependency). Not a password, so
  no salt/bcrypt needed — the token itself is high-entropy and signed.

## Data flow

### Login — `POST /api/v1/auth/google` (public)

1. Body: `{ credential: string }`. Missing/malformed → `400`.
2. Verify `credential` with `google-auth-library` against
   `GOOGLE_CLIENT_ID`. Any verification failure (bad signature, wrong
   `aud`/`iss`, expired) → `401`.
3. Extract `sub`, `email`, `email_verified`, `name`, `picture` from
   the verified payload.
4. Upsert `public.users` by `sub` (unique):
   - Not found → `INSERT` (new `id_user` via sequence default).
   - Found → `UPDATE email, email_verified, name, avatar_url,
     last_in = now()`.
5. Sign the app JWT with a **minimal** payload:
   `{ id_user, sub, session_id, iat, exp }`. No email/name/avatar/roles
   in the JWT — those can go stale (profile edits, permission
   changes) without a way to invalidate just the claims.
6. `INSERT INTO public.sessions`: `token_hash` (sha256 of the signed
   JWT), `id_user`, `expires_at = now() + SESSION_TTL_DAYS days`,
   `user_agent` (request header, best-effort), `ip` (first entry of
   `x-forwarded-for`, best-effort).
7. Respond `200`:
   ```json
   { "jwt": "<signed jwt>", "user": { "id": "<id_user as string>", "email": "...", "name": "...", "avatar": "<avatar_url>" } }
   ```
   `user.id` is `String(id_user)` — the internal FK-anchor id — **not**
   Google's `sub`. Every other table in the schema references
   `users.id_user`, so this is what the rest of the system needs the
   frontend to carry, not the Google identifier.

### Authenticated requests — `auth.middleware.ts`

Applied to any route that requires a logged-in user (initially:
`/auth/logout`, `/auth/me`; other backends/routes opt in the same
way going forward).

1. Read `Authorization: Bearer <jwt>`. Missing/malformed → `401`.
2. `jose` verifies signature and expiry. Invalid/expired → `401`.
3. `sha256` the raw JWT string → `SELECT id_user, expires_at,
   revoked_at FROM sessions WHERE token_hash = $1`.
4. No row, or `revoked_at IS NOT NULL`, or `expires_at < now()` →
   `401`.
5. Otherwise: `c.set('id_user', ...)`, `c.set('session_id', ...)`,
   call `next()`.

All failure branches return the same generic `401` shape — the
frontend already treats any `401` as "log the user out"
(`setupUnauthorizedInterceptor`), so there's no reason to distinguish
"bad JWT" from "revoked session" in the response.

### Logout — `POST /api/v1/auth/logout` (private)

- Goes through `auth.middleware.ts` first (so we know which session
  to revoke).
- `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`
  (the current session's hash, derived the same way as the middleware).
- `200`. Frontend clears `localStorage` on receiving success (already
  implemented in `authStore.logout()`).

### Profile rehydration — `GET /api/v1/auth/me` (private)

New endpoint, not currently called by the frontend. Needed because
`authStore` only persists `jwt` to `localStorage`, not `user` — after
a page reload, `isAuthenticated` is `true` (jwt present) but `user`
is `null`. The frontend should call this once at boot when a `jwt`
exists but `user` doesn't, to rehydrate the profile.

- Uses `id_user` from the auth middleware's context.
- `SELECT id_user, email, name, avatar_url FROM users WHERE id_user = $1`.
- Responds with the same `user` shape as the login response.
- **Out of scope for this backend's implementation plan**: the
  frontend change to actually call `/auth/me` on boot. Flagged here
  so the endpoint's contract is deliberate, not accidental.

## Error handling

Consistent `{ success: false, error, message? }` shape, matching the
existing `tag-modules` routes.

| Case | Status |
|---|---|
| `credential` missing/malformed on `/auth/google` | 400 |
| Google rejects the id_token (signature/aud/exp) | 401 |
| `Authorization` header missing/malformed on a private route | 401 |
| JWT invalid or expired | 401 |
| Session not found / revoked / expired in DB | 401 |
| DB failure (upsert, insert session, etc.) | 500 (caught by existing `app.onError`) |

## Configuration

New env vars (add to `.env.example`):

```
GOOGLE_CLIENT_ID=            # must equal the frontend's VITE_GOOGLE_CLIENT_ID (the aud to verify)
JWT_SECRET=                  # long random secret, HS256, different per environment
TIENDAS_DB_REF=jzjgdcnlvfosvnjhssiv   # supabase-tiendas project ref
SESSION_TTL_DAYS=14
```

`DATABASE_BASE` / `DATABASE_PASSWORD` / `DATABASE_HOST` already exist
and are reused by `getUsersDb()`.

## New files

- `src/routes/auth.routes.ts` — `POST /auth/google`, `POST
  /auth/logout`, `GET /auth/me`
- `src/middlewares/auth.middleware.ts` — JWT + DB session validation
- `src/utils/google.utils.ts` — thin wrapper around
  `google-auth-library`'s `verifyIdToken`
- `src/utils/jwt.utils.ts` — sign/verify JWT (`jose`) + sha256 hash
  helper

Modified files:

- `src/config/db.ts` — add `getUsersDb()`
- `src/app.ts` — register `registerAuthRoutes`
- `.env.example` — new vars above
- `package.json` — add `google-auth-library`, `jose`

## Testing

- Unit: `jwt.utils.ts` (sign/verify/hash) and `google.utils.ts`
  (mocking `google-auth-library`) — no real network or DB calls.
- Integration (against a Supabase branch or local DB): happy-path
  login (creates user + session), repeat login for existing `sub`
  (upsert path, no duplicate user), invalid JWT → 401, revoked
  session → 401, expired session → 401, `/auth/me` with and without a
  valid session, logout actually revokes (`revoked_at` set, next
  request with the same JWT gets 401).
- No frontend/browser testing in this repo — it is backend-only.

## Explicitly out of scope

- Refresh tokens / short-lived access tokens (rejected in favor of
  DB-checked-on-every-request revocation with a long session TTL).
- Any role/permission data in the JWT (`roles`, `role_module_permissions`,
  etc. exist in the schema but are not part of this auth flow's scope
  — downstream authorization stays in backend application code per
  the project's access model).
- Frontend changes (calling `/auth/me` on boot, persisting `user` to
  `localStorage`, etc.) — noted above, not part of this backend's
  implementation plan.
- Multi-tenant auth (per-`ref` users/sessions) — explicitly rejected.
