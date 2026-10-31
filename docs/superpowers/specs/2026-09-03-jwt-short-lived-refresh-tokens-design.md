# JWT hardening: short-lived access tokens + rotating refresh tokens — design

Status: approved (design phase). Implementation plan not yet written.

**Supersedes**: `2026-08-30-google-auth-flow-design.md`. That spec explicitly
rejected refresh tokens in favor of a 14-day session validated against the DB
on every request. This spec reverses that decision. Reasons the old design
gave (backoffice-style app, users rarely re-login, logout must be immediate)
are addressed differently here — see "Decisions confirmed with the user".

**Cross-repo scope**: this spec covers `comercyo-back-users` (token issuer)
and `comercyo-back-company-projects` (token consumer). It intentionally does
**not** cover the frontend (`comercyopuntocom`) or the Supabase schema
migration itself — those are handed off as separate self-contained prompts
once this spec is implemented, per the user's requested order of work. A
third backend, `comercyo-back-exxample`, was ruled out of scope entirely —
the repo was deleted; it is not part of this system.

This file is duplicated verbatim in both `comercyo-back-users` and
`comercyo-back-company-projects` under the same path, since it governs a
contract shared by both repos and neither is upstream of the other.

## Context

Today, `comercyo-back-users` signs a JWT (HS256, `jose`) with a 14-day
expiry and a minimal payload (`id_user`, `sub`, `session_id`, `iat`, `exp`
— no `aud`). `comercyo-back-company-projects` duplicates the same
verification logic and, on every authenticated request, both backends query
`public.sessions` directly against the same Supabase Postgres instance
(`TIENDAS_DB_REF`) to check `revoked_at`/`expires_at`. This is a direct
shared-database dependency, not a network call between services.

There is no refresh token anywhere in the system. There is no `aud` claim,
so a token signed for this system would also verify successfully against
any other service that happened to share `JWT_SECRET`.

The platform has no active users yet — confirmed with the user. This removes
the need for a zero-downtime, dual-format migration. The two backend repos
can be deployed as a single coordinated change; there's no need to preserve
existing sessions or avoid a mass logout.

## Decisions confirmed with the user

- **Access tokens become stateless in resource servers.** Once this ships,
  `comercyo-back-company-projects` validates a JWT by signature + expiry +
  `aud` only — it no longer queries `sessions` at all. This removes the
  cross-repo shared-DB coupling on the request hot path, which is the actual
  problem behind the old spec's rejection of this pattern, not the 14-day
  session length itself.
- **Access token TTL: 15–30 minutes** (default 20, `ACCESS_TOKEN_TTL_MINUTES`).
  Logout revokes the ability to *refresh*, immediately. The access token
  already issued remains technically valid until its own short expiry — this
  staleness window (≤30 min) is an accepted trade-off, not a bug.
- **Refresh token**: opaque random token (not a JWT — it is always looked up
  in the DB to support revocation and reuse detection, so signing it adds
  nothing), single-use, rotating on every use. Transported as an `httpOnly`,
  `Secure`, `SameSite=None` cookie scoped to `comercyo-back-users`'s own
  origin and `Path=/api/v1/auth` — the frontend's JavaScript never reads it.
  TTL is sliding: `REFRESH_TOKEN_TTL_DAYS` (default 30) from the most recent
  rotation, so an actively-used session never forces re-login, matching the
  old spec's "users rarely want to re-login" intent, while a session idle
  longer than that expires on its own.
- **Reuse detection scope: revoke all sessions of the user.** If a refresh
  token that was already consumed (`used_at IS NOT NULL`) is presented
  again, that's a signal of token theft. Every session belonging to that
  `id_user` is revoked — not just the one token chain — matching standard
  practice (RFC 6819 / Auth0 / Okta).
- **`aud` claim: single shared value** (`JWT_AUDIENCE`, e.g.
  `comercyo-internal`), identical across both repos. No per-service audience
  list — there's no current need to scope a token to a subset of backends.
- **Rollout: single coordinated deploy**, not phased/dual-format. Because
  there are no active users to protect, the additive-claim-then-soft-enforce
  approach considered during design was dropped as unnecessary complexity.
  Deploy order is driven by contract dependency, not by safety: DB schema →
  `comercyo-back-users` → `comercyo-back-company-projects`. Frontend and the
  DB migration are executed from separate prompts, after these two repos are
  done, per the user's requested order of work.

## Architecture

### Access token (JWT, HS256, `jose` — same library, no new dependency)

```json
{
  "id_user": 123,
  "session_id": "<uuid>",
  "aud": "comercyo-internal",
  "iat": 1234567890,
  "exp": 1234569090
}
```

`sub` (the Google subject id) is dropped from this payload — it was carried
in the old JWT but nothing in either repo ever reads it back off the
verified token (`grep` confirms it's write-only today). Keeping it would
force `/auth/refresh` to join `users` on every rotation just to re-sign a
claim nobody consumes, which works against the "no DB coupling on the hot
path" goal. If a future route needs the Google sub, it can read it from
`users` directly by `id_user`, the same way any other profile field is
fetched.

Signed and verified the same way as today (`SignJWT`/`jwtVerify` from
`jose`), with `aud` added to both the signing claims and the verify options
(`jwtVerify(token, key, { audience: JWT_AUDIENCE })`).

### Refresh token (opaque, not a JWT)

`crypto.randomBytes(32).toString('base64url')`. Never returned to any caller
except inside the `Set-Cookie` header. Stored hashed
(`sha256(token).digest('hex')` — same helper already used for the JWT hash
today, `hashToken()`), never in plaintext, in `refresh_tokens.token_hash`.

## Data model

`public.sessions` stops representing a bearer token and starts representing
"one login instance" (one Google sign-in, one device/browser). Its
`token_hash`/`expires_at` columns are dropped — nothing in the new design
hashes an access token or tracks its expiry in the DB.

`public.refresh_tokens` is new — it holds the single-use rotating chain
under a session.

```sql
ALTER TABLE sessions DROP COLUMN token_hash, DROP COLUMN expires_at;
-- id, id_user, created_at, revoked_at, user_agent, ip unchanged

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id),
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens(id)
);
CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id);
```

No migration of existing rows — the platform has no active users, so this
is a destructive DDL change applied directly (same "no migration runner, run
manually against Supabase" convention as `docs/rate-limit-schema.sql`). This
DDL work itself is out of scope for this spec (see "Explicitly out of
scope") — it's handed off as its own prompt.

## Data flow

### `POST /api/v1/auth/google` (public) — `comercyo-back-users`

Unchanged through Google credential verification and the `users` upsert
(steps 1–4 of the old spec). From there:

5. `INSERT INTO sessions (id, id_user, user_agent, ip)` — no `token_hash`/
   `expires_at` anymore.
6. Generate the opaque refresh token; `INSERT INTO refresh_tokens
   (session_id, token_hash, expires_at)` with
   `expires_at = now() + REFRESH_TOKEN_TTL_DAYS days`.
7. Sign the access token: `{ id_user, session_id, aud: JWT_AUDIENCE, iat,
   exp }`, `exp = now() + ACCESS_TOKEN_TTL_MINUTES minutes`.
8. Respond `200 { accessToken, user }` and set the refresh cookie
   (`httpOnly; Secure; SameSite=None; Path=/api/v1/auth; Max-Age=<refresh
   TTL in seconds>`).

### `POST /api/v1/auth/refresh` (new, public — auth is the cookie itself) — `comercyo-back-users`

1. Read the refresh cookie. Missing → `401`.
2. `sha256` it, `SELECT * FROM refresh_tokens WHERE token_hash = $1`.
3. Not found → `401`.
4. Found, `used_at IS NOT NULL` → **reuse detected**: look up the row's
   `session_id` → `id_user`, then `UPDATE sessions SET revoked_at = now()
   WHERE id_user = $1 AND revoked_at IS NULL` (all sessions, not just this
   chain). Clear the refresh cookie. Respond `401`.
5. Found, `used_at IS NULL`, `expires_at < now()` → `401` (ordinary
   expiry — not treated as an attack signal).
6. Found, valid, but its session (`sessions.revoked_at`) is already
   non-null → `401` (session was logged out or revoked by step 4 in a
   parallel request).
7. Otherwise: `UPDATE refresh_tokens SET used_at = now() WHERE id = $1`;
   generate a new opaque token; `INSERT INTO refresh_tokens (session_id,
   token_hash, expires_at)` with a fresh sliding `expires_at`; `UPDATE`
   the old row's `replaced_by` to the new row's id. Sign a new access token
   for the same `session_id`. Set the new refresh cookie. Respond
   `200 { accessToken }`.

All failure branches (2–6) return the same generic `401` shape — same
principle as the old spec: the frontend already treats any `401` as
"give up and log out" once its own retry-after-refresh has failed.

### `POST /api/v1/auth/logout` (private) — `comercyo-back-users`

1. `requireAuth()` (now stateless — see below) resolves `session_id` from
   the JWT.
2. `UPDATE sessions SET revoked_at = now() WHERE id = $1`.
3. Clear the refresh cookie (`Set-Cookie` with `Max-Age=0`).
4. `200`. The access token in hand remains technically valid until its own
   expiry (≤30 min) — accepted trade-off, documented above.

### `GET /api/v1/auth/me` (private) — `comercyo-back-users`

No functional change — it now simply runs behind the stateless
`requireAuth()` instead of the DB-checked one.

### `requireAuth()` — both repos

Both `comercyo-back-users` and `comercyo-back-company-projects` replace
their current `auth.middleware.ts` DB-lookup logic with:

1. Read `Authorization: Bearer <token>`. Missing/malformed → `401`.
2. `jwtVerify(token, secretKey, { audience: JWT_AUDIENCE })`. Any failure
   (bad signature, expired, wrong/missing `aud`) → `401`.
3. `c.set('id_user', payload.id_user)` (and, in `comercyo-back-users`,
   `c.set('session_id', payload.session_id)` — needed by `/auth/logout`).
4. `next()`.

`comercyo-back-company-projects`'s `requireAuth()` **stops** setting
`email` in context — the JWT stays minimal (no email/name/avatar), same
principle the old spec already established for staleness reasons, which
this change doesn't revisit. `email` is still real business data there:
`own-projects.routes.ts` uses it as a query filter (`created_by_email = $1`)
in five handlers, not just for logging, and its existing test suite
(`own-projects.routes.test.ts`, ~19 cases) already stubs `c.set('email', ...)`
directly rather than exercising the real middleware chain. To avoid either
reintroducing a DB call into `requireAuth()` itself (defeating the point of
making token validation stateless) or touching those five handlers and
their well-covered tests, `email` resolution moves into its own small,
separately-named middleware — `resolveEmail()` — chained after
`requireAuth()` on `/own-projects` and `/own-projects/*` only:
`SELECT email FROM users WHERE id_user = $1`, `c.set('email', ...)`. Route
code and its tests are unaffected; only `app.ts`'s middleware chain and a
new middleware file change.

Neither repo touches `sessions`/`refresh_tokens` anywhere anymore. Token
*validity* checking (`requireAuth()`) has zero DB dependency in both repos —
that's the actual goal. `resolveEmail()` is a deliberate, isolated
exception: one query for business data (whose projects these are), not an
auth/session check, and it doesn't touch `sessions` or `refresh_tokens`.

## Error handling

Same `{ success: false, error, message? }` shape as today, extended with
the new endpoint:

| Case | Status |
|---|---|
| `credential` missing/malformed on `/auth/google` | 400 |
| Google rejects the id_token | 401 |
| `Authorization` header missing/malformed on a private route | 401 |
| Access JWT invalid, expired, or wrong/missing `aud` | 401 |
| Refresh cookie missing, unknown, expired, or already-used (reuse) | 401 |
| Session revoked (logout or reuse-triggered revocation) | 401 |
| DB failure | 500 (existing `app.onError`) |

## Configuration

`comercyo-back-users` — new/changed env vars:

```
JWT_AUDIENCE=comercyo-internal        # shared with comercyo-back-company-projects
ACCESS_TOKEN_TTL_MINUTES=20           # 15-30 range
REFRESH_TOKEN_TTL_DAYS=30             # sliding window, renewed on each rotation
```

`SESSION_TTL_DAYS` is removed (no longer meaningful — replaced by the two
vars above).

`comercyo-back-company-projects` — new env var:

```
JWT_AUDIENCE=comercyo-internal        # must equal comercyo-back-users' value
```

`TIENDAS_DB_REF`/`DATABASE_*` remain (this repo still uses the DB for its
own business data — just not for auth).

CORS: `comercyo-back-users` already runs with an explicit `CORS_ORIGIN`
(not `*`) in every environment that matters, so
`credentials: config.cors.origin !== '*'` already evaluates to `true` — no
CORS config change needed, only the stale comment in `app.ts` ("Auth is a
Bearer token, not cookies...") needs updating since it's no longer accurate.
`comercyo-back-company-projects` needs no CORS change — it never receives
or sets the refresh cookie.

## Testing

- Unit (`comercyo-back-users`): `jwt.utils` sign/verify with `aud` and short
  `exp`; refresh-token generation/hashing; the rotation state machine
  (valid → rotate, expired → 401, already-used → 401 + revoke-all).
- Unit (`comercyo-back-company-projects`): `auth.middleware` accepts a
  correctly-audienced token, rejects wrong/missing `aud`, rejects expired —
  no DB mock needed anymore since the path no longer touches the DB.
- Integration (`comercyo-back-users`, against a Supabase branch or local
  DB): full login → refresh → refresh again (rotation) → replay the first
  (now-used) refresh token → confirm `401` and confirm every session for
  that `id_user` is revoked → confirm a previously-valid refresh token for
  a *different* user is unaffected.
- Integration (`comercyo-back-company-projects`): a token issued by
  `comercyo-back-users`' real signing path (or an equivalent test helper
  sharing the same `JWT_SECRET`/`JWT_AUDIENCE`) is accepted; a token missing
  `aud` (simulating the old format) is rejected.

## Explicitly out of scope (handed off separately)

- **Frontend (`comercyopuntocom`)**: the refresh-on-401 interceptor,
  `withCredentials` wiring for the users-service axios clients, and
  `authStore`/`client.ts` changes. Delivered as a separate self-contained
  prompt once these two backends are implemented.
- **Supabase schema migration** (the `ALTER TABLE`/`CREATE TABLE` DDL
  above): delivered as a separate prompt, run manually against
  `TIENDAS_DB_REF`, same convention as `docs/rate-limit-schema.sql`.
- **`comercyo-back-exxample`**: repo was deleted by the user; not part of
  this system.
- Any role/permission data in the JWT — unchanged from the old spec, still
  out of scope.
- Multi-tenant auth — unchanged from the old spec, still explicitly
  rejected.
