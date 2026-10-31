# Diseño: reemplazo de own-projects por CRUD de imágenes sobre Cloudflare R2

## Contexto y objetivo

El backend `comercyo-back-images-stage-1` expone hoy un único recurso, `own-projects`
(CRUD contra Postgres/Supabase). El objetivo de este cambio es reorientar el backend
por completo a su propósito real: servir de paso temporal de almacenamiento de
imágenes de producto en Cloudflare R2. Un cliente sube una imagen, obtiene una URL
pública para usarla en otros procesos, y más adelante la borra. R2 es la única
fuente de verdad — no se guarda metadata de imágenes en base de datos.

Como consecuencia, todo el código de `own-projects` y toda la infraestructura de
Postgres que solo él usaba se elimina del repo.

## Alcance

**Se elimina:**
- `src/routes/own-projects.routes.ts` y `own-projects.routes.test.ts`
- `src/config/db.ts` y `db.test.ts`
- `src/middlewares/resolve-email.middleware.ts` y su test
- El registro de `own-projects` en `src/app.ts` (rutas, su rate limiter dedicado,
  el uso de `resolveEmail()`)
- La dependencia `pg` de `package.json`
- Las variables `TIENDAS_DB_REF`, `DATABASE_BASE`, `DATABASE_PASSWORD`,
  `DATABASE_HOST` de `.env` / `.env.example`

`config/db.ts` exportaba `requiredEnv()`, una utilidad genérica de lectura de env
vars (no específica de DB) que también usa `jwt.utils.ts`. Se traslada a
`src/utils/env.utils.ts` antes de borrar `db.ts`.

**Se mantiene sin cambios:**
- `requireAuth()` (`src/middlewares/auth.middleware.ts`) — verifica el JWT Bearer
  emitido por `comercyo-back-users`. No toca base de datos.
- `rate-limit.middleware.ts`, `logger.ts`.
- El patrón de documentación OpenAPI/Swagger (`apiV1.doc(...)`, `swaggerUI`) en
  `app.ts`, ahora describiendo solo el recurso `images`.

**Se agrega:**
- Cliente S3-compatible para R2 (`@aws-sdk/client-s3`).
- Validación de dimensiones de imagen (`image-size`, lee el header del buffer sin
  decodificar la imagen completa — no requiere binarios nativos, compatible con
  funciones serverless de Vercel).
- Rutas CRUD (POST/GET/DELETE) para el recurso `images`.

## Infraestructura R2 (ya provisionada por el usuario)

- Bucket: `bucketcomercyoimages`
- Prefijo fijo dentro del bucket: `imagesproducts/`
- Account ID: `1ce2908af8e5b27a4aa0f3306213843b`
- Endpoint S3: `https://1ce2908af8e5b27a4aa0f3306213843b.r2.cloudflarestorage.com`
- Public Development URL: `https://pub-c0245257942f4b8da675fcfe22cb9b6c.r2.dev`
  (acceso público de solo lectura ya habilitado sobre todo el bucket)
- Access Key ID / Secret Access Key: generados por el usuario vía "Manage R2 API
  Tokens" con permiso Object Read & Write, se cargan solo en `.env` (nunca en el
  repo ni en este documento).

## Variables de entorno nuevas

```
R2_ACCOUNT_ID=1ce2908af8e5b27a4aa0f3306213843b
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=bucketcomercyoimages
R2_PUBLIC_URL=https://pub-c0245257942f4b8da675fcfe22cb9b6c.r2.dev
```

El prefijo `imagesproducts/` queda fijo en código (`src/config/r2.ts`), ya que es
la única carpeta que se va a usar y no hay necesidad de configurarlo por entorno.

## Componentes nuevos

- **`src/utils/env.utils.ts`** — `requiredEnv(name)`, movido tal cual desde
  `config/db.ts`.
- **`src/config/r2.ts`** — construye y exporta un `S3Client` apuntando al endpoint
  de R2 (`region: 'auto'`, credenciales desde env), y constantes
  `R2_BUCKET`, `R2_PREFIX = 'imagesproducts/'`, `R2_PUBLIC_URL`.
- **`src/utils/image-validation.utils.ts`** — valida mime type, peso y dimensiones
  de un buffer subido; devuelve un resultado tipado (`{ ok: true, width, height,
  ext } | { ok: false, message }`) para que la ruta solo tenga que traducirlo a
  una respuesta 400.
- **`src/routes/images.routes.ts`** — define los 3 `createRoute()` de
  `@hono/zod-openapi` y sus handlers, siguiendo el mismo patrón que
  `own-projects.routes.ts` (`registerImagesRoutes(apiV1)`).

## Contrato de la API

Base: `/api/v1/images`. Todas las rutas requieren `Authorization: Bearer <JWT>`
(mismo mecanismo que protegía `own-projects` hoy) y comparten un rate limiter
dedicado (`windowMs: 60_000, max: 100`, igual que el que tenía `own-projects`).

### `POST /images`

- Request: `multipart/form-data` con un único campo `file`.
- Validación (en este orden, 400 con `message` descriptivo en el primer fallo):
  1. `file` presente y es un archivo.
  2. `type` ∈ `{'image/jpeg', 'image/png'}` (cubre `.jpg`, `.jpeg`, `.png`).
  3. Peso ≤ 3 MB (`3 * 1024 * 1024` bytes).
  4. Ancho y alto, leídos del buffer con `image-size`, ambos dentro de `[500, 1920]`
     px inclusive.
- Al pasar validación: se genera `key = imagesproducts/${randomUUID()}.${ext}`
  (`ext` derivado del mime type validado, nunca del nombre original del archivo)
  y se sube con `PutObjectCommand` (`Bucket`, `Key`, `Body`, `ContentType`).
- Respuesta `201`:
  ```json
  {
    "success": true,
    "data": {
      "key": "<uuid>.<ext>",
      "url": "https://pub-.../imagesproducts/<uuid>.<ext>",
      "contentType": "image/png",
      "size": 123456,
      "width": 800,
      "height": 600
    }
  }
  ```
  `key` en la respuesta es solo el nombre de archivo (sin el prefijo
  `imagesproducts/`), para mantener las URLs de `GET`/`DELETE` simples.
- Errores: `400` (validación), `401` (sin/token inválido), `500` (fallo del SDK
  de R2).

### `GET /images/{key}`

- `key` es el nombre de archivo devuelto por el POST (regex `^[\w.-]+$`).
- `HeadObjectCommand` sobre `imagesproducts/<key>` (no descarga el objeto).
- `404` si R2 responde "not found"; `200` en caso contrario:
  ```json
  {
    "success": true,
    "data": {
      "key": "<uuid>.<ext>",
      "url": "https://pub-.../imagesproducts/<uuid>.<ext>",
      "contentType": "image/png",
      "size": 123456,
      "lastModified": "2026-09-08T12:00:00.000Z"
    }
  }
  ```
- Errores: `401`, `404`, `500`.

### `DELETE /images/{key}`

- `HeadObjectCommand` primero (para devolver `404` real si no existe), luego
  `DeleteObjectCommand`.
- `200`: `{ "success": true, "data": { "key": "<uuid>.<ext>" } }`.
- Errores: `401`, `404`, `500`.

### Esquema de error (sin cambios respecto a `own-projects`)

```json
{ "success": false, "error": "Bad Request", "message": "..." }
```

## Manejo de errores

Cualquier excepción no anticipada del SDK de R2 (red, credenciales inválidas,
etc.) se deja subir al `onError` global ya existente en `app.ts`, que responde
`500` con `{ success: false, error: 'Internal Server Error', message }`. Los
handlers de `images.routes.ts` solo capturan explícitamente el caso "objeto no
encontrado" en `GET`/`DELETE` para traducirlo a `404`.

## Testing

Se sigue el patrón que ya usa `own-projects.routes.test.ts`:
- `vi.mock('../config/r2', ...)` sustituyendo el `S3Client` por un doble con
  `send: vi.fn()`, controlando la respuesta de `PutObjectCommand`,
  `HeadObjectCommand` y `DeleteObjectCommand` (incluyendo el caso de error
  "not found" para 404).
- `buildApp()` con un middleware stand-in de `requireAuth()` (igual que hace el
  test actual con `email`/`id_user`).
- Casos de validación de `POST` probados con buffers de imagen reales (PNG
  mínimo válido generado en el propio test) para cubrir: tipo no permitido, peso
  excedido, dimensiones fuera de rango por abajo y por arriba, y el caso feliz.
- Se elimina `own-projects.routes.test.ts`, `db.test.ts` y el test de
  `resolve-email.middleware.ts` junto con el código que prueban.

## Fuera de alcance

- No se persiste metadata de imágenes en base de datos (R2 es la única fuente de
  verdad, confirmado con el usuario).
- No se implementa listado de imágenes (`GET /images` sin key) — el usuario solo
  necesita detalle por key.
- No se configura un dominio custom para R2 (se usa la Public Development URL).
- No se toca `own-projects` a nivel de datos en Supabase (la tabla en la base de
  datos no se borra desde este repo; solo se deja de usar).
