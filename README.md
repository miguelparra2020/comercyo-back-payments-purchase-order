# comercyo-back-payments-purchase-order

API (Hono + Vercel) para el CRUD de las imágenes de los comprobantes de pago de las órdenes de compra.

- Las imágenes se guardan en un bucket **privado** de Cloudflare R2 (`paymentspurchseordes`), bajo `purchase-orders/{orderId}/{key}`.
- Como el bucket es privado, la API nunca devuelve URLs públicas: cada respuesta trae una **URL firmada temporal** (`url`, válida `expiresIn` segundos, 15 min por defecto). Si expira, se pide de nuevo el detalle o el listado.
- Todas las rutas requieren `Authorization: Bearer <JWT>` emitido por `comercyo-back-users`.
- Además, el usuario debe **pertenecer al proyecto de la orden**: se consulta en Postgres `purchase_orders → own_projects.created_by_email → users`. Si la orden no existe, está eliminada o es de un proyecto ajeno, responde **404** (igual en los tres casos, para no revelar órdenes de otros proyectos). Hoy "pertenecer" = ser el creador del proyecto, porque aún no existe una tabla de miembros.

## Endpoints (`/api/v1`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST   | `/purchase-orders/{orderId}/payments`       | Sube un comprobante (`multipart/form-data`, campo `file`) |
| GET    | `/purchase-orders/{orderId}/payments`       | Lista los comprobantes de la orden |
| GET    | `/purchase-orders/{orderId}/payments/{key}` | Detalle de un comprobante |
| PUT    | `/purchase-orders/{orderId}/payments/{key}` | Reemplaza la imagen de un comprobante (mismo `key`) |
| DELETE | `/purchase-orders/{orderId}/payments/{key}` | Elimina un comprobante |

- Formatos: JPEG, PNG o WebP, máximo 10 MB. Sin límite de dimensiones.
- `orderId`: `id_purchase_order` de la orden (entero positivo). `key`: UUID devuelto al subir.
- Documentación interactiva: `/api/v1/doc` (Swagger) y `/api/v1/openapi.json`.

## Desarrollo

```bash
cp .env.example .env   # completar JWT_*, R2_* y DATABASE_*
npm install
npm run dev
npm test
```

En Vercel hay que configurar las mismas variables de entorno (`JWT_SECRET`, `JWT_AUDIENCE`, `TIENDAS_DB_REF`, `DATABASE_BASE`, `DATABASE_PASSWORD`, `DATABASE_HOST`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` y opcionalmente `R2_SIGNED_URL_TTL_SECONDS`).
